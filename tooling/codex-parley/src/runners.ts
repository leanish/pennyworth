import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { OutputLimitError, ProcessExitError, spawnCapture } from "./subprocess.js";
import type { CodingAgentRunner, RunnerInvocation, RunnerMap, RunnerOutput, Verdict } from "./types.js";
import { CodingAgentInvocationError } from "./types.js";
import { parseVerdict } from "./validate-verdict.js";
import { verdictJsonSchemaString } from "./verdict-schema.js";

export type SubprocessRunnerOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};

export function createDefaultRunners(options: SubprocessRunnerOptions = {}): RunnerMap {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  return {
    claude: new ClaudeRunner({ cwd, env }),
    codex: new CodexRunner({ cwd, env }),
  };
}

type RunnerState = {
  cwd: string;
  env: NodeJS.ProcessEnv;
};

export class ClaudeRunner implements CodingAgentRunner {
  readonly #state: RunnerState;

  constructor(state: RunnerState) {
    this.#state = state;
  }

  async run(invocation: RunnerInvocation): Promise<RunnerOutput> {
    const sessionId = invocation.sessionId ?? randomUUID();
    const args =
      invocation.sessionId === undefined
        ? ["--session-id", sessionId, "-p", invocation.prompt, "--output-format", "json", "--json-schema", verdictJsonSchemaString]
        : ["--resume", sessionId, "-p", invocation.prompt, "--output-format", "json", "--json-schema", verdictJsonSchemaString];

    const output = await spawnCapture({
      cli: "claude",
      bin: "claude",
      args,
      cwd: this.#state.cwd,
      env: this.#state.env,
    }).catch((error: unknown) => {
      if (error instanceof ProcessExitError || error instanceof OutputLimitError) {
        throw addSessionToInvocationError("claude", sessionId, error);
      }
      throw error;
    });

    try {
      return { sessionId, verdict: parseClaudeVerdict(output.stdout) };
    } catch (error) {
      throw addSessionToInvocationError("claude", sessionId, error);
    }
  }
}

export class CodexRunner implements CodingAgentRunner {
  readonly #state: RunnerState;

  constructor(state: RunnerState) {
    this.#state = state;
  }

  async run(invocation: RunnerInvocation): Promise<RunnerOutput> {
    const tempDir = await mkdtemp(join(tmpdir(), "parley-codex-"));
    const schemaPath = join(tempDir, "verdict.schema.json");
    const lastMessagePath = join(tempDir, "last-message.json");

    try {
      await writeFile(schemaPath, verdictJsonSchemaString, "utf8");
      const args =
        invocation.sessionId === undefined
          ? ["exec", "--json", "--output-schema", schemaPath, "-o", lastMessagePath, invocation.prompt]
          : ["exec", "resume", invocation.sessionId, "--json", "--output-schema", schemaPath, "-o", lastMessagePath, invocation.prompt];

      const output = await spawnCapture({
        cli: "codex",
        bin: "codex",
        args,
        cwd: this.#state.cwd,
        env: this.#state.env,
      }).catch((error: unknown) => {
        if (error instanceof ProcessExitError || error instanceof OutputLimitError) {
          const sessionId = invocation.sessionId ?? tryParseCodexThreadId(error.stdout);
          if (sessionId !== undefined) {
            throw addSessionToInvocationError("codex", sessionId, error);
          }
        }
        throw error;
      });
      const sessionId = invocation.sessionId ?? parseCodexThreadId(output.stdout);
      try {
        const lastMessage = await readFile(lastMessagePath, "utf8");
        return { sessionId, verdict: parseJsonVerdict(lastMessage, "codex output-last-message") };
      } catch (error) {
        throw addSessionToInvocationError("codex", sessionId, error);
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }
}

function parseClaudeVerdict(stdout: string): Verdict {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    throw new CodingAgentInvocationError("claude", `claude stdout was not JSON: ${errorMessage(error)}`);
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new CodingAgentInvocationError("claude", "claude stdout JSON was not an object");
  }

  return parseVerdict((parsed as Record<string, unknown>)["structured_output"]);
}

function parseJsonVerdict(raw: string, label: string): Verdict {
  try {
    return parseVerdict(JSON.parse(raw));
  } catch (error) {
    throw new CodingAgentInvocationError("codex", `${label} did not contain a valid verdict: ${errorMessage(error)}`);
  }
}

function parseCodexThreadId(stdout: string): string {
  const threadId = tryParseCodexThreadId(stdout);
  if (threadId !== undefined) {
    return threadId;
  }

  throw new CodingAgentInvocationError("codex", "codex --json output did not include a thread.started event");
}

function tryParseCodexThreadId(stdout: string): string | undefined {
  for (const line of stdout.split(/\r?\n/)) {
    if (line.trim().length === 0) {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      continue;
    }

    const record = parsed as Record<string, unknown>;
    if (record["type"] === "thread.started" && typeof record["thread_id"] === "string") {
      return record["thread_id"];
    }
  }

  return undefined;
}

function addSessionToInvocationError(cli: "claude" | "codex", sessionId: string, error: unknown): CodingAgentInvocationError {
  if (error instanceof CodingAgentInvocationError) {
    return new CodingAgentInvocationError(cli, error.message, { cause: error, sessionId });
  }
  return new CodingAgentInvocationError(cli, errorMessage(error), { cause: error, sessionId });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
