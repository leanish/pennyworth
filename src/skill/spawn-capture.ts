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

    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes <= options.captureCapBytes) stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= options.captureCapBytes) stderr += chunk.toString("utf8");
    });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        new Error(`${options.label}: '${options.bin}' did not return within ${options.timeoutMs}ms`),
      );
    }, options.timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
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
