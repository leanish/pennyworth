import { describe, expect, it } from "vitest";

import { ExecutionResolveError } from "../../src/errors.js";
import { createExecutionHelper } from "../../src/execution/resolve.js";
import type { AgentDescriptor } from "../../src/types/descriptor.js";

const DESCRIPTOR: AgentDescriptor = {
  identifier: "atc",
  compute: "lambda",
  triggers: [{ type: "consumer", queueArnRef: "q", dlqArnRef: "dlq", signedEnvelope: true }],
  stages: ["init"],
  codingAgent: "claude-code",
  model: "claude-sonnet-4-6",
  effort: "medium",
  skills: { entrypoints: ["ask"], support: [] },
  needs: [],
  extensions: {},
};

const helper = createExecutionHelper(DESCRIPTOR, {
  knownCodingAgents: new Set(["claude-code", "codex"]),
});

describe("createExecutionHelper", () => {
  it("returns descriptor defaults when nothing is overridden", () => {
    expect(helper.resolve(undefined)).toEqual({
      codingAgent: "claude-code",
      model: "claude-sonnet-4-6",
      effort: "medium",
    });
  });

  it("merges per-payload overrides with descriptor defaults", () => {
    expect(helper.resolve({ model: "claude-sonnet-4-7" })).toEqual({
      codingAgent: "claude-code",
      model: "claude-sonnet-4-7",
      effort: "medium",
    });
  });

  it("rejects unknown coding agents loudly", () => {
    expect(() => helper.resolve({ codingAgent: "bogus" })).toThrowError(
      ExecutionResolveError,
    );
  });

  it("rejects invalid effort enum values", () => {
    expect(() =>
      helper.resolve({ effort: "extreme" as never }),
    ).toThrowError(ExecutionResolveError);
  });
});
