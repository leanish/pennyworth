import type { Cli, Verdict } from "../types.js";

/**
 * One side of a deliberation. parley drives two of these in a fixed relay order.
 *
 * `sessionId` is known up-front for Claude (a self-assigned UUID) and becomes known for Codex once
 * its first run captures the thread id. `run` resolves with the structured verdict, or rejects on
 * an unrecoverable invocation failure (which the orchestrator turns into a `failed` outcome).
 */
export interface AgentRunner {
  readonly cli: Cli;
  readonly sessionId: string | undefined;
  run(prompt: string): Promise<Verdict>;
}
