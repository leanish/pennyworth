import type { AgentRunner } from "./agents/runner.js";
import { actorPrompt, reviewerPrompt, synthesisPrompt } from "./prompts/build-prompt.js";
import type { Cli, FinalSummary, Outcome, ParleyStatus, Sessions, Slot, Step, Verdict } from "./types.js";

export interface RelayConfig {
  readonly prompt1: string;
  /** The action for agent 2; `undefined` keeps the whole deliberation read-only. */
  readonly prompt2: string | undefined;
  readonly rounds: number;
  /** Which CLI is agent 1 (the read-only reviewer). Recorded for the result + continuation. */
  readonly first: Cli;
  /** agent 1 = read-only reviewer/planner. */
  readonly agent1: AgentRunner;
  /** agent 2 = actor (when prompt-2 is set) or second reviewer; also runs the closing synthesis. */
  readonly agent2: AgentRunner;
  readonly agent1Resumed: boolean;
  readonly agent2Resumed: boolean;
}

/**
 * Run the interleaved relay (see specs/relay.md). agent 1 (read-only) and agent 2 alternate; agent 2
 * acts on the agreed parts each turn when prompt-2 is set, otherwise both just deliberate. The
 * deliberation settles as soon as the responding agent returns `done` (the opener can't settle) —
 * then agent 2 runs a closing synthesis turn whose output is the deliverable. `needs-user` on any
 * turn escalates; `error` / invocation failure ⇒ `failed`; exhausting `--rounds` ⇒ `exhausted`.
 */
export async function runRelay(cfg: RelayConfig): Promise<Outcome> {
  const steps: Step[] = [];
  let sibling: string | undefined;
  let turn = 0;
  let lastVerdict: Verdict | undefined;

  for (let round = 1; round <= cfg.rounds; round += 1) {
    // --- agent 1 (read-only reviewer) ---
    const p1 = reviewerPrompt({
      prompt1: cfg.prompt1,
      prompt2: cfg.prompt2,
      resumed: cfg.agent1Resumed,
      siblingBody: sibling,
    });
    const r1 = await runTurn(cfg.agent1, p1);
    turn += 1;
    if (r1.error !== undefined) {
      return failed(cfg, round, steps, r1.verdict, r1.error);
    }
    steps.push(toStep(round, "agent-1", cfg.agent1, p1, r1.verdict));
    lastVerdict = r1.verdict;
    if (r1.verdict.status === "error") {
      return failed(cfg, round, steps, r1.verdict, verdictError(r1.verdict));
    }
    // The opening turn (turn 1) has nothing to respond to yet, so it can only continue or fail: a
    // `done` or `needs-user` from the opener is deferred to agent-2, which may resolve the question.
    if (turn > 1) {
      if (r1.verdict.status === "needs-user") {
        return escalated(cfg, round, steps, r1.verdict);
      }
      if (r1.verdict.status === "done") {
        return await settled(cfg, round, steps, r1.verdict);
      }
    }
    sibling = r1.verdict.body;

    // --- agent 2 (actor or second reviewer) ---
    const p2 = actorPrompt({
      prompt1: cfg.prompt1,
      prompt2: cfg.prompt2,
      resumed: cfg.agent2Resumed,
      siblingBody: sibling,
      firstTurn: round === 1,
    });
    const r2 = await runTurn(cfg.agent2, p2);
    turn += 1;
    if (r2.error !== undefined) {
      return failed(cfg, round, steps, r2.verdict, r2.error);
    }
    steps.push(toStep(round, "agent-2", cfg.agent2, p2, r2.verdict));
    lastVerdict = r2.verdict;
    if (r2.verdict.status === "error") {
      return failed(cfg, round, steps, r2.verdict, verdictError(r2.verdict));
    }
    if (r2.verdict.status === "needs-user") {
      return escalated(cfg, round, steps, r2.verdict);
    }
    if (r2.verdict.status === "done") {
      return await settled(cfg, round, steps, r2.verdict);
    }
    sibling = r2.verdict.body;
  }

  return exhausted(cfg, cfg.rounds, steps, lastVerdict);
}

interface TurnResult {
  readonly verdict: Verdict;
  readonly error: string | undefined;
}

