/**
 * Optional execution overrides that may ride in any agent payload.
 *
 * Every `RuntimeMessage.payload` extends `AgentPayloadBase`. Handlers that
 * want to honour overrides call `runtime.execution.resolve(payload.execution)`
 * and spread the resolved fields into the relevant `runSkill` call. The
 * runtime never auto-applies these values.
 *
 * See ADR-0003 and ADR-0004.
 */
export type Effort = "minimal" | "low" | "medium" | "high" | "xhigh";

export const EFFORTS: readonly Effort[] = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;

export interface ExecutionOverride {
  readonly codingAgent?: string;
  readonly model?: string;
  readonly effort?: Effort;
}

export interface AgentPayloadBase {
  readonly execution?: ExecutionOverride;
}

/**
 * The merged execution settings after `runtime.execution.resolve(...)`.
 * Always has concrete values for `codingAgent` + `model`; `effort` is
 * optional because the descriptor's `effort` field is itself optional.
 */
export interface ResolvedExecution {
  readonly codingAgent: string;
  readonly model: string;
  readonly effort?: Effort;
}
