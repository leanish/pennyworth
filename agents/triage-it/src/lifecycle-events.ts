import type { Runtime } from "@leanish/runtime";

import type { TriageEnvelope } from "./payload.js";
import type { TriageCodeScope, TriageErrorKind } from "./terminal-reply.js";

/**
 * triage-it's outbound lifecycle events on the EventBridge bus. The
 * protocol is deliberately small — one stage, three signals:
 *
 *   - `triage-it.triage.received`  — the handler picked the request up
 *   - `triage-it.triage.completed` — diagnosis produced (terminal reply follows)
 *   - `triage-it.triage.failed`    — terminal failure (kind + message)
 *
 * Every event carries the envelope correlation fields (requestId,
 * consumer, endUser, conversationKey) plus the request's ticketKey so
 * consumers can join events to their tickets without parsing replies.
 *
 * Emission is **best-effort**: the terminal reply is the load-bearing
 * channel, so a dropped lifecycle event must not abort the handler —
 * but failure surfaces at `error` level so IAM / bus misconfiguration is
 * loud enough for alarms. Callers do not wrap each method in try/catch.
 */
export class TriageLifecycleEmitter {
  readonly #runtime: Runtime;
  readonly #envelope: TriageEnvelope;
  readonly #ticketKey: string | undefined;

  constructor(runtime: Runtime, envelope: TriageEnvelope, ticketKey?: string) {
    this.#runtime = runtime;
    this.#envelope = envelope;
    this.#ticketKey = ticketKey;
  }

  async received(): Promise<void> {
    await this.#put("triage-it.triage.received", {});
  }

  async completed(args: {
    readonly codeScope: TriageCodeScope;
    readonly agent: { readonly kind: string; readonly model: string };
    readonly durationMs: number;
  }): Promise<void> {
    await this.#put("triage-it.triage.completed", {
      codeScope: args.codeScope,
      agent: args.agent,
      durationMs: args.durationMs,
    });
  }

  async failed(args: {
    readonly kind: TriageErrorKind;
    readonly message: string;
  }): Promise<void> {
    await this.#put("triage-it.triage.failed", { error: args });
  }

  async #put(detailType: string, fields: Record<string, unknown>): Promise<void> {
    if (this.#runtime.clients.eventbridge === undefined) {
      // Defensive — the descriptor declares `eventbridge`; an undefined
      // client here means deployment wiring is broken.
      this.#runtime.logger.error(
        "eventbridge client unavailable; lifecycle event dropped",
        { detailType },
      );
      return;
    }
    try {
      await this.#runtime.clients.eventbridge.putEvents({
        entries: [
          {
            source: "triage-it",
            detailType,
            detail: {
              requestId: this.#envelope.requestId,
              consumer: this.#envelope.consumer,
              endUser: this.#envelope.endUser,
              ...(this.#envelope.conversationKey !== undefined
                ? { conversationKey: this.#envelope.conversationKey }
                : {}),
              ...(this.#ticketKey !== undefined ? { ticketKey: this.#ticketKey } : {}),
              ...fields,
            },
          },
        ],
      });
    } catch (err) {
      this.#runtime.logger.error("lifecycle event emission failed", {
        detailType,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
