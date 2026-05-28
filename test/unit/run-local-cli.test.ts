import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";

import { beforeAll, describe, expect, it } from "vitest";

import { runLocalCli } from "../../src/runtime/run-local-cli.js";

/**
 * The CLI test builds a minimal end-to-end scenario:
 *   1. A temp agent dir with an agent.yaml + a built dist/index.js.
 *   2. A JSON message passed via stdin.
 *   3. `--fake-runner` so we don't spawn `claude`.
 */
async function makeTempAgent(): Promise<{ agentDir: string; skillsDir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "agent-runtime-cli-test-"));
  const skillsDir = join(dir, "skills");
  await mkdir(join(skillsDir, "noop"), { recursive: true });
  await writeFile(
    join(skillsDir, "noop", "SKILL.md"),
    `---
name: noop
description: cli-test placeholder
inputSchema:
  type: object
outputSchema:
  type: object
---

# noop
`,
  );
  await writeFile(
    join(dir, "agent.yaml"),
    `identifier: testagent
compute: lambda
triggers:
  - type: consumer
    queueArnRef: q
    dlqArnRef: dlq
    signedEnvelope: false
stages: [init]
codingAgent: claude-code
model: m
skills:
  entrypoints: [noop]
needs: []
`,
  );
  // Minimal agent module that succeeds without using the runtime — keeps
  // the test focused on the CLI wiring (descriptor load, message parse,
  // dispatch loop) rather than runSkill.
  await mkdir(join(dir, "dist"));
  await writeFile(
    join(dir, "dist", "index.js"),
    `export default {
  identifier: "testagent",
  async handle(message, runtime) {
    runtime.logger.info("testagent: handled", { stage: message.stage });
  },
};
`,
  );
  return { agentDir: dir, skillsDir };
}

