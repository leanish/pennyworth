import type { AgentPayloadBase } from "@leanish/agent-runtime";

/**
 * Per-stage payload shapes for secureit. The discriminator is the runtime's
 * `stage` (init / breakdown / revisit), not a field inside the payload.
 *
 * See `../../../specs/agentic-development/agent-runtime/specs/overview.md` §Per-project fan-out pattern
 * and `../../../specs/agentic-development/agent-runtime/specs/skills/secureit-revisit.md`.
 */
export interface SecureitInitPayload extends AgentPayloadBase {
  // Scheduler tick — no payload data needed. Empty so the field exists.
}

export interface SecureitBreakdownPayload extends AgentPayloadBase {
  /** catalogit project id, e.g. "leanish/foo". */
  readonly projectId: string;
}

export interface SecureitRevisitPayload extends AgentPayloadBase {
  /** catalogit project id. */
  readonly repo: string;
  /** PR branch name, e.g. "secureit/GHSA-xxxx-package". */
  readonly branch: string;
  /** Reference back to the alert this PR addresses. */
  readonly alertRef: string;
  /** Bounded by the revisit cap (default 2 — skill-internal constant for now). */
  readonly revisitCount: number;
}

export type SecureitPayload =
  | SecureitInitPayload
  | SecureitBreakdownPayload
  | SecureitRevisitPayload;
