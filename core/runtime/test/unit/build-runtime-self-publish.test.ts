import { describe, expect, it } from "vitest";

import { InMemoryCatalog } from "@leanish/catalog-it";

import { buildRuntime } from "../../src/runtime/build-runtime.js";
import { SelfPublishNotConfiguredError } from "../../src/errors.js";
import { ConsoleLogger } from "../../src/logger/console-logger.js";
import { FakeCodingAgentRunner } from "../../src/skill/fake-runner.js";
import { createLocalSelfPublisher, type LocalSelfPublishEntry } from "../../src/self-publish/local-self-publisher.js";
import { InMemoryWorkspace } from "../../src/working-copy/in-memory-workspace.js";
import { wireClients } from "../../src/needs/wire-clients.js";
import type { AgentDescriptor } from "../../src/types/descriptor.js";

const QUIET_LOGGER = new ConsoleLogger({ minLevel: "error" });

const DESCRIPTOR: AgentDescriptor = {
  identifier: "bump-it",
  compute: "lambda",
  triggers: [{ type: "consumer", queueArnRef: "q", dlqArnRef: "dlq", signedEnvelope: false }],
  stages: ["init", "breakdown", "revisit"],
  codingAgent: "claude-code",
  model: "m",
  skills: { entrypoints: ["bump-it"], support: [] },
  needs: [],
  extensions: {},
};

function baseOptions() {
  return {
    descriptor: DESCRIPTOR,
    catalog: new InMemoryCatalog([]),
    workspace: new InMemoryWorkspace(),
    runners: new Map([["claude-code", new FakeCodingAgentRunner("claude-code")]]),
    clients: {},
    logger: QUIET_LOGGER,
    skipCompatCheck: true,
  };
}

describe("buildRuntime self-publish wiring", () => {
  it("throws SelfPublishNotConfiguredError when no SelfPublisher is wired", async () => {
    const runtime = await buildRuntime(baseOptions());
    await expect(
      runtime.publish({ stage: "breakdown", payload: { projectId: "p1" } }),
    ).rejects.toBeInstanceOf(SelfPublishNotConfiguredError);
    await expect(
      runtime.publishDelayed({ stage: "revisit", payload: {}, afterSeconds: 60 }),
    ).rejects.toBeInstanceOf(SelfPublishNotConfiguredError);
  });

  it("delegates to the configured SelfPublisher", async () => {
    const queue: LocalSelfPublishEntry[] = [];
    const runtime = await buildRuntime({
      ...baseOptions(),
      selfPublisher: createLocalSelfPublisher(queue),
    });
    await runtime.publish({ stage: "breakdown", payload: { projectId: "p1" } });
    await runtime.publishDelayed({
      stage: "revisit",
      payload: { alertRef: "GHSA-1" },
      afterSeconds: 1800,
    });
    expect(queue).toHaveLength(2);
    expect(queue[0]?.body.stage).toBe("breakdown");
    expect(queue[1]?.afterSeconds).toBe(1800);
  });
});

describe("jira need registration", () => {
  it("wires the placeholder jira client when declared", () => {
    const clients = wireClients({
      mode: "local",
      needs: ["jira"],
      env: {},
      region: "us-east-1",
      logger: QUIET_LOGGER,
    });
    expect(clients.jira).toEqual({ kind: "jira" });
  });
});
