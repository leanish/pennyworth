import type { Runtime } from "@leanish/runtime";

import type { AtcEnvelope } from "./payload.js";
import type { ProjectScope } from "./project-scope.js";

export type AtcErrorKind =
  | "aborted"
  | "timeout"
  | "agent-error"
  | "io-error"
  | "config-error"
  | "validation-error";

export interface AtcTerminalSuccess {
  readonly requestId: string;
  readonly status: "completed";
  readonly result: AtcTerminalResult;
}

export interface AtcTerminalFailure {
  readonly requestId: string;
  readonly status: "failed";
  readonly error: { readonly kind: AtcErrorKind; readonly message: string };
}

export type AtcTerminalReply = AtcTerminalSuccess | AtcTerminalFailure;

/**
 * Completed-status terminal payload. **Every field is required** so the
 * consumer contract is uniform across full and scope-only paths:
 *
 *   - `answer`        — for full runs, the `ask` skill's answer; for
 *                       scope-only diagnostics, the canonical placeholder
 *                       string declared in `SCOPE_ONLY_ANSWER`.
 *   - `projectScope`  — resolved scope (source + projects).
 *   - `syncReport`    — per-project sync outcome; `[]` for scope-only /
 *                       no-projects / no-sync paths.
 *   - `agent`         — coding-agent kind + model, resolved from
 *                       descriptor + per-request override. Always present
 *                       even when no skill ran (scope-only) so downstream
 *                       UI / logging can render uniformly.
 *   - `durationMs`    — handler walltime from `started` to terminal write.
 */
export interface AtcTerminalResult {
  readonly answer: string;
  readonly projectScope: ProjectScope;
  readonly syncReport: ReadonlyArray<{ readonly id: string; readonly outcome: string }>;
  readonly agent: { readonly kind: string; readonly model: string };
  readonly durationMs: number;
}

/**
 * Canonical placeholder `answer` value for scope-only diagnostic replies.
 * Consumers that branch on `answer` can detect this sentinel via
 * `answer === SCOPE_ONLY_ANSWER`; the shape is intentionally human-readable
 * so a missed branch surfaces in UI as a clear message rather than as
 * empty content.
 */
export const SCOPE_ONLY_ANSWER =
  "<scope-only diagnostic: no coding-agent run was performed>";

/**
 * Deliver the terminal reply to `envelope.replyTo` via SQS in AWS mode.
 * Local mode (no envelope.replyTo) writes a warn log and returns the reply
 * from the invocation directly per queue-api.md.
 */
export async function deliverTerminalReply(
  reply: AtcTerminalReply,
  envelope: AtcEnvelope,
  runtime: Runtime,
): Promise<void> {
  if (envelope.replyTo === undefined) {
    runtime.logger.info("terminal reply (no replyTo configured; local-mode return)", {
      requestId: reply.requestId,
      status: reply.status,
    });
    return;
  }
  if (runtime.clients.sqs === undefined) {
    runtime.logger.warn("sqs client unavailable; skipping terminal reply", {
      requestId: reply.requestId,
    });
    return;
  }
  await runtime.clients.sqs.sendMessage({
    queueArn: envelope.replyTo,
    body: JSON.stringify(reply),
  });
}