async function runTurn(runner: AgentRunner, prompt: string): Promise<TurnResult> {
  try {
    return { verdict: await runner.run(prompt), error: undefined };
  } catch (err) {
    return { verdict: EMPTY_VERDICT, error: errorMessage(err) };
  }
}

const EMPTY_VERDICT: Verdict = { status: "error", summary: "", reason: "", body: "" };

async function settled(
  cfg: RelayConfig,
  round: number,
  steps: Step[],
  closing: Verdict,
): Promise<Outcome> {
  // Closing synthesis on agent 2 — its output is the deliverable.
  const prompt = synthesisPrompt(cfg.prompt2 !== undefined);
  const result = await runTurn(cfg.agent2, prompt);
  if (result.error !== undefined) {
    return failed(cfg, round, steps, result.verdict, result.error);
  }
  steps.push(toStep(round, "agent-2", cfg.agent2, prompt, result.verdict));
  return finish(cfg, "settled", round, steps, {
    summary: result.verdict.summary,
    result: result.verdict.body,
    agreement: closing.summary,
    disagreement: null,
  });
}

function escalated(cfg: RelayConfig, round: number, steps: Step[], v: Verdict): Outcome {
  return finish(cfg, "needs-user", round, steps, {
    summary: v.summary,
    result: v.body,
    agreement: null,
    disagreement: null,
  });
}

function exhausted(cfg: RelayConfig, round: number, steps: Step[], last: Verdict | undefined): Outcome {
  return finish(cfg, "exhausted", round, steps, {
    summary: last?.summary ?? null,
    result: last?.body ?? null,
    agreement: null,
    disagreement: last?.reason ?? null,
  });
}

function failed(
  cfg: RelayConfig,
  round: number,
  steps: Step[],
  v: Verdict,
  error: string,
): Outcome {
  const hasVerdict = v !== EMPTY_VERDICT && v.status !== "error";
  return finish(
    cfg,
    "failed",
    round,
    steps,
    {
      summary: hasVerdict ? v.summary : null,
      result: hasVerdict ? v.body : v.body || null,
      agreement: null,
      disagreement: null,
    },
    error,
  );
}

function toStep(round: number, slot: Slot, runner: AgentRunner, prompt: string, v: Verdict): Step {
  return {
    round,
    slot,
    cli: runner.cli,
    prompt,
    body: v.body,
    status: v.status,
    summary: v.summary,
    reason: v.reason,
    sessionId: runner.sessionId ?? "",
  };
}

function collectSessions(agent1: AgentRunner, agent2: AgentRunner): Sessions {
  let claude: string | undefined;
  let codex: string | undefined;
  for (const runner of [agent1, agent2]) {
    if (runner.sessionId === undefined) {
      continue;
    }
    if (runner.cli === "claude") {
      claude = runner.sessionId;
    } else {
      codex = runner.sessionId;
    }
  }
  return {
    ...(claude !== undefined ? { claude } : {}),
    ...(codex !== undefined ? { codex } : {}),
  };
}

function buildContinuation(cfg: RelayConfig, sessions: Sessions): string | undefined {
  if (sessions.claude === undefined || sessions.codex === undefined) {
    return undefined;
  }
  // --first only needs pinning when it differs from the default (codex); omit it otherwise.
  const firstArg = cfg.first === "claude" ? "--first claude " : "";
  const action = cfg.prompt2 !== undefined ? ' "<your next action>"' : "";
  return `parley ${firstArg}--codex-session ${sessions.codex} --claude-session ${sessions.claude} "<your guidance / next prompt>"${action}`;
}

function finish(
  cfg: RelayConfig,
  status: ParleyStatus,
  roundsExecuted: number,
  steps: readonly Step[],
  final: FinalSummary,
  error?: string,
): Outcome {
  const sessions = collectSessions(cfg.agent1, cfg.agent2);
  const continuation =
    status === "exhausted" || status === "needs-user" ? buildContinuation(cfg, sessions) : undefined;
  return {
    status,
    roundsExecuted,
    maxRounds: cfg.rounds,
    first: cfg.first,
    sessions,
    final,
    steps,
    ...(continuation !== undefined ? { continuation } : {}),
    ...(error !== undefined ? { error } : {}),
  };
}

function verdictError(v: Verdict): string {
  return v.reason || v.summary || "coding agent reported an error verdict";
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
