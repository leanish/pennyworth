import type { Outcome, Step } from "../types.js";

/**
 * The stable `--output` document — a projection of the {@link Outcome} for machine consumers.
 * Deliberately omits `steps` (that is `--steps-output`) and the internal `error` field.
 */
export function renderResultDocument(o: Outcome): string {
  const doc = {
    status: o.status,
    roundsExecuted: o.roundsExecuted,
    maxRounds: o.maxRounds,
    first: o.first,
    sessions: o.sessions,
    final: o.final,
    ...(o.continuation !== undefined ? { continuation: o.continuation } : {}),
  };
  return JSON.stringify(doc, null, 2);
}

/** The `--steps-output` array: one entry per coding-agent turn, in chronological order. */
export function renderSteps(steps: readonly Step[]): string {
  return JSON.stringify(steps, null, 2);
}
