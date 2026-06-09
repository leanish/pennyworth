import { InMemoryCatalog } from "@leanish/catalogit";
import { describe, expect, it } from "vitest";

import { MissingNeedError } from "../../src/errors.js";
import { ConsoleLogger } from "../../src/logger/console-logger.js";
import { needSpecs, wireClients } from "../../src/needs/index.js";
import { buildRuntime } from "../../src/runtime/build-runtime.js";
import { FakeCodingAgentRunner } from "../../src/skill/fake-runner.js";
import type { AgentDescriptor } from "../../src/types/descriptor.js";
import { InMemoryWorkspace } from "../../src/working-copy/in-memory-workspace.js";

const QUIET_LOGGER = new ConsoleLogger({ minLevel: "error" });

const DESCRIPTOR: AgentDescriptor = {
  identifier: "atc",
  compute: "lambda",
  triggers: [{ type: "consumer", queueArnRef: "q", dlqArnRef: "dlq", signedEnvelope: true }],
  stages: ["init"],
  codingAgent: "claude-code",
  model: "m",
  skills: { entrypoints: ["ask"], support: [] },
  needs: ["eventbridge", "sqs"],
  extensions: {},
};

describe("needs registry", () => {
  it("contains the phase-1 needs", () => {
    expect(needSpecs.has("eventbridge")).toBe(true);
    expect(needSpecs.has("sqs")).toBe(true);
    expect(needSpecs.has("s3")).toBe(true);
    expect(needSpecs.has("github")).toBe(true);
  });

  it("wireClients (local mode) produces working stubs for declared needs", async () => {
    const clients = wireClients({
      mode: "local",
      needs: ["eventbridge", "sqs"],
      env: { EVENT_BUS_NAME: "test-bus" },
      region: "us-east-1",
      logger: QUIET_LOGGER,
    });
    const result = await clients.eventbridge!.putEvents({
      entries: [{ source: "test", detailType: "x", detail: { y: 1 } }],
    });
    expect(result.failedCount).toBe(0);
    const sm = await clients.sqs!.sendMessage({
      queueArn: "arn:aws:sqs:us-east-1:000000000000:replies",
      body: "{}",
    });
    expect(sm.messageId.length).toBeGreaterThan(0);
  });

  it("wireClients throws MissingNeedError on undeclared access", () => {
    const clients = wireClients({
      mode: "local",
      needs: ["eventbridge"],
      env: { EVENT_BUS_NAME: "test-bus" },
      region: "us-east-1",
      logger: QUIET_LOGGER,
    });
    // The Proxy throws at runtime even though `clients.sqs` is typed as
    // optional (`SqsClient | undefined`). Reaching for an undeclared need
    // is a developer-error path; the throw is what we're asserting on.
    expect(() => clients.sqs).toThrowError(MissingNeedError);
  });
});

describe("buildRuntime needs gating", () => {
  it("throws MissingNeedError when a handler reaches for an undeclared client", async () => {
    const runtime = await buildRuntime({
      descriptor: { ...DESCRIPTOR, needs: ["eventbridge"] },
      catalog: new InMemoryCatalog([]),
      workspace: new InMemoryWorkspace(),
      runners: new Map([["claude-code", new FakeCodingAgentRunner("claude-code")]]),
      clients: {},
      logger: QUIET_LOGGER,
      skipCompatCheck: true,
    });
    // Same shape as above: type-level optional, runtime-level throw.
    expect(() => runtime.clients.sqs).toThrowError(MissingNeedError);
  });

  it("returns the wired client for declared needs", async () => {
    const clients = wireClients({
      mode: "local",
      needs: ["eventbridge"],
      env: { EVENT_BUS_NAME: "test-bus" },
      region: "us-east-1",
      logger: QUIET_LOGGER,
    });
    const runtime = await buildRuntime({
      descriptor: { ...DESCRIPTOR, needs: ["eventbridge"] },
      catalog: new InMemoryCatalog([]),
      workspace: new InMemoryWorkspace(),
      runners: new Map([["claude-code", new FakeCodingAgentRunner("claude-code")]]),
      clients,
      logger: QUIET_LOGGER,
      skipCompatCheck: true,
    });
    expect(runtime.clients.eventbridge).toBeDefined();
  });
});
