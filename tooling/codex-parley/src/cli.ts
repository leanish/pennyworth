import { writeFile } from "node:fs/promises";
import { Command, CommanderError } from "commander";
import { runParley } from "./relay.js";
import { createDefaultRunners } from "./runners.js";
import type { FirstCli, ParleyResult, ParleyStep, SessionIds } from "./types.js";
import type { RunnerMap } from "./types.js";
import { MissingCliError } from "./types.js";

export type CliStreams = {
  stdout: Pick<NodeJS.WriteStream, "write">;
  stderr: Pick<NodeJS.WriteStream, "write">;
};

export type CliDependencies = {
  createRunners?: () => RunnerMap;
};

type ParsedCommand = {
  prompt1: string;
  prompt2?: string;
  rounds: number;
  first: FirstCli;
  sessions: SessionIds;
  output?: string;
  stepsOutput?: string;
  verbose: boolean;
};

export async function runCli(
  argv: readonly string[],
  streams: CliStreams = processStreams(),
  dependencies: CliDependencies = {},
): Promise<number> {
  let parsed: ParsedCommand | undefined;
  const program = new Command();

  program
    .name("parley")
    .description("Run a bounded relay between Codex and Claude Code.")
    .argument("<prompt-1>", "task or subject the deliberation is about")
    .argument("[prompt-2]", "optional action the actor should take")
    .option("--rounds <n>", "maximum number of rounds", "5")
    .option("--first <codex|claude>", "which CLI fills the reviewer slot", "codex")
    .option("--claude-session <id>", "resume Claude's side from this session id")
    .option("--codex-session <id>", "resume Codex's side from this thread id")
    .option("--output <path>", "write the stable JSON result document")
    .option("--steps-output <path>", "write the per-turn steps array")
    .option("--verbose", "emit diagnostics to stderr")
    .exitOverride()
    .configureOutput({
      writeOut: (message) => streams.stdout.write(message),
      writeErr: (message) => streams.stderr.write(message),
    })
    .action((prompt1: string, prompt2: string | undefined, options: Record<string, unknown>) => {
      parsed = parseOptions(prompt1, prompt2, options);
    });

  try {
    await program.parseAsync([...argv], { from: "user" });
  } catch (error) {
    if (error instanceof CommanderError) {
      return error.exitCode;
    }
    streams.stderr.write(`parley: ${errorMessage(error)}\n`);
    return 1;
  }

  if (parsed === undefined) {
    streams.stderr.write("parley: no command parsed\n");
    return 1;
  }

  try {
    const output = await runParley({
      prompt1: parsed.prompt1,
      ...(parsed.prompt2 === undefined ? {} : { prompt2: parsed.prompt2 }),
      rounds: parsed.rounds,
      first: parsed.first,
      sessions: parsed.sessions,
      runners: dependencies.createRunners?.() ?? createDefaultRunners(),
      verbose: parsed.verbose,
      ...(parsed.verbose ? { onDiagnostic: (message: string) => streams.stderr.write(`${message}\n`) } : {}),
    });

    if (parsed.output !== undefined) {
      await writeJson(parsed.output, output.result);
    }
    if (parsed.stepsOutput !== undefined) {
      await writeJson(parsed.stepsOutput, output.steps);
    }

    streams.stdout.write(renderHumanOutput(output.result));
    return output.exitCode;
  } catch (error) {
    if (error instanceof MissingCliError) {
      streams.stderr.write(`parley: ${error.message}\n`);
      return 1;
    }
    streams.stderr.write(`parley: ${errorMessage(error)}\n`);
    return 4;
  }
}

function parseOptions(prompt1: string, prompt2: string | undefined, options: Record<string, unknown>): ParsedCommand {
  const rounds = parseRounds(readStringOption(options, "rounds", "5"));
  const first = parseFirst(readStringOption(options, "first", "codex"));
  const output = readOptionalStringOption(options, "output");
  const stepsOutput = readOptionalStringOption(options, "stepsOutput");
  const sessions = optionalSessions(
    readOptionalStringOption(options, "claudeSession"),
    readOptionalStringOption(options, "codexSession"),
  );

  return {
    prompt1,
    ...(prompt2 === undefined ? {} : { prompt2 }),
    rounds,
    first,
    sessions,
    ...(output === undefined ? {} : { output }),
    ...(stepsOutput === undefined ? {} : { stepsOutput }),
    verbose: options["verbose"] === true,
  };
}

function parseRounds(raw: string): number {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || String(parsed) !== raw) {
    throw new Error("--rounds must be a positive integer");
  }
  return parsed;
}

function parseFirst(raw: string): FirstCli {
  if (raw === "codex" || raw === "claude") {
    return raw;
  }
  throw new Error("--first must be codex or claude");
}

function optionalSessions(claude: string | undefined, codex: string | undefined): SessionIds {
  const result: SessionIds = {};
  if (claude !== undefined) {
    result.claude = claude;
  }
  if (codex !== undefined) {
    result.codex = codex;
  }
  return result;
}

function readStringOption(options: Record<string, unknown>, key: string, fallback: string): string {
  const value = options[key];
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "string") {
    throw new Error(`--${optionName(key)} must be a string`);
  }
  return value;
}

function readOptionalStringOption(options: Record<string, unknown>, key: string): string | undefined {
  const value = options[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`--${optionName(key)} must be a string`);
  }
  return value;
}

function optionName(camelName: string): string {
  return camelName.replace(/[A-Z]/g, (match) => `-${match.toLowerCase()}`);
}

function renderHumanOutput(result: ParleyResult): string {
  const lines = [
    `status: ${result.status}`,
    `rounds: ${result.roundsExecuted}/${result.maxRounds}`,
    `summary: ${result.final.summary ?? ""}`,
    "",
    "result:",
    result.final.result ?? "",
  ];

  if (result.continuation !== undefined) {
    lines.push("", "continuation:", result.continuation);
  }

  return `${lines.join("\n")}\n`;
}

async function writeJson(path: string, value: ParleyResult | readonly ParleyStep[]): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function processStreams(): CliStreams {
  return {
    stdout: process.stdout,
    stderr: process.stderr,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
