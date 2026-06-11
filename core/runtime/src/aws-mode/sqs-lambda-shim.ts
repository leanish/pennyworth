import { dispatch } from "../dispatch/dispatch.js";
import type { ConsumerRegistry, ConsumerRecord } from "../consumer-registry/store.js";
import { EnvelopeVerificationError } from "../errors.js";
import { envelopeToRuntimeMessage } from "../envelope/to-runtime-message.js";
import { parseEnvelopeShape, verifyEnvelope } from "../envelope/verify.js";
import type { IdempotencyStore } from "../idempotency/store.js";
import type { AgentDefinition } from "../types/agent.js";
import type { AgentDescriptor, ConsumerTrigger } from "../types/descriptor.js";
import type { AgentPayloadBase } from "../types/execution-override.js";
import type { Logger } from "../types/logger.js";
import type { Runtime } from "../types/runtime.js";
import type { RuntimeMessage } from "../types/runtime-message.js";

import { parseSelfRuntimeMessageBody } from "./runtime-message-body.js";
import type {
  SqsBatchResponse,
  SqsEvent,
  SqsRecord,
  SqsRecordOutcome,
} from "./sqs-event.js";

/**
 * AWS-mode Lambda entry shim. Per SQS record, the body is one of two
 * wire shapes:
 *
 *   A. **Consumer envelope** (`type: consumer` trigger) — signed (or, for
 *      local-dev, unsigned) request from a registered consumer:
 *      1. Parse the body as JSON (the signed envelope).
 *      2. Verify the envelope (HMAC + clock-skew + ConsumerRegistry + allowedKinds).
 *      3. Map to `RuntimeMessage` (nested envelope + request layout).
 *
 *   B. **Self / scheduler runtime message** (phase-2, ADR-0011) — a
 *      serialised `RuntimeMessage` published by the agent itself
 *      (`runtime.publish*`, `sourceTrigger: "self"`) or by the
 *      infra-provisioned recurring tick (`sourceTrigger: "scheduler"`).
 *      No envelope verification — the input queue is IAM-private; the shim
 *      validates shape, stage admissibility, and (for `scheduler`) that
 *      the descriptor actually declares a scheduler trigger.
 *
 * Both shapes then share the same tail:
 *      4. Issue the three-state idempotency claim (ADR-0006), keyed by the
 *         SQS `MessageId`.
 *      5. On `claimed` → `dispatch(...)`; success → `complete()` + ACK;
 *         throw → `expire()` + `batchItemFailures`.
 *      6. `duplicate-completed` → skip + warn + ACK.
 *      7. `duplicate-in-flight` → skip + warn + `batchItemFailures`.
 *
 * Rejected bodies (verification failures, inadmissible stage/trigger) →
 * DLQ via SQS's `maxReceiveCount` (reported as `batchItemFailures` so SQS
 * doesn't ACK; agent-infra wires the DLQ).
 *
 * The shim is agent-agnostic — lifecycle events / terminal replies happen
 * inside the handler. The shim's only job is the
 * parse+verify+claim+dispatch+complete dance.
 */
export interface SqsLambdaShimOptions<P extends AgentPayloadBase = AgentPayloadBase> {
  readonly agent: AgentDefinition<P>;
  readonly descriptor: AgentDescriptor;
  readonly runtime: Runtime;
  readonly idempotencyStore: IdempotencyStore;
  /** Required when the consumer trigger declares `signedEnvelope: true`. */
  readonly consumerRegistry?: ConsumerRegistry;
  readonly logger: Logger;
  /** Override for testing; defaults to `() => new Date().toISOString()`. */
  readonly clock?: () => string;
  /** Resolve a `ConsumerRecord` signing key from SSM Parameter Store when needed. */
  readonly resolveSigningKey?: (record: ConsumerRecord) => Promise<Buffer>;
  /** `claimUntil` window in ms. ADR-0006 default: 16 minutes. */
  readonly claimWindowMs?: number;
  /**
   * Trust acknowledgment for agents that combine a `signedEnvelope`
   * consumer trigger WITH unsigned runtime-message traffic (self-published
   * fan-out/revisit or scheduler ticks). Default `false`: such an agent
   * rejects `sourceTrigger: "self" | "scheduler"` bodies, because any
   * principal with SendMessage on the input queue (i.e. its consumers)
   * could otherwise submit a runtime-message-shaped body and bypass HMAC
   * verification. Setting `true` documents that the queue's SendMessage
   * grants are limited to trusted internal principals (record the
   * reasoning in the agent's ASSUMPTIONS/SCOPE doc).
   */
  readonly allowUnsignedRuntimeMessagesWithConsumerTrigger?: boolean;
}

const DEFAULT_CLAIM_WINDOW_MS = 16 * 60 * 1000;

