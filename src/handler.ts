import {
  EntrypointInvocationError,
  ExecutionResolveError,
  RouterNotConfiguredError,
} from "@leanish/agent-runtime";

import { LifecycleProgrammingError } from "./lifecycle-events.js";
import type {
  Runtime,
  RuntimeMessage,
  SyncReportEntry,
  WorkingCopy,
} from "@leanish/agent-runtime";

import { materializeAttachments } from "./attachments.js";
import type { MaterializeResult, MaterializedAttachment, MaterializedTurn } from "./attachments.js";
import { LifecycleEmitter } from "./lifecycle-events.js";
import type { AtcPayload, AtcEnvelope } from "./payload.js";
import { resolveProjectScope, type ProjectScope } from "./project-scope.js";
import { parseAtcRequest, AtcValidationError } from "./request-schema.js";
import {
  deliverTerminalReply,
  type AtcErrorKind,
  type AtcTerminalFailure,
  type AtcTerminalReply,
  type AtcTerminalResult,
  SCOPE_ONLY_ANSWER,
} from "./terminal-reply.js";

interface AskSkillInput {
  readonly question: string;
  readonly audience: "general" | "codebase";
  readonly projectScope: ProjectScope;
  readonly transcript?: ReadonlyArray<MaterializedTurn>;
  readonly attachments?: ReadonlyArray<MaterializedAttachment>;
}

interface AskSkillOutput {
  readonly answer: string;
}

/**
 * The 6-step transformation from `payload.request` (consumer-request shape)
 * to the `ask` skill's input + the surrounding lifecycle / delivery logic.
 * Matches `../../../specs/agentic-development/agent-atc/specs/queue-api.md` §Handler transformation.
 *
 * Ordering (every *work* fail-path emits `atc.ask.failed`, never a partial
 * protocol; the one exception is a terminal-reply *delivery* failure after
 * `completed` has already fired — that propagates for SQS retry rather than
 * emitting `failed`, since the work succeeded and the reply is at-least-once):
 *
 *   1. `started`
 *   2. Parse + validate consumer request                  (validation-error)
 *   3. Resolve execution overrides                        (validation-error)
 *   4. Emit `project-resolution entered`
 *   5. Resolve scope (validates explicit projectIds)      (validation-error / config-error / io-error)
 *   6. Branch:
 *      - `scopeOnly`: emit `working-copy-sync skipped` +
 *        `coding-agent-execution skipped`, return complete diagnostic reply
 *      - else: materialise attachments → sync → runSkill → return reply
 *
 * Execution is resolved BEFORE any lifecycle stage emission so a throw
 * there can't leave the protocol half-emitted. Project-resolution is
 * emitted BEFORE scope resolution begins (matches spec).
 *
 * Lifecycle emission is best-effort and handled inside `LifecycleEmitter`
 * (error-level on failure; never aborts the handler). The handler does
 * NOT wrap each emit in try/catch.
 *
 * **Returns the terminal reply.** AWS mode delivers it via SQS to
 * `envelope.replyTo` AND returns it; the AWS-mode shim discards the
 * return value (Lambda only reads `batchItemFailures`). Local mode does
 * not have a `replyTo` queue; `run-local` propagates the returned reply
 * as its Promise resolution. The contract is the same in both modes —
 * the handler always builds a single terminal reply.
 */
