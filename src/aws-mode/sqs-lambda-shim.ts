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

import type {
  SqsBatchResponse,
  SqsEvent,
  SqsRecord,
  SqsRecordOutcome,
} from "./sqs-event.js";

/**
 * AWS-mode Lambda entry shim for `type: consumer` triggers. Per SQS record:
 *
 *   1. Parse the body as JSON (the signed envelope).
 *   2. Verify the envelope (HMAC + clock-skew + ConsumerRegistry + allowedKinds).
 *   3. Map to `RuntimeMessage` (nested envelope + request layout).
 *   4. Issue the three-state idempotency claim (ADR-0006).
 *   5. On `claimed` → call `dispatch(agent, descriptor, runtime, message)`.
 *      On success → `complete()` and ACK.
 *      On caught throw → `expire()`, rethrow into `batchItemFailures`.
 *   6. On `duplicate-completed` → skip + warn + ACK.
 *   7. On `duplicate-in-flight` → skip + warn + report to `batchItemFailures`.
 *
 * Envelope-verification failures → DLQ via SQS's `maxReceiveCount` after
 * exhausting retries (we report them as `batchItemFailures` so SQS doesn't
 * ACK the message; agent-infra wires the DLQ).
 *
 * The shim is agent-agnostic — ATC's lifecycle events / terminal reply
 * happen inside the handler. The shim's only job is the
 * verify+claim+dispatch+complete dance.
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
  if (consumerTrigger === undefined) {
    throw new Error(
      `createSqsLambdaShim: agent '${options.descriptor.identifier}' does not declare a 'consumer' trigger`,
    );
  }
  if (consumerTrigger.signedEnvelope && options.consumerRegistry === undefined) {
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
          requireVerification: consumerTrigger.signedEnvelope,
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
 * either way), `duplicate-completed`. Everything else makes SQS keep the
 * message.
 */
function isFailureStatus(status: SqsRecordOutcome["status"]): boolean {
  return (
    status !== "handled" &&
    status !== "handled-stale-complete" &&
    status !== "duplicate-completed"
  );
}

async function processRecord<P extends AgentPayloadBase>(args: {
  record: SqsRecord;
  options: SqsLambdaShimOptions<P>;
  clock: () => string;
  claimWindowMs: number;
  requireVerification: boolean;
}): Promise<SqsRecordOutcome> {
  const { record, options, clock, claimWindowMs, requireVerification } = args;
  const log = options.logger.with({ messageId: record.messageId });

  // 1 — parse body
  let envelopeRaw: unknown;
  try {
    envelopeRaw = JSON.parse(record.body);
  } catch (err) {
    const error = errorMessage(err);
    log.error("envelope JSON parse failed", { error });
    return { messageId: record.messageId, status: "envelope-parse-failed", error };
  }

  // 2 — verify (when signedEnvelope:true)
  let verified;
  try {
    if (!requireVerification) {
      // For unsigned consumer messages (local-dev, etc.) — shape-validate and
      // trust as-is (HMAC + clock-skew skipped; signature optional).
      verified = parseEnvelopeShape(envelopeRaw, { requireSignature: false });
    } else {
      verified = await verifyEnvelope({
        envelope: envelopeRaw,
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

  // 3 — map to RuntimeMessage
  const message = envelopeToRuntimeMessage(verified, {
    sqsMessageId: record.messageId,
    receivedAt: clock(),
  });

  // 4 — three-state claim
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

  // 5 — dispatch (carrying the original claim window for the finalize guard)
  const ownedUntil = claimOutcome.record.claimUntil;
  try {
    await dispatch(
      options.agent,
      options.descriptor,
      options.runtime,
      message as never,
    );
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
  } catch (err) {
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
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
