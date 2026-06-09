import { randomUUID } from "node:crypto";

import type { Cli, Verdict } from "../types.js";
import type { AgentRunner } from "./runner.js";
import { spawnCapture, tail } from "./spawn.js";
import { extractVerdictFromText, parseVerdict, VERDICT_SCHEMA_JSON } from "./verdict-schema.js";

interface ClaudeResponse {
  readonly structured_output?: unknown;
  readonly session_id?: string;
  readonly result?: string;
}

// Claude drops native `--json-schema` structured output on any --resume turn that uses tools (reads
// or edits). Since parley can't predict tool use, every Claude prompt also asks for the verdict as a
// fenced JSON block, and run() falls back to parsing it from the prose when structured_output is gone.
const VERDICT_BLOCK_INSTRUCTION =
  '\n\nEnd your reply with your verdict as a JSON object in a ```json fenced code block: ' +
  '{"status": "continue|done|needs-user|error", "summary": "<one line>", "reason": "<one line>", "body": "<your full answer or report>"} ' +
  "(continue = something material remains; done = nothing material remains from your side).";

/**
 * Drives the `claude` CLI. The session id is self-assigned up front (a generated UUID), so there is
 * no id to parse and no extraction-failure path: the first turn uses `--session-id`, later turns
 * `--resume`. The verdict is the top-level `structured_output` field; the prose `result` field is
 * ignored.
 */
export class ClaudeRunner implements AgentRunner {
  readonly cli: Cli = "claude";
  #sessionId: string;
  #started: boolean;

  constructor(sessionId?: string) {
    if (sessionId !== undefined) {
      this.#sessionId = sessionId;
      this.#started = true;
    } else {
      this.#sessionId = randomUUID();
      this.#started = false;
    }
  }

  get sessionId(): string | undefined {
    // The UUID is self-assigned up front, but the session only exists once it has been resumed or
    // a run has created it — report it only then, so a Claude that never ran is not over-reported.
    return this.#started ? this.#sessionId : undefined;
  }

  async run(prompt: string): Promise<Verdict> {
    const sessionArgs = this.#started
      ? ["--resume", this.#sessionId]
      : ["--session-id", this.#sessionId];
    const args = [
      ...sessionArgs,
      "-p",
      prompt + VERDICT_BLOCK_INSTRUCTION,
      "--output-format",
      "json",
      "--json-schema",
      VERDICT_SCHEMA_JSON,
    ];
    const { code, stdout, stderr } = await spawnCapture("claude", args);
    if (code !== 0) {
      throw new Error(`claude exited ${code}: ${tail(stderr)}`);
    }
    let parsed: ClaudeResponse;
    try {
      parsed = JSON.parse(stdout) as ClaudeResponse;
    } catch {
      throw new Error(`claude: could not parse JSON output: ${tail(stdout)}`);
    }
    this.#started = true;
    if (typeof parsed.session_id === "string") {
      this.#sessionId = parsed.session_id;
    }
    if (typeof parsed.structured_output === "object" && parsed.structured_output !== null) {
      return parseVerdict(parsed.structured_output);
    }
    // Claude drops structured_output on a --resume turn that edits files; recover the verdict from
    // the fenced JSON block the build prompt asks for.
    if (typeof parsed.result === "string") {
      return extractVerdictFromText(parsed.result);
    }
    throw new Error("claude: no structured_output and no parseable verdict in result");
  }
}
