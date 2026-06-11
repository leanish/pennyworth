import type { Runtime } from "@leanish/runtime";

import type { TriageEnvelope } from "./payload.js";

export type TriageErrorKind =
  | "aborted"
  | "timeout"
  | "agent-error"
  | "io-error"
  | "config-error"
  | "validation-error";

/**
 * Whether the diagnosis had code working-copies mounted next to the
 * evidence (`code+evidence`) or ran from the evidence bundle alone
 * (`evidence-only`, when the request carried no `projectIds`).
 */
export type TriageCodeScope = "code+evidence" | "evidence-only";

export interface TriageFinding {
  readonly category: "config" | "code" | "stats" | "other";
  readonly finding: string;
  /** 0..1 — the model's own confidence in the finding. */
  readonly confidence: number;
}

export interface TriagePriorTicket {
  readonly ticketKey: string;
  readonly note: string;
}

export interface TriageTerminalSuccess {
  readonly requestId: string;
  readonly status: "completed";
  readonly result: TriageTerminalResult;
}

export interface TriageTerminalFailure {
  readonly requestId: string;
  readonly status: "failed";
  readonly error: { readonly kind: TriageErrorKind; readonly message: string };
}

export type TriageTerminalReply = TriageTerminalSuccess | TriageTerminalFailure;

/**
 * Completed-status terminal payload. The diagnosis fields come from the
 * `triage` skill's output verbatim; `codeScope` / `agent` / `durationMs`
 * are handler-side context so consumers can render and log uniformly.
 */
export interface TriageTerminalResult {
  readonly diagnosis: string;
  readonly findings: ReadonlyArray<TriageFinding>;
  readonly suggestedNextSteps: ReadonlyArray<string>;
  readonly relevantPriorTickets: ReadonlyArray<TriagePriorTicket>;
  readonly codeScope: TriageCodeScope;
  readonly agent: { readonly kind: string; readonly model: string };
  readonly durationMs: number;
}

/**
 * Deliver the terminal reply to `envelope.replyTo` via SQS in AWS mode.
 * Local mode (no `envelope.replyTo`) logs and returns — the handler's
 * return value is the reply in that mode.
 */
export async function deliverTerminalReply(
  reply: TriageTerminalReply,
  envelope: TriageEnvelope,
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
