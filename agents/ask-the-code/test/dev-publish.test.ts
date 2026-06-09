import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import { devPublishCli } from "../src/dev-publish.js";

function capture(stream: PassThrough): () => string {
  let buf = "";
  stream.on("data", (chunk) => {
    buf += chunk.toString("utf8");
  });
  return () => buf;
}

const FIXED_CLOCK = () => "2026-05-23T00:00:00.000Z";
const FIXED_REQUEST_ID = () => "00000000-0000-0000-0000-000000000001";
const TEST_SECRET = "test-only-secret";

describe("devPublishCli", () => {
  it("prints usage when invoked with --help", async () => {
    const stdout = new PassThrough();
    const read = capture(stdout);
    const code = await devPublishCli(["--help"], { stdout, stderr: new PassThrough() });
    expect(code).toBe(0);
    expect(read()).toContain("Usage:");
  });

  it("outputs a RuntimeMessage<AtcPayload> by default", async () => {
    const stdout = new PassThrough();
    const read = capture(stdout);
    const code = await devPublishCli(
      [
        "--question",
        "what does auth do?",
        "--project-ids",
        "leanish/atc,leanish/reviewit",
        "--reply-to",
        "arn:aws:sqs:us-east-1:000000000000:replies",
        "--sqs-message-id",
        "fixed-sqs-1",
        "--signing-secret",
        TEST_SECRET,
      ],
      { stdout, stderr: new PassThrough(), clock: FIXED_CLOCK, newRequestId: FIXED_REQUEST_ID },
    );
    expect(code).toBe(0);
    const message = JSON.parse(read());
    expect(message).toMatchObject({
      stage: "init",
      metadata: {
        sourceTrigger: "consumer",
        requestId: "fixed-sqs-1",
        receivedAt: "2026-05-23T00:00:00.000Z",
      },
      payload: {
        envelope: {
          kind: "ask",
          requestId: "00000000-0000-0000-0000-000000000001",
          consumer: "atc-ui",
          endUser: "local:dev",
          replyTo: "arn:aws:sqs:us-east-1:000000000000:replies",
        },
        request: {
          question: "what does auth do?",
          projectIds: ["leanish/atc", "leanish/reviewit"],
        },
      },
    });
  });

  it("outputs just the signed envelope under --envelope-only", async () => {
    const stdout = new PassThrough();
    const read = capture(stdout);
    const code = await devPublishCli(
      [
        "--question",
        "x?",
        "--envelope-only",
        "--signing-secret",
        TEST_SECRET,
      ],
      { stdout, stderr: new PassThrough(), clock: FIXED_CLOCK, newRequestId: FIXED_REQUEST_ID },
    );
    expect(code).toBe(0);
    const env = JSON.parse(read());
    expect(env).toMatchObject({
      kind: "ask",
      consumer: "atc-ui",
      endUser: "local:dev",
      timestamp: "2026-05-23T00:00:00.000Z",
      payload: { question: "x?" },
    });
    // Signature is hex SHA-256 → 64 hex chars.
    expect(env.signature).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects missing --question", async () => {
    const stderr = new PassThrough();
    const read = capture(stderr);
    const code = await devPublishCli(["--consumer", "x"], {
      stdout: new PassThrough(),
      stderr,
    });
    expect(code).toBe(2);
    expect(read()).toContain("--question is required");
  });

  it("rejects missing --signing-secret", async () => {
    // Make sure no env override leaks in from the host shell.
    const previous = process.env["ATC_DEV_CONSUMER_SECRET"];
    delete process.env["ATC_DEV_CONSUMER_SECRET"];
    try {
      const stderr = new PassThrough();
      const read = capture(stderr);
      const code = await devPublishCli(["--question", "x?"], {
        stdout: new PassThrough(),
        stderr,
      });
      expect(code).toBe(2);
      expect(read()).toContain("--signing-secret is required");
    } finally {
      if (previous !== undefined) process.env["ATC_DEV_CONSUMER_SECRET"] = previous;
    }
  });

  it("accepts $ATC_DEV_CONSUMER_SECRET as the signing key when --signing-secret is omitted", async () => {
    const previous = process.env["ATC_DEV_CONSUMER_SECRET"];
    process.env["ATC_DEV_CONSUMER_SECRET"] = "env-secret";
    try {
      const stdout = new PassThrough();
      const read = capture(stdout);
      const code = await devPublishCli(
        ["--question", "x?", "--envelope-only"],
        { stdout, stderr: new PassThrough(), clock: FIXED_CLOCK, newRequestId: FIXED_REQUEST_ID },
      );
      expect(code).toBe(0);
      const env = JSON.parse(read());
      expect(env.signature).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      if (previous === undefined) delete process.env["ATC_DEV_CONSUMER_SECRET"];
      else process.env["ATC_DEV_CONSUMER_SECRET"] = previous;
    }
  });

  it("rejects unknown flags", async () => {
    const stderr = new PassThrough();
    const read = capture(stderr);
    const code = await devPublishCli(["--bogus"], {
      stdout: new PassThrough(),
      stderr,
    });
    expect(code).toBe(2);
    // util.parseArgs phrases the rejection differently from the previous
    // hand-rolled parser; the test asserts on the flag name, not the prose.
    expect(read()).toContain("--bogus");
  });

  it("the RuntimeMessage output is shape-compatible with what runLocal expects", async () => {
    const stdout = new PassThrough();
    const read = capture(stdout);
    await devPublishCli(
      [
        "--question",
        "smoke?",
        "--audience",
        "codebase",
        "--scope-only",
        "--signing-secret",
        TEST_SECRET,
      ],
      { stdout, stderr: new PassThrough(), clock: FIXED_CLOCK, newRequestId: FIXED_REQUEST_ID },
    );
    const message = JSON.parse(read());
    expect(message.stage).toBe("init");
    expect(message.payload.request.scopeOnly).toBe(true);
    expect(message.payload.request.audience).toBe("codebase");
    expect(message.payload.envelope.kind).toBe("ask");
  });
});
