/** The two coding-agent CLIs parley drives. */
export type Cli = "claude" | "codex";

/** The two relay slots. Agent 1 is the read-only reviewer; agent 2 is the actor. */
export type Slot = "agent-1" | "agent-2";

/** The verdict status that drives the relay control flow. */
export type VerdictStatus = "continue" | "done" | "needs-user" | "error";

/** One turn's structured output, enforced by each CLI's native schema flag. */
export interface Verdict {
  readonly status: VerdictStatus;
  readonly summary: string;
  readonly reason: string;
  readonly body: string;
}

/** One coding-agent turn, recorded for `--steps-output`. */
export interface Step {
  readonly round: number;
  readonly slot: Slot;
  readonly cli: Cli;
  readonly prompt: string;
  readonly body: string;
  readonly status: VerdictStatus;
  readonly summary: string;
  readonly reason: string;
  readonly sessionId: string;
}

/** The overall result of a deliberation. */
export type ParleyStatus = "settled" | "exhausted" | "needs-user" | "failed";

/** Resumable session handles, each present only once that slot has run. */
export interface Sessions {
  readonly claude?: string;
  readonly codex?: string;
}

/** The closing summary of a deliberation. `agreement`/`disagreement` are status-specific. */
export interface FinalSummary {
  readonly summary: string | null;
  readonly result: string | null;
  readonly agreement: string | null;
  readonly disagreement: string | null;
}

/**
 * The full outcome of a relay. The `--output` document is a projection of this (without `steps`
 * or `error`); the `--steps-output` array is `steps`; stdout is a human-readable render.
 */
export interface Outcome {
  readonly status: ParleyStatus;
  readonly roundsExecuted: number;
  readonly maxRounds: number;
  readonly first: Cli;
  readonly sessions: Sessions;
  readonly final: FinalSummary;
  readonly continuation?: string;
  /** Failure detail for `failed` outcomes; surfaced on stderr/stdout, never in the JSON document. */
  readonly error?: string;
  readonly steps: readonly Step[];
}
