import type { Runtime } from "@leanish/runtime";

import type { AtcEnvelope } from "./payload.js";
import type { ProjectScope } from "./project-scope.js";

/**
 * Thrown when the same `AskStage` is emitted twice in one request. This
 * is a programming error in ATC's handler code — emitting (say)
 * `project-resolution entered` twice — and we surface it instead of
 * suppressing so the handler's outer try/catch can map it to a typed
 * terminal failure. The previous "warn + suppress" path hid these
 * errors in production.
 */
export class LifecycleProgrammingError extends Error {
  constructor(
    message: string,
    readonly stage: string,
  ) {
    super(message);
    this.name = "LifecycleProgrammingError";
  }
}

/**
 * ATC's outbound lifecycle events on the shared agent EventBridge bus
 * (`EVENT_BUS_NAME`). Per `queue-api.md` §EventBridge events.
 *
 * The runtime emits no ATC events; ATC's handler is responsible for the
 * ordered protocol below.
 */
export type AskStage = "project-resolution" | "working-copy-sync" | "coding-agent-execution";
export type AskStageState = "entered" | "skipped";
export type AskStageSkipReason = "scope-only" | "no-projects" | "no-sync";

export class LifecycleEmitter {
  readonly #runtime: Runtime;
  readonly #envelope: AtcEnvelope;
  readonly #emitted = new Set<AskStage>();

  constructor(runtime: Runtime, envelope: AtcEnvelope) {
    this.#runtime = runtime;
    this.#envelope = envelope;
  }

  async started(): Promise<void> {
    await this.#put("ask-the-code.ask.started", {});
  }

  async stage(name: AskStage, state: AskStageState, reason?: AskStageSkipReason): Promise<void> {
    if (this.#emitted.has(name)) {
      // Same-stage re-emission is a programming error. We throw a typed
      // `LifecycleProgrammingError` rather than warn-and-suppress; the
      // handler's outer try/catch maps it to a typed terminal failure
      // and the bug surfaces in tests + production logs at error level
      // rather than hiding behind a warn nobody reads.
      throw new LifecycleProgrammingError(
        `duplicate emission of stage '${name}' (requested state='${state}'${
          reason !== undefined ? `, reason='${reason}'` : ""
        }); each stage may be emitted at most once per request`,
        name,
      );
    }
    this.#emitted.add(name);
    const detail: Record<string, unknown> = { stage: name, state };
    if (state === "skipped" && reason !== undefined) {
      detail["reason"] = reason;
    }
    await this.#put("ask-the-code.ask.status", detail);
  }

  async completed(args: {
    readonly projectScope: ProjectScope;
    readonly syncReport: ReadonlyArray<{ readonly id: string; readonly outcome: string }>;
    readonly agent: { readonly kind: string; readonly model: string };
    readonly durationMs: number;
  }): Promise<void> {
    await this.#put("ask-the-code.ask.completed", {
      projectScope: args.projectScope,
      syncReport: args.syncReport,
      agent: args.agent,
      durationMs: args.durationMs,
    });
  }

  async failed(args: {
    readonly kind: "aborted" | "timeout" | "agent-error" | "io-error" | "config-error" | "validation-error";
    readonly message: string;
  }): Promise<void> {
    await this.#put("ask-the-code.ask.failed", { error: args });
  }

  /**
   * `putEvents` may fail (EventBridge transient, IAM denial, missing bus,
   * etc.). Lifecycle emission is **best-effort** — the terminal reply is
   * the load-bearing delivery channel, so a single dropped lifecycle
   * event must not abort the handler — but failure surfaces at
   * **`error`** level (not warn) so IAM/bus misconfiguration is loud
   * enough that CloudWatch alarms catch it. Callers do not wrap each
   * method in try/catch.
   */
  async #put(detailType: string, fields: Record<string, unknown>): Promise<void> {
    if (this.#runtime.clients.eventbridge === undefined) {
      // Defensive — descriptor declared `eventbridge` but wiring failed.
      // Error-level: a Layer-3 agent declaring `eventbridge` but receiving
      // an undefined client means deployment is broken.
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
            source: "ask-the-code",
            detailType,
            detail: {
              requestId: this.#envelope.requestId,
              consumer: this.#envelope.consumer,
              endUser: this.#envelope.endUser,
              ...(this.#envelope.conversationKey !== undefined
                ? { conversationKey: this.#envelope.conversationKey }
                : {}),
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
