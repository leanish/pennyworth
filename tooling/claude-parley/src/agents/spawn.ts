import { spawn } from "node:child_process";

export interface SpawnResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Run a subprocess non-interactively: stdin is closed, stdout/stderr captured. Args are passed as
 * an array (no shell), so prompts and inline schemas need no quoting. This is the uniform
 * non-interactive contract for both coding-agent runners.
 */
export function spawnCapture(bin: string, args: readonly string[]): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, [...args], { stdio: ["ignore", "pipe", "pipe"] });
    // Collect raw Buffers and decode once at the end — decoding per chunk would corrupt any
    // multi-byte UTF-8 character that straddles a chunk boundary (which would break JSON parsing).
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });
    child.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        reject(new Error(`'${bin}' not found on PATH — install the coding-agent CLI`));
        return;
      }
      reject(err);
    });
    child.on("close", (code) => {
      resolve({
        code: code ?? -1,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
      });
    });
  });
}

/** Keep the trailing slice of long stderr for error messages. */
export function tail(text: string, max = 500): string {
  const trimmed = text.trim();
  return trimmed.length > max ? trimmed.slice(trimmed.length - max) : trimmed;
}