export function createSqsLambdaShim<P extends AgentPayloadBase>(
  options: SqsLambdaShimOptions<P>,
): (event: SqsEvent) => Promise<SqsBatchResponse> {
  const clock = options.clock ?? (() => new Date().toISOString());
  const claimWindowMs = options.claimWindowMs ?? DEFAULT_CLAIM_WINDOW_MS;
  const consumerTrigger = options.descriptor.triggers.find(
    (t): t is ConsumerTrigger => t.type === "consumer",
  );
  const hasSchedulerTrigger = options.descriptor.triggers.some((t) => t.type === "scheduler");
  if (consumerTrigger === undefined && !hasSchedulerTrigger) {
    throw new Error(
      `createSqsLambdaShim: agent '${options.descriptor.identifier}' declares neither a 'consumer' nor a 'scheduler' trigger`,
    );
  }
  if (consumerTrigger?.signedEnvelope === true && options.consumerRegistry === undefined) {
    throw new Error(
      `createSqsLambdaShim: agent '${options.descriptor.identifier}' declares signedEnvelope=true but no ConsumerRegistry was provided`,
    );
  }

  return async function handler(event: SqsEvent): Promise<SqsBatchResponse> {
    const results = await Promise.all(
      event.Records.map((record) =>
        processRecord<P>({
          record,
          options,
          clock,
          claimWindowMs,
          consumerTrigger,
          hasSchedulerTrigger,
        }),
      ),
    );
    const batchItemFailures: Array<{ itemIdentifier: string }> = [];
    for (const r of results) {
      if (isFailureStatus(r.status)) {
        batchItemFailures.push({ itemIdentifier: r.messageId });
      }
    }
    return { batchItemFailures, results };
  };
}

/**
 * Map a per-record status to whether it should appear in `batchItemFailures`.
 * ACK paths: `handled`, `handled-stale-complete` (work succeeded, another
 * worker had reclaimed the row by the time we wrote — the message is done
 * either way), `handled-complete-write-failed` (work + reply succeeded, only
 * the marker write failed — re-running would duplicate side effects), and
 * `duplicate-completed`. Everything else makes SQS keep the message.
 */
function isFailureStatus(status: SqsRecordOutcome["status"]): boolean {
  return (
    status !== "handled" &&
    status !== "handled-stale-complete" &&
    status !== "handled-complete-write-failed" &&
    status !== "duplicate-completed"
  );
}

