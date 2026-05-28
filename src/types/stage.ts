/**
 * Canonical lifecycle stages a `RuntimeMessage` can occupy. See ADR-0012.
 *
 * Adding a stage to this list is a runtime-wide change, not a per-agent invention.
 * Per-agent acceptance is declared via `AgentDescriptor.stages`; messages whose
 * stage falls outside that subset are rejected with `UnhandledStageError`.
 */
export const STAGES = ["init", "breakdown", "revisit"] as const;

export type Stage = (typeof STAGES)[number];

export function isStage(value: unknown): value is Stage {
  return typeof value === "string" && (STAGES as readonly string[]).includes(value);
}
