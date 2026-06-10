import { describe, expect, it, vi } from "vitest";

import { ConflictException } from "@aws-sdk/client-scheduler";

import { createAwsSelfPublisher } from "../../src/self-publish/aws-self-publisher.js";
import { createLocalSelfPublisher, type LocalSelfPublishEntry } from "../../src/self-publish/local-self-publisher.js";
import {
  buildSelfMessageBody,
  canonicalJson,
  deriveScheduleName,
} from "../../src/self-publish/serialize.js";
import { ConsoleLogger } from "../../src/logger/console-logger.js";

const QUIET_LOGGER = new ConsoleLogger({ minLevel: "error" });

describe("canonicalJson", () => {
  it("sorts object keys recursively; arrays keep declared order", () => {
    const a = canonicalJson({ b: 1, a: { d: [2, 1], c: "x" } });
    const b = canonicalJson({ a: { c: "x", d: [2, 1] }, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":{"c":"x","d":[2,1]},"b":1}');
  });

  it("drops undefined-valued keys (JSON.stringify parity)", () => {
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
  });
});

describe("deriveScheduleName", () => {
  it("is stable across payload key order", () => {
    const n1 = deriveScheduleName({
      agentId: "secure-it",
      stage: "revisit",
      payload: { repo: "leanish/foo", alertRef: "GHSA-1" },
    });
    const n2 = deriveScheduleName({
      agentId: "secure-it",
      stage: "revisit",
      payload: { alertRef: "GHSA-1", repo: "leanish/foo" },
    });
    expect(n1).toBe(n2);
    expect(n1).toMatch(/^secure-it-[0-9a-f]{32}$/);
  });

  it("differs when the payload differs", () => {
    const base = { agentId: "secure-it", stage: "revisit" as const };
    const n1 = deriveScheduleName({ ...base, payload: { alertRef: "GHSA-1" } });
    const n2 = deriveScheduleName({ ...base, payload: { alertRef: "GHSA-2" } });
    expect(n1).not.toBe(n2);
  });
});

describe("buildSelfMessageBody", () => {
  it("stamps sourceTrigger self + provenance id + publish time", () => {
    const body = buildSelfMessageBody({
      stage: "breakdown",
      payload: { projectId: "p1" },
      clock: () => "2026-06-10T00:00:00.000Z",
    });
    expect(body.stage).toBe("breakdown");
    expect(body.payload).toEqual({ projectId: "p1" });
    expect(body.metadata.sourceTrigger).toBe("self");
    expect(body.metadata.publishedAt).toBe("2026-06-10T00:00:00.000Z");
    expect(body.metadata.requestId).toMatch(/[0-9a-f-]{36}/);
  });
});

describe("createLocalSelfPublisher", () => {
  it("appends publish + publishDelayed entries immediately (delay informational)", async () => {
    const queue: LocalSelfPublishEntry[] = [];
    const publisher = createLocalSelfPublisher(queue);
    await publisher.publish({ stage: "breakdown", payload: { projectId: "p1" } });
    await publisher.publishDelayed({
      stage: "revisit",
      payload: { alertRef: "GHSA-1" },
      afterSeconds: 3600,
    });
    expect(queue).toHaveLength(2);
    expect(queue[0]?.body.stage).toBe("breakdown");
    expect(queue[0]?.afterSeconds).toBeUndefined();
    expect(queue[1]?.body.stage).toBe("revisit");
    expect(queue[1]?.afterSeconds).toBe(3600);
  });
});

describe("createAwsSelfPublisher", () => {
  const baseOptions = {
    agentId: "secure-it",
    queueUrl: "https://sqs.us-east-1.amazonaws.com/000000000000/secure-it-requests",
    queueArn: "arn:aws:sqs:us-east-1:000000000000:secure-it-requests",
    scheduleGroupName: "leanish-agent-secure-it",
    schedulerRoleArn: "arn:aws:iam::000000000000:role/secure-it-scheduler",
    region: "us-east-1",
    logger: QUIET_LOGGER,
    clock: () => new Date("2026-06-10T12:00:00.000Z"),
  };

  it("publish sends a serialised self message to the own queue", async () => {
    const send = vi.fn(async (_cmd: unknown) => ({}));
    const publisher = createAwsSelfPublisher({
      ...baseOptions,
      sqsClient: { send } as never,
      schedulerClient: { send: vi.fn() } as never,
    });
    await publisher.publish({ stage: "breakdown", payload: { projectId: "p1" } });
    expect(send).toHaveBeenCalledTimes(1);
    const command = send.mock.calls[0]?.[0] as { input: { QueueUrl: string; MessageBody: string } };
    expect(command.input.QueueUrl).toBe(baseOptions.queueUrl);
    const body = JSON.parse(command.input.MessageBody) as {
      stage: string;
      payload: unknown;
      metadata: { sourceTrigger: string };
    };
    expect(body.stage).toBe("breakdown");
    expect(body.payload).toEqual({ projectId: "p1" });
    expect(body.metadata.sourceTrigger).toBe("self");
  });

  it("publishDelayed creates a one-shot schedule per ADR-0011", async () => {
    const send = vi.fn(async (_cmd: unknown) => ({}));
    const publisher = createAwsSelfPublisher({
      ...baseOptions,
      sqsClient: { send: vi.fn() } as never,
      schedulerClient: { send } as never,
    });
    await publisher.publishDelayed({
      stage: "revisit",
      payload: { alertRef: "GHSA-1" },
      afterSeconds: 3600,
    });
    expect(send).toHaveBeenCalledTimes(1);
    const command = send.mock.calls[0]?.[0] as {
      input: {
        Name: string;
        GroupName: string;
        ScheduleExpression: string;
        FlexibleTimeWindow: { Mode: string };
        ActionAfterCompletion: string;
        Target: { Arn: string; RoleArn: string; Input: string };
      };
    };
    expect(command.input.Name).toMatch(/^secure-it-[0-9a-f]{32}$/);
    expect(command.input.GroupName).toBe(baseOptions.scheduleGroupName);
    expect(command.input.ScheduleExpression).toBe("at(2026-06-10T13:00:00)");
    expect(command.input.FlexibleTimeWindow.Mode).toBe("OFF");
    expect(command.input.ActionAfterCompletion).toBe("DELETE");
    expect(command.input.Target.Arn).toBe(baseOptions.queueArn);
    expect(command.input.Target.RoleArn).toBe(baseOptions.schedulerRoleArn);
    const body = JSON.parse(command.input.Target.Input) as { stage: string };
    expect(body.stage).toBe("revisit");
  });

  it("treats ConflictException as deduped success", async () => {
    const send = vi.fn(async () => {
      throw new ConflictException({ message: "exists", $metadata: {} } as never);
    });
    const publisher = createAwsSelfPublisher({
      ...baseOptions,
      sqsClient: { send: vi.fn() } as never,
      schedulerClient: { send } as never,
    });
    await expect(
      publisher.publishDelayed({
        stage: "revisit",
        payload: { alertRef: "GHSA-1" },
        afterSeconds: 3600,
      }),
    ).resolves.toBeUndefined();
  });

  it("propagates non-conflict scheduler errors", async () => {
    const send = vi.fn(async () => {
      throw new Error("throttled");
    });
    const publisher = createAwsSelfPublisher({
      ...baseOptions,
      sqsClient: { send: vi.fn() } as never,
      schedulerClient: { send } as never,
    });
    await expect(
      publisher.publishDelayed({ stage: "revisit", payload: {}, afterSeconds: 60 }),
    ).rejects.toThrow("throttled");
  });
});