async function processRecord<P extends AgentPayloadBase>(args: {
  record: SqsRecord;
  options: SqsLambdaShimOptions<P>;
  clock: () => string;
  claimWindowMs: number;
  consumerTrigger: ConsumerTrigger | undefined;
  hasSchedulerTrigger: boolean;
}): Promise<SqsRecordOutcome> {
  const { record, options, clock, claimWindowMs, consumerTrigger, hasSchedulerTrigger } = args;
  const log = options.logger.with({ messageId: record.messageId });

  // 1 — parse body
  let bodyRaw: unknown;
  try {
    bodyRaw = JSON.parse(record.body);
  } catch (err) {
    const error = errorMessage(err);
    log.error("body JSON parse failed", { error });
    return { messageId: record.messageId, status: "envelope-parse-failed", error };
  }

  // 2 — branch on wire shape: self/scheduler runtime message vs consumer envelope.
  const selfBody = parseSelfRuntimeMessageBody(bodyRaw);
  let message: RuntimeMessage<P>;
  if (selfBody !== undefined) {
    if (selfBody.sourceTrigger === "scheduler" && !hasSchedulerTrigger) {
      const error = `scheduler-sourced message but agent '${options.descriptor.identifier}' declares no scheduler trigger`;
      log.warn("runtime-message rejected", { error });
      return { messageId: record.messageId, status: "runtime-message-rejected", error };
    }
    if (
      consumerTrigger?.signedEnvelope === true &&
      options.allowUnsignedRuntimeMessagesWithConsumerTrigger !== true
    ) {
      // Forgery guard: a consumer holding SendMessage on this queue could
      // craft a runtime-message-shaped body (self OR scheduler) to bypass
      // HMAC verification. Mixing signed-envelope consumers with unsigned
      // runtime-message traffic requires the explicit
      // `allowUnsignedRuntimeMessagesWithConsumerTrigger` acknowledgment.
      const error = `${selfBody.sourceTrigger}-sourced message rejected: agent '${options.descriptor.identifier}' has a signedEnvelope consumer trigger and allowUnsignedRuntimeMessagesWithConsumerTrigger is not set`;
      log.warn("runtime-message rejected", { error });
      return { messageId: record.messageId, status: "runtime-message-rejected", error };
    }
    if (!options.descriptor.stages.includes(selfBody.stage)) {
      const error = `stage '${selfBody.stage}' not in declared stages [${options.descriptor.stages.join(", ")}]`;
      log.warn("runtime-message rejected", { error });
      return { messageId: record.messageId, status: "runtime-message-rejected", error };
    }
    // Re-stamp delivery metadata: the SQS MessageId is the idempotency
    // key; the publish-time provenance id stays inside the body only.
    message = {
      stage: selfBody.stage,
      payload: selfBody.payload as unknown as P,
      metadata: {
        receivedAt: clock(),
        sourceTrigger: selfBody.sourceTrigger,
        requestId: record.messageId,
      },
    };
  } else {
    if (consumerTrigger === undefined) {
      const error = `envelope-shaped body but agent '${options.descriptor.identifier}' declares no consumer trigger`;
      log.warn("envelope rejected", { error });
      return { messageId: record.messageId, status: "envelope-rejected", error };
    }
    let verified;
    try {
      if (!consumerTrigger.signedEnvelope) {
        // For unsigned consumer messages (local-dev, etc.) — shape-validate and
        // trust as-is (HMAC + clock-skew skipped; signature optional).
        verified = parseEnvelopeShape(bodyRaw, { requireSignature: false });
      } else {
        verified = await verifyEnvelope({
          envelope: bodyRaw,
          consumerRegistry: options.consumerRegistry!,
          ...(options.resolveSigningKey !== undefined
            ? { resolveSigningKey: options.resolveSigningKey }
            : {}),
        });
      }
    } catch (err) {
      const error = errorMessage(err);
      if (err instanceof EnvelopeVerificationError) {
        log.warn("envelope verification failed", { reason: err.reason, message: err.message });
      } else {
        log.error("envelope verification threw", { error });
      }
      return { messageId: record.messageId, status: "envelope-rejected", error };
    }
    message = envelopeToRuntimeMessage(verified, {
      sqsMessageId: record.messageId,
      receivedAt: clock(),
    }) as unknown as RuntimeMessage<P>;
  }

  // 3 — three-state claim
  const now = clock();
  const claimUntil = new Date(Date.parse(now) + claimWindowMs).toISOString();
  const claimOutcome = await options.idempotencyStore.claim(record.messageId, {
    agent: options.descriptor.identifier,
    now,
    claimUntil,
  });
  if (claimOutcome.status === "duplicate-completed") {
    log.warn("idempotency hit; skipping", {
      status: "completed",
      originalStartedAt: claimOutcome.record.startedAt,
      originalCompletedAt: claimOutcome.record.completedAt,
    });
    return { messageId: record.messageId, status: "duplicate-completed" };
  }
  if (claimOutcome.status === "duplicate-in-flight") {
    log.warn("idempotency hit; skipping", {
      status: "in-flight",
      originalStartedAt: claimOutcome.record.startedAt,
    });
    return { messageId: record.messageId, status: "duplicate-in-flight" };
  }

  // 4 — dispatch (carrying the original claim window for the finalize guard).
  // The dispatch and the completed-marker write are deliberately in SEPARATE
  // try blocks: a handler failure and a finalize-write failure are different
  // outcomes (ADR-0006 § post-handler) and must not be conflated.
  const ownedUntil = claimOutcome.record.claimUntil;
  try {
    await dispatch(
      options.agent,
      options.descriptor,
      options.runtime,
      message as never,
    );
  } catch (err) {
    // The handler itself failed: expire the claim so the next redelivery
    // reclaims and retries on its first try.
    const expireOutcome = await options.idempotencyStore
      .expire(record.messageId, ownedUntil, clock())
      .catch((expireErr: unknown) => {
        // Real AWS-SDK failure (not the freshness guard, which we model as
        // a return value). Don't crash the whole batch on a finalize error
        // — the original `claimUntil` bound still applies and the next
        // visibility cycle reclaims naturally.
        log.warn("idempotency expire() threw; will reclaim on next delivery", {
          error: errorMessage(expireErr),
        });
        return { status: "ok" as const };
      });
    if (expireOutcome.status === "stale") {
      log.warn("idempotency expire() was stale; another worker reclaimed", {
        ownedUntil,
      });
    }
    const error = errorMessage(err);
    log.error("handler threw; idempotency expired for fast retry", { error });
    return { messageId: record.messageId, status: "handler-failed", error };
  }

  // Handler succeeded (for ATC, the terminal reply has already been delivered).
  // Writing the completed marker is best-effort finalisation:
  //   - a `stale` return is a benign race — another worker owns the claim;
  //   - a genuine write THROW must NOT re-run the handler, because the work +
  //     delivery already happened. We ACK + warn instead. The in-flight record
  //     lingers until its `claimUntil` bound, but the SQS message is deleted on
  //     ACK so no redelivery re-runs it (ADR-0006 § complete() write-failure).
  try {
    const finalize = await options.idempotencyStore.complete(
      record.messageId,
      ownedUntil,
      clock(),
    );
    if (finalize.status === "stale") {
      log.warn("idempotency complete() was stale; another worker reclaimed", {
        ownedUntil,
      });
      return { messageId: record.messageId, status: "handled-stale-complete" };
    }
    return { messageId: record.messageId, status: "handled" };
  } catch (completeErr) {
    log.warn(
      "idempotency complete() write failed after a successful handler; ACKing (work already done)",
      { ownedUntil, error: errorMessage(completeErr) },
    );
    return { messageId: record.messageId, status: "handled-complete-write-failed" };
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