describe("runLocalCli", () => {
  let agentDir: string;
  let skillsDir: string;
  beforeAll(async () => {
    ({ agentDir, skillsDir } = await makeTempAgent());
  });

  it("prints usage when invoked with --help", async () => {
    const stdout = new PassThrough();
    let stdoutBuf = "";
    stdout.on("data", (chunk) => {
      stdoutBuf += chunk.toString("utf8");
    });
    const code = await runLocalCli(["--help"], {
      stdout,
      stderr: new PassThrough(),
      stdin: Readable.from([]),
    });
    expect(code).toBe(0);
    expect(stdoutBuf).toContain("Usage:");
  });

  it("runs a message end-to-end via stdin + --fake-runner", async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let stdoutBuf = "";
    stdout.on("data", (chunk) => {
      stdoutBuf += chunk.toString("utf8");
    });

    const message = JSON.stringify({
      stage: "init",
      payload: {},
      metadata: {
        receivedAt: "2026-05-23T00:00:00.000Z",
        sourceTrigger: "consumer",
        requestId: "msg-cli-1",
      },
    });

    const code = await runLocalCli(
      [
        "run-local",
        "--agent-config",
        join(agentDir, "agent.yaml"),
        "--skills-dir",
        skillsDir,
        "--fake-runner",
        "--log-level",
        "error",
      ],
      {
        stdin: Readable.from([message]),
        stdout,
        stderr,
      },
    );
    expect(code).toBe(0);
    // The testagent's handler returns nothing (`undefined`). The CLI now
    // surfaces that as `null` on stdout — the previous `{status:"ok",agent}`
    // synthetic envelope was a fallback that masked silent no-op handlers.
    expect(stdoutBuf.trim()).toBe("null");
  });

  it("accepts a signed envelope on stdin and normalises it locally (no signature verification)", async () => {
    const stdout = new PassThrough();
    let stdoutBuf = "";
    stdout.on("data", (chunk) => {
      stdoutBuf += chunk.toString("utf8");
    });

    // A captured-from-production envelope shape (signature is opaque to local mode).
    const envelope = {
      kind: "ask",
      requestId: "envelope-req-1",
      consumer: "atc-ui",
      endUser: "github:U1",
      timestamp: "2026-05-23T00:00:00.000Z",
      signature: "0".repeat(64),
      payload: { question: "What does auth do?" },
    };

    const code = await runLocalCli(
      [
        "run-local",
        "--agent-config",
        join(agentDir, "agent.yaml"),
        "--skills-dir",
        skillsDir,
        "--fake-runner",
        "--log-level",
        "error",
      ],
      {
        stdin: Readable.from([JSON.stringify(envelope)]),
        stdout,
        stderr: new PassThrough(),
      },
    );
    expect(code).toBe(0);
    // The testagent's handle returns undefined — the CLI surfaces `null`
    // (no `status:ok` fallback). The point of this test is that the
    // envelope-shape input was accepted at all (the old loader threw).
    expect(stdoutBuf.trim()).toBe("null");
  });

  it("verifies envelope HMAC when --consumer-secret is provided (opt-in)", async () => {
    const { createHmac } = await import("node:crypto");
    const { canonicalize } = await import("../../src/envelope/canonical.js");
    const SECRET = "local-dev-secret-for-test";
    const partial = {
      kind: "ask",
      requestId: "envelope-verify-1",
      consumer: "atc-ui",
      endUser: "github:U1",
      timestamp: new Date().toISOString(), // current; inside the skew window
      payload: { question: "X?" },
    };
    const message =
      partial.timestamp +
      "\n" +
      partial.consumer +
      "\n" +
      partial.endUser +
      "\n" +
      "" +
      "\n" +
      canonicalize(partial.payload);
    const signature = createHmac("sha256", SECRET).update(message).digest("hex");
    const envelope = { ...partial, signature };

    const stdout = new PassThrough();
    let stdoutBuf = "";
    stdout.on("data", (chunk) => {
      stdoutBuf += chunk.toString("utf8");
    });
    const code = await runLocalCli(
      [
        "run-local",
        "--agent-config",
        join(agentDir, "agent.yaml"),
        "--skills-dir",
        skillsDir,
        "--fake-runner",
        "--log-level",
        "error",
        "--consumer-secret",
        SECRET,
      ],
      {
        stdin: Readable.from([JSON.stringify(envelope)]),
        stdout,
        stderr: new PassThrough(),
      },
    );
    expect(code).toBe(0);
    expect(stdoutBuf.trim()).toBe("null");
  });

  it("rejects a tampered envelope when --consumer-secret is provided", async () => {
    const envelope = {
      kind: "ask",
      requestId: "tampered-1",
      consumer: "atc-ui",
      endUser: "github:U1",
      timestamp: new Date().toISOString(),
      signature: "0".repeat(64), // not a valid HMAC for any input
      payload: { question: "X?" },
    };
    const stderr = new PassThrough();
    let stderrBuf = "";
    stderr.on("data", (chunk) => {
      stderrBuf += chunk.toString("utf8");
    });
    const code = await runLocalCli(
      [
        "run-local",
        "--agent-config",
        join(agentDir, "agent.yaml"),
        "--skills-dir",
        skillsDir,
        "--fake-runner",
        "--log-level",
        "error",
        "--consumer-secret",
        "any-secret",
      ],
      {
        stdin: Readable.from([JSON.stringify(envelope)]),
        stdout: new PassThrough(),
        stderr,
      },
    );
    expect(code).toBe(1);
    expect(stderrBuf).toMatch(/signature|envelope/i);
  });

  it("exits non-zero when --agent-config is missing", async () => {
    const stderr = new PassThrough();
    let stderrBuf = "";
    stderr.on("data", (chunk) => {
      stderrBuf += chunk.toString("utf8");
    });
    const code = await runLocalCli(["run-local"], {
      stdout: new PassThrough(),
      stderr,
      stdin: Readable.from([]),
    });
    expect(code).toBe(2);
    expect(stderrBuf).toContain("--agent-config is required");
  });

  it("prints the handler's return value as JSON when the handler returns one (terminal-reply path)", async () => {
    // Build a separate fixture whose handler returns a structured reply,
    // mimicking ATC's `AtcTerminalReply`. The CLI must surface that
    // directly (not wrap it in a `{ status: "ok" }` envelope).
    const tmp = await mkdtemp(join(tmpdir(), "agent-runtime-cli-reply-"));
    const skillsDir = join(tmp, "skills");
    await mkdir(join(skillsDir, "noop"), { recursive: true });
    await writeFile(
      join(skillsDir, "noop", "SKILL.md"),
      `---
name: noop
inputSchema: { type: object }
outputSchema: { type: object }
---

# noop
`,
    );
    await writeFile(
      join(tmp, "agent.yaml"),
      `identifier: replyagent
compute: lambda
triggers:
  - type: consumer
    queueArnRef: q
    dlqArnRef: dlq
    signedEnvelope: false
stages: [init]
codingAgent: claude-code
model: m
skills:
  entrypoints: [noop]
needs: []
`,
    );
    await mkdir(join(tmp, "dist"));
    await writeFile(
      join(tmp, "dist", "index.js"),
      `export default {
  identifier: "replyagent",
  async handle(message, runtime) {
    return {
      requestId: message.metadata.requestId,
      status: "completed",
      result: { answer: "the terminal reply value" },
    };
  },
};
`,
    );

    const stdout = new PassThrough();
    let stdoutBuf = "";
    stdout.on("data", (chunk) => {
      stdoutBuf += chunk.toString("utf8");
    });

    const message = JSON.stringify({
      stage: "init",
      payload: {},
      metadata: {
        receivedAt: "2026-05-23T00:00:00.000Z",
        sourceTrigger: "consumer",
        requestId: "msg-reply-1",
      },
    });

    const code = await runLocalCli(
      [
        "run-local",
        "--agent-config",
        join(tmp, "agent.yaml"),
        "--skills-dir",
        skillsDir,
        "--fake-runner",
        "--log-level",
        "error",
      ],
      {
        stdin: Readable.from([message]),
        stdout,
        stderr: new PassThrough(),
      },
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(stdoutBuf);
    expect(parsed).toEqual({
      requestId: "msg-reply-1",
      status: "completed",
      result: { answer: "the terminal reply value" },
    });
  });
});
