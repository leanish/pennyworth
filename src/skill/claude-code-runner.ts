import { spawn } from "node:child_process";

import { stageSkills } from "./stage-skills.js";
import type {
  CodingAgentRunner,
  SkillInvocation,
  SkillInvocationResult,
} from "./runner.js";
import { resolveWorkingCopyMount } from "./wc-mount.js";

/**
 * Coding-agent runner that drives the `claude` (Claude Code) CLI via
 * subprocess. Per ADR-0002, skills are staged into a temp directory and
 * mounted via `--plugin-dir`. The rendered slash-command body is sent as
 * the print-mode prompt.
 *
 * Multi-working-copy mount: the first working copy becomes the spawn `cwd`;
 * every other working copy is passed as `--add-dir <path>` so the
 * subprocess can read and edit across all of them. (Claude Code's
 * `--add-dir` flag is the canonical mechanism for additional working
 * directories.)
 *
 * `effort` plumbing: Claude Code exposes `--effort <low|medium|high|xhigh|max>`.
 * Our internal `Effort` type is `minimal | low | medium | high | xhigh`;
 * we map `minimal → low` (the CLI rejects `minimal`) and pass the rest
 * through verbatim. An operator who wants `max` can set
 * `descriptor.effort = "xhigh"` and rely on `effortLevelMap` if the CLI
 * surface changes; the mapping is documented inline so the contract
 * isn't a hidden table.
 */
export interface ClaudeCodeRunnerOptions {
  /** Override the `claude` binary path. Defaults to `"claude"` (PATH lookup). */
  readonly bin?: string;
  /** Per-invocation timeout in ms. Defaults to 14 minutes (under Lambda's 15-min cap). */
  readonly timeoutMs?: number;
  /** Optional override for staging-temp parent (testing hook). */
  readonly stagingParentDir?: string;
  /** Extra env vars merged onto the subprocess. */
  readonly env?: Readonly<Record<string, string>>;
  /** stdout / stderr capture cap, in bytes. Defaults to 8 MiB. */
  readonly captureCapBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 14 * 60 * 1000;
const DEFAULT_CAPTURE_CAP_BYTES = 8 * 1024 * 1024;

export class ClaudeCodeRunner implements CodingAgentRunner {
  readonly codingAgent = "claude-code";

  readonly #bin: string;
  readonly #timeoutMs: number;
  readonly #stagingParentDir: string | undefined;
  readonly #env: Readonly<Record<string, string>>;
  readonly #captureCapBytes: number;

  constructor(options: ClaudeCodeRunnerOptions = {}) {
    this.#bin = options.bin ?? "claude";
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#stagingParentDir = options.stagingParentDir;
    this.#env = options.env ?? {};
    this.#captureCapBytes = options.captureCapBytes ?? DEFAULT_CAPTURE_CAP_BYTES;
  }

  async run(invocation: SkillInvocation): Promise<SkillInvocationResult> {
    const staged = await stageSkills({
      entrypoint: invocation.entrypoint,
      supportSkills: invocation.supportSkills,
      ...(this.#stagingParentDir !== undefined ? { parentDir: this.#stagingParentDir } : {}),
    });
    try {
      const prompt = buildPrompt(invocation);
      const mount = resolveWorkingCopyMount(invocation.workingCopies);
      const args: string[] = ["--print", "--plugin-dir", staged.dir];
      for (const dir of mount.addDirs) {
        args.push("--add-dir", dir);
      }
      if (invocation.model !== undefined) {
        args.push("--model", invocation.model);
      }
      if (invocation.effort !== undefined) {
        args.push("--effort", mapEffortForClaudeCli(invocation.effort));
      }
      args.push(prompt);

      const result = await this.#runProcess({ args, cwd: mount.cwd });
      return result;
    } finally {
      await staged.cleanup();
    }
  }

  #runProcess(args: { args: ReadonlyArray<string>; cwd: string }): Promise<SkillInvocationResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.#bin, [...args.args], {
        cwd: args.cwd,
        env: { ...process.env, ...this.#env },
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdoutBytes = 0;
      let stderrBytes = 0;
      let stdout = "";
      let stderr = "";

      const onStdout = (chunk: Buffer): void => {
        stdoutBytes += chunk.length;
        if (stdoutBytes <= this.#captureCapBytes) {
          stdout += chunk.toString("utf8");
        }
      };
      const onStderr = (chunk: Buffer): void => {
        stderrBytes += chunk.length;
        if (stderrBytes <= this.#captureCapBytes) {
          stderr += chunk.toString("utf8");
        }
      };

      child.stdout.on("data", onStdout);
      child.stderr.on("data", onStderr);

      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(
          new Error(
            `ClaudeCodeRunner: '${this.#bin}' did not return within ${this.#timeoutMs}ms`,
          ),
        );
      }, this.#timeoutMs);

      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });

      child.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          reject(
            new Error(
              `ClaudeCodeRunner: '${this.#bin}' exited with code ${code}; stderr tail: ${tail(stderr)}`,
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
}

/**
 * Map the suite's `Effort` vocabulary onto Claude Code's CLI surface.
 *
 *   - Claude CLI: `--effort <low|medium|high|xhigh|max>` (validated by `claude --help`).
 *   - Suite: `minimal | low | medium | high | xhigh`.
 *
 * `minimal` collapses to `low` because the CLI rejects `minimal`; every
 * other value passes through verbatim. The suite has no `max` — operators
 * who want `max` would need to widen the suite-level `Effort` type first.
 *
 * Exported so tests can assert the mapping and downstream tooling can
 * compose against the same table without re-deriving it.
 */
export function mapEffortForClaudeCli(effort: string): string {
  return effort === "minimal" ? "low" : effort;
}

function buildPrompt(invocation: SkillInvocation): string {
  // The skill body is mounted as a plugin slash-command; we trigger it
  // with `/<entrypoint>` and pass the rendered YAML as the body. Multi-line
  // args are fine inside a single quoted CLI argument because we spawn the
  // process directly (no shell parsing).
  if (invocation.renderedArguments.length === 0) {
    return `/${invocation.entrypoint.name}`;
  }
  return `/${invocation.entrypoint.name}\n${invocation.renderedArguments}`;
}

const TAIL_BYTES = 4096;
function tail(s: string): string {
  if (s.length <= TAIL_BYTES) return s;
  return s.slice(-TAIL_BYTES);
}
