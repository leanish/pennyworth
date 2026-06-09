import type { Cli } from "./types.js";

export interface PlanOptions {
  readonly first: Cli;
  readonly claudeSession: string | undefined;
  readonly codexSession: string | undefined;
}

export interface SlotPlan {
  readonly first: Cli;
  readonly agent1Cli: Cli;
  readonly agent2Cli: Cli;
  readonly agent1Resumed: boolean;
  readonly agent2Resumed: boolean;
}

const other = (cli: Cli): Cli => (cli === "claude" ? "codex" : "claude");

/**
 * Map `--first` + per-CLI session ids onto the two relay slots. Agent 1 (the plan lead) is `first`;
 * agent 2 is the other CLI. A slot is "resumed" when its CLI was given a session id.
 */
export function planSlots(opts: PlanOptions): SlotPlan {
  const agent1Cli = opts.first;
  const agent2Cli = other(opts.first);
  const sessionFor = (cli: Cli): string | undefined =>
    cli === "claude" ? opts.claudeSession : opts.codexSession;
  return {
    first: opts.first,
    agent1Cli,
    agent2Cli,
    agent1Resumed: sessionFor(agent1Cli) !== undefined,
    agent2Resumed: sessionFor(agent2Cli) !== undefined,
  };
}
