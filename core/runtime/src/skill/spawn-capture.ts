import { spawn } from "node:child_process";

import { NOOP_REDACTOR, Redactor, type SecretEntry } from "../logger/redactor.js";
import type { SkillInvocationResult } from "./runner.js";
import { tail } from "./tail.js";

export interface SpawnCaptureOptions {
  readonly bin: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  /** Extra env merged on top of the scrubbed `process.env` (e.g. `CODEX_HOME`). */
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly captureCapBytes: number;
  /** Prefix for timeout / non-zero-exit error messages, e.g. `"ClaudeCodeRunner"`. */
  readonly label: string;
  /**
   * Secret values substring-replaced with `<redacted:NAME>` in the captured
   * stdout / stderr (including error tails) before anything is returned or
   * thrown. Exact-string matching via `Redactor` — no heuristics.
   */
  readonly secrets?: ReadonlyArray<SecretEntry>;
}

/**
 * AWS credential / credential-source env vars stripped from the
 * `process.env` base before the coding-agent subprocess is spawned. The
 * execution role's permissions (e.g. `ssm:GetParameter` over every
 * project's credentials once `target-credentials` is granted) must not be
 * ambiently available to the model subprocess — it gets exactly the env
 * the runtime resolved for it, nothing more.
 *
 * The scrub applies to the inherited base only: an operator who genuinely
 * needs to hand AWS credentials to the subprocess (e.g. a Bedrock-auth
 * CLI) re-adds them deliberately via the runner's `options.env`, which
 * merges after the scrub. Catalog data can never re-add them — the
 * credentials schema bans the `AWS_` prefix outright.
 */
export const SCRUBBED_AWS_ENV_VARS: ReadonlyArray<string> = [
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_PROFILE",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
  "AWS_ROLE_ARN",
  "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
  "AWS_SHARED_CREDENTIALS_FILE",
  "AWS_CONFIG_FILE",
];

/** `process.env` minus the AWS credential vars (see `SCRUBBED_AWS_ENV_VARS`). */
export function scrubbedProcessEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const name of SCRUBBED_AWS_ENV_VARS) {
    delete env[name];
  }
  return env;
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
  const redactor =
    options.secrets !== undefined && options.secrets.length > 0
      ? new Redactor(options.secrets)
      : NOOP_REDACTOR;
  return new Promise((resolve, reject) => {
    const child = spawn(options.bin, [...options.args], {
      cwd: options.cwd,
      env: { ...scrubbedProcessEnv(), ...options.env },
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
            `${options.label}: '${options.bin}' exited with code ${code}; stderr tail: ${redactor.redact(tail(stderr))}`,
          ),
        );
        return;
      }
      resolve({
        responseText: redactor.redact(stdout),
        ...(stderr.length > 0 ? { stderrTail: redactor.redact(tail(stderr)) } : {}),
      });
    });
  });
}
