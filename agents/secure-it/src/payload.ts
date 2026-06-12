import type { AgentPayloadBase } from "@leanish/runtime";

/**
 * Per-stage payload shapes for secure-it. The discriminator is the
 * runtime's `stage` (init / breakdown / revisit), not a field inside the
 * payload — the handler narrows by `message.stage` and validates the
 * payload at that boundary (see `handler.ts`).
 *
 * Every payload extends `AgentPayloadBase`, so the optional shared
 * `execution` override can ride along on any stage.
 */
export interface InitPayload extends AgentPayloadBase {
  // Scheduler tick — no payload data beyond the optional `execution`
  // override inherited from AgentPayloadBase.
}

export interface BreakdownPayload extends AgentPayloadBase {
  /** catalog project id, e.g. "leanish/widget". */
  readonly projectId: string;
}

export interface RevisitPayload extends AgentPayloadBase {
  /** Repo full name; matches the catalog project id. */
  readonly repo: string;
  /** PR branch name, e.g. "secure-it/dependency-refresh". */
  readonly branch: string;
  /** Stable identifier the PR addresses (the batched pass uses "dependency-refresh"; a GHSA/CVE id otherwise). */
  readonly alertRef: string;
  /** How many revisits this PR already received. Capped at 2 by the handler. */
  readonly revisitCount: number;
}

export type SecureItPayload = InitPayload | BreakdownPayload | RevisitPayload;
