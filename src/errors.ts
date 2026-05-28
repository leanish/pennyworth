import type { Stage } from "./types/stage.js";

/**
 * Common base — every runtime-thrown error extends this so callers can
 * branch on `instanceof RuntimeError` without listing each subclass.
 */
export class RuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * Inbound message carried a `stage` that the agent's descriptor doesn't
 * list under `stages:`. The runtime rejects before the handler is called;
 * after SQS max-receive the message lands in the DLQ (ADR-0006 + ADR-0012).
 */
export class UnhandledStageError extends RuntimeError {
  constructor(
    readonly stage: string,
    readonly declaredStages: ReadonlyArray<Stage>,
    readonly agent: string,
  ) {
    super(
      `Agent '${agent}' received stage '${stage}', which is not in its declared stages: [${declaredStages.join(", ")}]`,
    );
  }
}

/**
 * A parsed `agent.yaml` failed validation at startup. Fatal — the agent
 * fails to register and no message is consumed.
 */
export class DescriptorValidationError extends RuntimeError {
  constructor(
    message: string,
    readonly issues: ReadonlyArray<DescriptorIssue>,
  ) {
    super(message);
  }
}

export interface DescriptorIssue {
  /** Dotted path into the descriptor, e.g. "triggers.0.type". */
  readonly path: string;
  /** Short machine-readable category (matches §Validation in descriptor.md). */
  readonly category: DescriptorIssueCategory;
  /** Human-readable explanation. */
  readonly message: string;
}

export type DescriptorIssueCategory =
  | "unknown-field"
  | "missing-required"
  | "invalid-enum"
  | "compute-phase-mismatch"
  | "empty-entrypoints"
  | "empty-stages"
  | "unknown-stage"
  | "unknown-skill"
  | "entrypoint-schema"
  | "incompatible-coding-agent"
  | "unknown-need"
  | "duplicate-need"
  | "unknown-or-out-of-phase-trigger"
  | "invalid-shape";

/**
 * Startup-time failure for an Entry-point Skill with missing or invalid
 * `inputSchema` / `outputSchema` (ADR-0004 §Runtime error classes).
 */
export class EntrypointSchemaError extends RuntimeError {
  constructor(
    readonly entrypoint: string,
    message: string,
  ) {
    super(`Entry-point skill '${entrypoint}' schema invalid: ${message}`);
  }
}

/**
 * A concrete `runSkill(...)` call failed the entrypoint contract. Locked
 * reason set per ADR-0004.
 */
export class EntrypointInvocationError extends RuntimeError {
  constructor(
    readonly reason: EntrypointInvocationReason,
    readonly entrypoint: string,
    message: string,
    readonly schemaErrors?: ReadonlyArray<SchemaErrorItem>,
    readonly captured?: EntrypointInvocationCapture,
  ) {
    super(message);
  }
}

export type EntrypointInvocationReason =
  | "entrypoint-not-declared"
  | "input-validation-fail"
  | "missing-terminal-json-block"
  | "trailing-content-after-final-json"
  | "json-parse-fail"
  | "output-validation-fail";

export interface SchemaErrorItem {
  readonly pointer: string;
  readonly keyword: string;
  readonly message: string;
}

export interface EntrypointInvocationCapture {
  readonly jsonBlock?: string;
  readonly trailingContent?: string;
  readonly stdoutTail?: string;
  readonly stderrTail?: string;
}

/**
 * `runtime.execution.resolve(...)` rejected an explicit override.
 */
export class ExecutionResolveError extends RuntimeError {
  constructor(
    readonly reason: "unknown-coding-agent" | "incompatible-coding-agent" | "invalid-effort",
    message: string,
  ) {
    super(message);
  }
}

/**
 * Inbound envelope failed verification on a `signedEnvelope: true` trigger.
 *
 * The `reason` is load-bearing — observability and DLQ tooling branch on
 * it. Adding a new reason is additive; removing or renaming one is a
 * breaking change.
 */
export type EnvelopeVerificationReason =
  | "unknown-consumer" // no `ConsumerRecord` for `envelope.consumer`
  | "kind-not-allowed" // record exists but `envelope.kind` is not in `record.allowedKinds`
  | "bad-signature" // HMAC mismatch
  | "malformed-envelope" // shape failures (missing/invalid fields, non-object payload)
  | "timestamp-outside-skew" // envelope.timestamp is outside the allowed clock-skew window
  | "signing-key-unavailable"; // record uses `ssm-parameter` but no resolver was wired (or the SSM fetch failed)

export class EnvelopeVerificationError extends RuntimeError {
  constructor(
    readonly reason: EnvelopeVerificationReason,
    message: string,
  ) {
    super(message);
  }
}

/**
 * A handler reached for `runtime.clients.<name>` for a need that wasn't
 * declared in `agent.yaml`. Per ADR-0010 the access fails fast.
 */
export class MissingNeedError extends RuntimeError {
  constructor(readonly need: string) {
    super(
      `runtime.clients.${need} is not available — '${need}' is not in this agent's declared needs:`,
    );
  }
}

/**
 * The agent called a phase-2+ helper (`runtime.publish` / `publishDelayed`)
 * but the running implementation only ships the phase-1 surface.
 */
export class PhaseUnavailableError extends RuntimeError {
  constructor(readonly feature: string) {
    super(`'${feature}' is a phase-2+ runtime helper and is not available in this build`);
  }
}

/**
 * `runtime.routeProjects(...)` was called but no router was wired into
 * `buildRuntime(...)`. This is a deploy-time misconfiguration, not a
 * runtime-data error — handlers should map this to `config-error` (not
 * fall back silently to "use the whole catalog", which would mask the
 * missing wiring).
 */
export class RouterNotConfiguredError extends RuntimeError {
  constructor() {
    super(
      "runtime.routeProjects is not configured — no router was wired into buildRuntime()",
    );
  }
}
