import { describe, expect, it, vi } from "vitest";

import { dispatch } from "../../src/dispatch/dispatch.js";
import { UnhandledStageError } from "../../src/errors.js";
import type { AgentDefinition } from "../../src/types/agent.js";
import type { AgentDescriptor } from "../../src/types/descriptor.js";
import type { Runtime } from "../../src/types/runtime.js";
import type { RuntimeMessage } from "../../src/types/runtime-message.js";

const DESCRIPTOR: AgentDescriptor = {
  identifier: "atc",
  compute: "lambda",
  triggers: [
    { type: "consumer", queueArnRef: "q", dlqArnRef: "dlq", signedEnvelope: true },
  ],
  stages: ["init"],
  codingAgent: "claude-code",
  model: "claude-sonnet-4-6",
  skills: { entrypoints: ["ask"], support: [] },
  needs: [],
  extensions: {},
};

const RUNTIME = {} as Runtime;

function makeMessage(overrides: Partial<RuntimeMessage> = {}): RuntimeMessage {
  return {
    stage: "init",
    payload: {},
    metadata: {
      receivedAt: "2026-05-22T00:00:00.000Z",
      sourceTrigger: "consumer",
      requestId: "msg-1",
    },
    ...overrides,
  };
}

describe("dispatch", () => {
  it("calls handle when the stage is declared", async () => {
    const handle = vi.fn(async () => {});
    const agent: AgentDefinition = { identifier: "atc", handle };
    await dispatch(agent, DESCRIPTOR, RUNTIME, makeMessage());
    expect(handle).toHaveBeenCalledOnce();
  });

  it("throws UnhandledStageError when the stage isn't declared", async () => {
    const handle = vi.fn(async () => {});
    const agent: AgentDefinition = { identifier: "atc", handle };
    await expect(
      dispatch(agent, DESCRIPTOR, RUNTIME, makeMessage({ stage: "breakdown" })),
    ).rejects.toBeInstanceOf(UnhandledStageError);
    expect(handle).not.toHaveBeenCalled();
  });

  it("treats a non-canonical stage value as UnhandledStageError", async () => {
    const agent: AgentDefinition = { identifier: "atc", handle: vi.fn(async () => {}) };
    await expect(
      // @ts-expect-error — deliberately pushing a value the type rejects.
      dispatch(agent, DESCRIPTOR, RUNTIME, makeMessage({ stage: "finalize" })),
    ).rejects.toBeInstanceOf(UnhandledStageError);
  });

  it("propagates handler errors to the caller", async () => {
    const agent: AgentDefinition = {
      identifier: "atc",
      async handle() {
        throw new Error("boom");
      },
    };
    await expect(dispatch(agent, DESCRIPTOR, RUNTIME, makeMessage())).rejects.toThrowError(
      "boom",
    );
  });
});
