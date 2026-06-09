import { spawn } from "node:child_process";
import type { CodingAgentCli } from "./types.js";
import { CodingAgentInvocationError, MissingCliError } from "./types.js";

const CAPTURE_LIMIT_BYTES = 4 * 1024 * 1024;

export type SpawnCaptureInput = {
  cli: CodingAgentCli;
  bin: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
};

export type SpawnCaptureOutput = {
  stdout: string;
  stderr: string;
};

export class ProcessExitError extends CodingAgentInvocationError {
  readonly stdout: string;
  readonly stderr: string;

  constructor(input: { cli: CodingAgentCli; message: string; stdout: string; stderr: string }) {
    super(input.cli, input.message);
    this.name = "ProcessExitError";
    this.stdout = input.stdout;
    this.stderr = input.stderr;
  }
}

export class OutputLimitError extends CodingAgentInvocationError {
  readonly stdout: string;
  readonly stderr: string;

  constructor(input: { cli: CodingAgentCli; message: string; stdout: string; stderr: string }) {
    super(input.cli, input.message);
    this.name = "OutputLimitError";
    this.stdout = input.stdout;
    this.stderr = input.stderr;
  }
}

export function spawnCapture(input: SpawnCaptureInput): Promise<SpawnCaptureOutput> {
  return new Promise((resolve, reject) => {
    const child = spawn(input.bin, input.args, {
      cwd: input.cwd,
      env: input.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;

    child.stdout.on("data", (chunk: Buffer) => {
      const result = appendChunk(stdoutChunks, stdoutBytes, chunk);
      stdoutBytes = result.bytes;
      stdoutTruncated ||= result.truncated;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const result = appendChunk(stderrChunks, stderrBytes, chunk);
      stderrBytes = result.bytes;
      stderrTruncated ||= result.truncated;
    });

    child.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        reject(new MissingCliError(input.cli, error));
        return;
      }
      reject(new CodingAgentInvocationError(input.cli, `${input.bin} failed to start: ${error.message}`, { cause: error }));
    });

    child.on("close", (code, signal) => {
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      if (stdoutTruncated || stderrTruncated) {
        reject(
          new OutputLimitError({
            cli: input.cli,
            message: `${input.bin} output exceeded ${CAPTURE_LIMIT_BYTES} byte capture limit (${[
              stdoutTruncated ? "stdout" : undefined,
              stderrTruncated ? "stderr" : undefined,
            ]
              .filter((stream) => stream !== undefined)
              .join(", ")})`,
            stdout,
            stderr,
          }),
        );
        return;
      }
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      const detail = signal === null ? `exit code ${code ?? 1}` : `signal ${signal}`;
      reject(
        new ProcessExitError({
          cli: input.cli,
          message: `${input.bin} exited with ${detail}${stderr.length > 0 ? `: ${tail(stderr)}` : ""}`,
          stdout,
          stderr,
        }),
      );
    });
  });
}

function appendChunk(chunks: Buffer[], bytes: number, chunk: Buffer): { bytes: number; truncated: boolean } {
  if (bytes >= CAPTURE_LIMIT_BYTES) {
    return { bytes, truncated: true };
  }
  const remaining = CAPTURE_LIMIT_BYTES - bytes;
  const stored = chunk.byteLength > remaining ? chunk.subarray(0, remaining) : chunk;
  chunks.push(stored);
  return {
    bytes: bytes + stored.byteLength,
    truncated: chunk.byteLength > remaining,
  };
}

function tail(value: string): string {
  const trimmed = value.trim();
  return trimmed.length <= 800 ? trimmed : trimmed.slice(trimmed.length - 800);
}
