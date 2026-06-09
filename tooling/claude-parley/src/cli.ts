import { writeFileSync } from "node:fs";

import { Command, CommanderError } from "commander";

import { ClaudeRunner } from "./agents/claude-runner.js";
import { CodexRunner } from "./agents/codex-runner.js";
import type { AgentRunner } from "./agents/runner.js";
import { renderResultDocument, renderSteps } from "./output/json.js";
import { renderText } from "./output/text.js";
import { runRelay } from "./parley.js";
import { planSlots } from "./plan.js";
import type { Cli, ParleyStatus } from "./types.js";

const EXIT_CODE: Record<ParleyStatus, number> = {
  settled: 0,
  exhausted: 2,
  "needs-user": 3,
  failed: 4,
};
const USAGE_EXIT = 1;

interface RawOptions {
  readonly rounds: string;
  readonly first: string;
  readonly claudeSession?: string;
  readonly codexSession?: string;
  readonly output?: string;
  readonly stepsOutput?: string;
  readonly verbose: boolean;
}

function buildProgram(): Command {
  return new Command()
    .name("parley")
    .description("Bounded relay deliberation between two coding agents (Codex reviews, Claude acts by default).")
    .argument("<prompt-1>", "the task/subject the deliberation is about (handed to the read-only reviewer)")
    .argument("[prompt-2]", "the action the actor takes on the reviewer's output; omit for a read-only deliberation")
    .option("--rounds <n>", "maximum rounds (one reviewer+actor pair each)", "5")
    .option("--first <cli>", "which CLI is the read-only reviewer: codex | claude", "codex")
    .option("--claude-session <id>", "resume Claude from this session id")
    .option("--codex-session <id>", "resume Codex from this thread id")
    .option("--output <path>", "write the stable JSON result document to this path")
    .option("--steps-output <path>", "write the per-turn steps array to this path")
    .option("--verbose", "emit diagnostics to stderr", false)
    .allowExcessArguments(false)
    .exitOverride();
}

function parseRounds(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`--rounds must be a positive integer, got '${raw}'`);
  }
  return n;
}

function parseFirst(raw: string): Cli {
  if (raw !== "codex" && raw !== "claude") {
    throw new Error(`--first must be 'codex' or 'claude', got '${raw}'`);
  }
  return raw;
}

/** Parse args, run the relay, render output, and return the process exit code. */
export async function run(argv: readonly string[]): Promise<number> {
  const program = buildProgram();
  try {
    program.parse([...argv], { from: "user" });
  } catch (err) {
    // exitOverride turns help/version/usage errors into throws; commander has already written them.
    const code = err instanceof CommanderError ? err.exitCode : USAGE_EXIT;
    return code === 0 ? 0 : USAGE_EXIT;
  }

  const opts = program.opts<RawOptions>();
  const [prompt1, prompt2] = program.args;

  let rounds: number;
  let first: Cli;
  try {
    rounds = parseRounds(opts.rounds);
    first = parseFirst(opts.first);
  } catch (err) {
    process.stderr.write(`parley: ${err instanceof Error ? err.message : String(err)}\n`);
    return USAGE_EXIT;
  }

  // Phase 1: resume is both-or-neither (a fresh run, or a continuation of both sessions).
  if ((opts.claudeSession === undefined) !== (opts.codexSession === undefined)) {
    process.stderr.write(
      "parley: resume requires both --claude-session and --codex-session (mixed resume is not supported)\n",
    );
    return USAGE_EXIT;
  }

  const plan = planSlots({
    first,
    claudeSession: opts.claudeSession,
    codexSession: opts.codexSession,
  });
  const claude = new ClaudeRunner(opts.claudeSession);
  const codex = new CodexRunner(opts.codexSession);
  const agent1: AgentRunner = plan.agent1Cli === "claude" ? claude : codex;
  const agent2: AgentRunner = plan.agent2Cli === "claude" ? claude : codex;

  if (opts.verbose) {
    process.stderr.write(
      `parley: agent-1=${plan.agent1Cli} (plan lead), agent-2=${plan.agent2Cli}; rounds/stage=${rounds}; ${prompt2 !== undefined ? "deliberate→build" : "deliberate only (read-only)"}\n`,
    );
  }

  const result = await runRelay({
    prompt1: prompt1 ?? "",
    prompt2: prompt2 ?? undefined,
    rounds,
    first,
    agent1,
    agent2,
    agent1Resumed: plan.agent1Resumed,
    agent2Resumed: plan.agent2Resumed,
  });

  process.stdout.write(`${renderText(result)}\n`);
  if (opts.output !== undefined) {
    writeFileSync(opts.output, `${renderResultDocument(result)}\n`);
  }
  if (opts.stepsOutput !== undefined) {
    writeFileSync(opts.stepsOutput, `${renderSteps(result.steps)}\n`);
  }
  if (result.status === "failed" && result.error !== undefined) {
    process.stderr.write(`parley: ${result.error}\n`);
  }

  return EXIT_CODE[result.status];
}
