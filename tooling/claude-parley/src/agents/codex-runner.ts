import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Cli, Verdict } from "../types.js";
import type { AgentRunner } from "./runner.js";
import { spawnCapture, tail } from "./spawn.js";
import { parseVerdict, VERDICT_SCHEMA_JSON } from "./verdict-schema.js";

/** Find the thread id Codex emits as the first `thread.started` event of its `--json` stream. */
function extractThreadId(stdout: string): string | undefined {
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) {
      continue;
    }
    try {
      const event = JSON.parse(trimmed) as { type?: string; thread_id?: string };
      if (event.type === "thread.started" && typeof event.thread_id === "string") {
        return event.thread_id;
      }
    } catch {
      // not a JSON event line — skip
    }
  }
  return undefined;
}

/**
 * Drives the `codex` CLI. Codex has no self-assign, so the thread id is captured from the first
 * `thread.started` event of the first run (failure to capture it is fatal). The verdict is the JSON
 * written to the `--output-last-message` file. The schema is passed by file path (`--output-schema`).
 */
export class CodexRunner implements AgentRunner {
  readonly cli: Cli = "codex";
  #sessionId: string | undefined;

  constructor(sessionId?: string) {
    this.#sessionId = sessionId;
  }

  get sessionId(): string | undefined {
    return this.#sessionId;
  }

  async run(prompt: string): Promise<Verdict> {
    const dir = mkdtempSync(join(tmpdir(), "claude-parley-"));
    const schemaFile = join(dir, "schema.json");
    const lastMessageFile = join(dir, "last-message.json");
    try {
      writeFileSync(schemaFile, VERDICT_SCHEMA_JSON);
      const resumeArgs = this.#sessionId !== undefined ? ["resume", this.#sessionId] : [];
      const args = [
        "exec",
        ...resumeArgs,
        "--json",
        "--output-schema",
        schemaFile,
        "-o",
        lastMessageFile,
        prompt,
      ];
      const { code, stdout, stderr } = await spawnCapture("codex", args);
      if (code !== 0) {
        // Codex's real error is often in the --json stdout stream, not stderr.
        const detail = tail(stderr) || tail(stdout);
        throw new Error(`codex exited ${code}: ${detail}`);
      }
      if (this.#sessionId === undefined) {
        const id = extractThreadId(stdout);
        if (id === undefined) {
          throw new Error("codex: failed to capture thread id from --json stream (cannot resume)");
        }
        this.#sessionId = id;
      }
      let raw: string;
      try {
        raw = readFileSync(lastMessageFile, "utf8");
      } catch {
        throw new Error("codex: no last-message output written");
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new Error(`codex: could not parse last-message JSON: ${tail(raw)}`);
      }
      return parseVerdict(parsed);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}
