import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { loadDescriptorFromFile } from "@leanish/runtime/lambda";

const agentYamlPath = join(dirname(fileURLToPath(import.meta.url)), "..", "agent.yaml");

describe("triage-it agent.yaml", () => {
  it("parses with the default (phase-1) descriptor rules", async () => {
    const descriptor = await loadDescriptorFromFile(agentYamlPath);

    expect(descriptor.identifier).toBe("triage-it");
    expect(descriptor.compute).toBe("lambda");
    expect(descriptor.stages).toEqual(["init"]);
    expect(descriptor.codingAgent).toBe("claude-code");
    expect(descriptor.model).toBe("claude-sonnet-4-6");
    expect(descriptor.skills.entrypoints).toEqual(["triage"]);
    expect(descriptor.skills.support).toEqual(["karpathy-guidelines"]);
    expect(descriptor.needs).toEqual(["s3", "sqs", "eventbridge", "target-credentials"]);

    expect(descriptor.triggers).toEqual([
      {
        type: "consumer",
        queueArnRef: "triage-it-requests",
        dlqArnRef: "triage-it-requests-dlq",
        signedEnvelope: true,
      },
    ]);
  });
});
