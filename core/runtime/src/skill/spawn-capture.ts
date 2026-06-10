import { spawn } from "node:child_process";

import type { SkillInvocationResult } from "./runner.js";
import { tail } from "./tail.js";

export interface SpawnCaptureOptions {
  readonly bin: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  /** Extra env merged on top of `process.env` (e.g. `CODEX_HOME`). */
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly captureCapBytes: number;
  /** Prefix for timeout / non-zero-exit error messages, e.g. `"ClaudeCodeRunner"`. */
  readonly label: string;
}

/**
 * Spawn a coding-agent CLI and capture its terminal output. Shared by
 * `ClaudeCodeRunner` and `CodexRunner` — the only per-runner differences are
 * the assembled `args`, the extra `env` (Codex injects `CODEX_HOME`), and the
 * `label` used in error messages.
 *
 * Behaviour:
 *   - stdout / stderr captured up to `captureCapBytes` (bytes beyond the cap
 *     are counted but dropped, so a runaway subprocess can't exhaust memory);
 *   - a hard `timeoutMs` SIGKILL with a clear rejection;
 *   - non-zero exit rejects with the exit code + a stderr tail;
 *   - success resolves to `{ responseText, stderrTail? }`.
 *
 * The git-backed `LocalGitWorkspace` deliberately does *not* use this: it
 * treats the exit code as data and has no timeout / capture cap.
 */
export function spawnCapture(options: SpawnCaptureOptions): Promise<SkillInvocationResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(options.bin, [...options.args], {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    const cap = options.captureCapBytes;

    // Keep the most-recent `cap` chars of each stream (a bounded tail), not the
    // first `cap`: the terminal JSON block lands at the END of stdout, and a
    // failure's useful stderr (stack trace / OOM line) is its tail. Trimming
    // the front bounds memory without dropping the part we actually need.
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > cap) stdout = stdout.slice(stdout.length - cap);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > cap) stderr = stderr.slice(stderr.length - cap);
    });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        new Error(`${options.label}: '${options.bin}' did not return within ${options.timeoutMs}ms`),
      );
    }, options.timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        reject(
          new Error(
            `${options.label}: '${options.bin}' not found on PATH — install the coding-agent CLI, or run with --fake-runner (no subprocess)`,
          ),
        );
        return;
      }
      reject(err);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(
          new Error(
            `${options.label}: '${options.bin}' exited with code ${code}; stderr tail: ${tail(stderr)}`,
          ),
        );
        return;
      }
      resolve({
        responseText: stdout,
        ...(stderr.length > 0 ? { stderrTail: tail(stderr) } : {}),
      });
    });
  });
}