export async function handleAtcMessage(
  message: RuntimeMessage<AtcPayload>,
  runtime: Runtime,
): Promise<AtcTerminalReply> {
  const envelope = message.payload.envelope;
  const lifecycle = new LifecycleEmitter(runtime, envelope);
  const startedAt = Date.now();

  await lifecycle.started();

  // 1 — validate consumer-request shape
  let request;
  try {
    request = parseAtcRequest(message.payload.request);
  } catch (err) {
    return failTerminal(runtime, envelope, lifecycle, mapErrorKind(err), err);
  }

  // 2 — resolve execution overrides BEFORE emitting any per-stage status.
  // If the override is malformed, we fail with validation-error after
  // `started` but before any `status` events. That keeps the protocol
  // sequence well-formed on every fail path.
  let execution;
  try {
    execution = runtime.execution.resolve(request.execution);
  } catch (err) {
    return failTerminal(runtime, envelope, lifecycle, mapErrorKind(err), err);
  }
  const agentField = { kind: execution.codingAgent, model: execution.model };

  // 3 — emit project-resolution entered (before resolveProjectScope runs)
  await lifecycle.stage("project-resolution", "entered");

  // 4 — resolve scope. Three failure modes:
  //   - unknown projectIds      → AtcValidationError  → validation-error
  //   - router not configured   → RouterNotConfiguredError → config-error
  //   - other I/O               → io-error
  let resolved;
  try {
    resolved = await resolveProjectScope(request, runtime);
  } catch (err) {
    return failTerminal(runtime, envelope, lifecycle, mapErrorKind(err), err);
  }

  // scope-only path: emit the two stage-skipped statuses, build a
  // complete-shape diagnostic reply, return.
  if (request.scopeOnly === true) {
    await lifecycle.stage("working-copy-sync", "skipped", "scope-only");
    await lifecycle.stage("coding-agent-execution", "skipped", "scope-only");
    const replyResult: AtcTerminalResult = {
      answer: SCOPE_ONLY_ANSWER,
      projectScope: resolved.scope,
      syncReport: [],
      agent: agentField,
      durationMs: Date.now() - startedAt,
    };
    const reply: AtcTerminalReply = {
      requestId: envelope.requestId,
      status: "completed",
      result: replyResult,
    };
    await lifecycle.completed({
      projectScope: replyResult.projectScope,
      syncReport: replyResult.syncReport,
      agent: replyResult.agent,
      durationMs: replyResult.durationMs,
    });
    await deliverTerminalReply(reply, envelope, runtime);
    return reply;
  }

  // Full path. 5 — materialise attachments. Materialization is its own
  // try/catch; on success we hold a definite `MaterializeResult` for the
  // rest of the function. The static narrowing only widens to
  // `MaterializeResult` (not `MaterializeResult | undefined`) because
  // the catch arm returns.
  let materialized: MaterializeResult;
  try {
    materialized = await materializeAttachments(request, runtime, envelope.requestId);
  } catch (err) {
    return failTerminal(runtime, envelope, lifecycle, "io-error", err);
  }

  // 6 — sync (or skip), run the skill, build the terminal reply, emit
  // `completed`. A failure in any of this is a genuine work failure →
  // failTerminal. Delivery is moved OUTSIDE this try (below) so a delivery
  // failure can't be converted into a `failed` reply after `completed`.
  let reply: AtcTerminalReply;
  try {
    let workingCopies: ReadonlyArray<WorkingCopy> = [];
    // Terminal-reply `syncReport` shape (`outcome` is a string superset of
    // the runtime's `SyncOutcome`, with `"skipped"` for noSync paths).
    let syncReportEntries: ReadonlyArray<{ readonly id: string; readonly outcome: string }> = [];
    if (request.noSync === true) {
      await lifecycle.stage("working-copy-sync", "skipped", "no-sync");
      // Surface one entry per resolved project with outcome `"skipped"`
      // so consumers can distinguish an intentional `noSync` skip from
      // the `no-projects` path (which stays empty). This preserves the
      // consumer's view of what was deliberately not synced.
      syncReportEntries = resolved.projects.map((p) => ({
        id: p.id,
        outcome: "skipped",
      }));
    } else if (resolved.projects.length === 0) {
      await lifecycle.stage("working-copy-sync", "skipped", "no-projects");
    } else {
      await lifecycle.stage("working-copy-sync", "entered");
      const sync = await runtime.syncWorkingCopies(resolved.projects);
      workingCopies = sync.workingCopies;
      syncReportEntries = sync.report.map((s: SyncReportEntry) => ({
        id: s.projectId,
        outcome: s.outcome,
      }));
    }

    // 7 — build skill input + run
    await lifecycle.stage("coding-agent-execution", "entered");
    const askInput: AskSkillInput = {
      question: request.question,
      audience: request.audience ?? "general",
      projectScope: resolved.scope,
      ...(materialized.transcript !== undefined ? { transcript: materialized.transcript } : {}),
      ...(materialized.attachments !== undefined ? { attachments: materialized.attachments } : {}),
    };
    const skillResult = await runtime.runSkill<AskSkillInput, AskSkillOutput>({
      entrypoint: "ask",
      input: askInput,
      workingCopies,
      ...execution,
    });

    const durationMs = Date.now() - startedAt;
    const replyResult: AtcTerminalResult = {
      answer: skillResult.answer,
      projectScope: resolved.scope,
      syncReport: syncReportEntries,
      agent: agentField,
      durationMs,
    };
    reply = {
      requestId: envelope.requestId,
      status: "completed",
      result: replyResult,
    };
    await lifecycle.completed({
      projectScope: replyResult.projectScope,
      syncReport: replyResult.syncReport,
      agent: replyResult.agent,
      durationMs,
    });
  } catch (err) {
    return failTerminal(runtime, envelope, lifecycle, mapErrorKind(err), err);
  } finally {
    await materialized.cleanup().catch((err) => {
      runtime.logger.warn("attachment cleanup failed", { error: errorMessage(err) });
    });
  }

  // Work succeeded and `completed` is emitted. Deliver the terminal reply here,
  // OUTSIDE the work try: the SQS reply is the load-bearing channel, so a
  // delivery failure must NOT be converted into a `failed` reply (it would
  // contradict the already-emitted `completed`). Letting it propagate makes the
  // shim report a batchItemFailure → SQS redelivers → at-least-once delivery
  // (consumers dedupe on requestId per ADR-0006). See queue-api.md §Delivery.
  await deliverTerminalReply(reply, envelope, runtime);
  return reply;
}

async function failTerminal(
  runtime: Runtime,
  envelope: AtcEnvelope,
  lifecycle: LifecycleEmitter,
  kind: AtcErrorKind,
  err: unknown,
): Promise<AtcTerminalFailure> {
  const message = errorMessage(err);
  await lifecycle.failed({ kind, message });
  const reply: AtcTerminalFailure = {
    requestId: envelope.requestId,
    status: "failed",
    error: { kind, message },
  };
  try {
    await deliverTerminalReply(reply, envelope, runtime);
  } catch (deliveryErr) {
    runtime.logger.error("terminal reply delivery failed", {
      error: errorMessage(deliveryErr),
    });
  }
  return reply;
}

function mapErrorKind(err: unknown): AtcErrorKind {
  if (err instanceof AtcValidationError) return "validation-error";
  if (err instanceof RouterNotConfiguredError) return "config-error";
  if (err instanceof EntrypointInvocationError) {
    if (err.reason === "input-validation-fail") return "config-error";
    return "agent-error";
  }
  if (err instanceof ExecutionResolveError) return "validation-error";
  // Duplicate lifecycle-stage emission is a programmer / deployment bug
  // in ATC's handler code, not an I/O failure. `config-error` is the
  // honest kind — consumers / operators triage it the same way as a
  // descriptor / deployment misconfiguration.
  if (err instanceof LifecycleProgrammingError) return "config-error";
  return "io-error";
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
