import { spawn } from "node:child_process";

import { stageSkills } from "./stage-skills.js";
import type {
  CodingAgentRunner,
  SkillInvocation,
  SkillInvocationResult,
} from "./runner.js";
import { resolveWorkingCopyMount } from "./wc-mount.js";

/**
 * Coding-agent runner that drives the `codex` (OpenAI Codex CLI) via
 * subprocess. Per ADR-0002, skills are staged into a temp directory and
 * mounted by setting `CODEX_HOME=<staged>` so Codex auto-discovers
 * `<CODEX_HOME>/skills/<name>/SKILL.md`.
 *
 * Subprocess shape:
 *
 *   CODEX_HOME=<staged> codex exec --ignore-user-config -c project_doc_max_bytes=0 \
 *     [--add-dir <wc-path>] ... [-c model_reasoning_effort=<effort>] \
 *     [--model <model>] "/<entrypoint> <rendered args>"
 *
 * Flags chosen per ADR-0002 §Mount mechanism per backend:
 *   - `--ignore-user-config` suppresses `~/.codex` so the developer's
 *     personal config doesn't leak into the run.
 *   - `-c project_doc_max_bytes=0` suppresses ambient project-level
 *     AGENTS.md / similar from being injected.
 *
 * Multi-working-copy mount: the first working copy is the spawn `cwd`;
 * every other working copy is passed as `--add-dir <path>` so the
 * subprocess can read/edit across all of them. (Codex CLI's `--add-dir`
 * is the canonical mechanism.)
 *
 * `effort` mapping: when `RunSkillArgs.effort` resolves to a non-undefined
 * value the runner sets `-c model_reasoning_effort=<value>`. Codex uses
 * `model_reasoning_effort` as the config key; values typically map to
 * `minimal | low | medium | high` but unknown values are propagated
 * verbatim so the CLI's own validation owns the surface.
 */
export interface CodexRunnerOptions {
  /** Override the `codex` binary path. Defaults to `"codex"` (PATH lookup). */
  readonly bin?: string;
  /** Per-invocation timeout in ms. Defaults to 14 minutes (under Lambda's 15-min cap). */
  readonly timeoutMs?: number;
  /** Optional override for staging-temp parent (testing hook). */
  readonly stagingParentDir?: string;
  /** Extra env vars merged onto the subprocess (in addition to `CODEX_HOME`). */
  readonly env?: Readonly<Record<string, string>>;
  /** stdout / stderr capture cap, in bytes. Defaults to 8 MiB. */
  readonly captureCapBytes?: number;
  /**
   * Optional override of the suppression flags. Defaults to the ADR-0002
   * pair (`--ignore-user-config`, `-c project_doc_max_bytes=0`). Tests
   * pass `[]` so a stub binary doesn't have to know about Codex flags.
   */
  readonly suppressFlags?: ReadonlyArray<string>;
  /**
   * Codex TOML config key used to thread the resolved `effort` value
   * through as `-c <key>=<value>`. Defaults to `"model_reasoning_effort"`
   * — the documented key in Codex's TOML config schema as of this
   * implementation. The Codex CLI surface around reasoning effort has
   * moved (`reasoning_effort` is also seen in some upstream branches);
   * override here if a CLI smoke-test against the installed version
   * shows the key needs to be different. Phase-1 ships the documented
   * default; a follow-up will pin the key against the live CLI.
   */
  readonly effortConfigKey?: string;
}

const DEFAULT_TIMEOUT_MS = 14 * 60 * 1000;
const DEFAULT_CAPTURE_CAP_BYTES = 8 * 1024 * 1024;
const DEFAULT_SUPPRESS_FLAGS: ReadonlyArray<string> = [
  "--ignore-user-config",
  "-c",
  "project_doc_max_bytes=0",
];
const DEFAULT_EFFORT_CONFIG_KEY = "model_reasoning_effort";

export class CodexRunner implements CodingAgentRunner {
  readonly codingAgent = "codex";

  readonly #bin: string;
  readonly #timeoutMs: number;
  readonly #stagingParentDir: string | undefined;
  readonly #env: Readonly<Record<string, string>>;
  readonly #captureCapBytes: number;
  readonly #suppressFlags: ReadonlyArray<string>;
  readonly #effortConfigKey: string;

  constructor(options: CodexRunnerOptions = {}) {
    this.#bin = options.bin ?? "codex";
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#stagingParentDir = options.stagingParentDir;
    this.#env = options.env ?? {};
    this.#captureCapBytes = options.captureCapBytes ?? DEFAULT_CAPTURE_CAP_BYTES;
    this.#suppressFlags = options.suppressFlags ?? DEFAULT_SUPPRESS_FLAGS;
    this.#effortConfigKey = options.effortConfigKey ?? DEFAULT_EFFORT_CONFIG_KEY;
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
      const args: string[] = ["exec", ...this.#suppressFlags];
      for (const dir of mount.addDirs) {
        args.push("--add-dir", dir);
      }
      if (invocation.effort !== undefined) {
        args.push("-c", `${this.#effortConfigKey}=${invocation.effort}`);
      }
      if (invocation.model !== undefined) {
        args.push("--model", invocation.model);
      }
      args.push(prompt);

      const result = await this.#runProcess({ args, cwd: mount.cwd, codexHome: staged.dir });
      return result;
    } finally {
      await staged.cleanup();
    }
  }

  #runProcess(args: {
    args: ReadonlyArray<string>;
    cwd: string;
    codexHome: string;
  }): Promise<SkillInvocationResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.#bin, [...args.args], {
        cwd: args.cwd,
        env: {
          ...process.env,
          ...this.#env,
          CODEX_HOME: args.codexHome,
        },
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
            `CodexRunner: '${this.#bin}' did not return within ${this.#timeoutMs}ms`,
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
              `CodexRunner: '${this.#bin}' exited with code ${code}; stderr tail: ${tail(stderr)}`,
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

function buildPrompt(invocation: SkillInvocation): string {
  // Same slash-command convention as `ClaudeCodeRunner`. Multi-line YAML
  // args ride inside a single CLI argument; spawn() passes them through
  // unmolested (no shell parsing).
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
