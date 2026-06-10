import { describe, expect, it } from "vitest";

import { AGENTS } from "../src/registry.js";

// CDK-free: exercises the agent registry (the deploy roster) without
// instantiating any aws-cdk-lib construct, so it runs in the fast gate.
describe("agent registry", () => {
  it("registers the ask-the-code agent with a descriptor path + ECR repo", () => {
    const askTheCode = AGENTS.find((a) => a.id === "ask-the-code");
    expect(askTheCode).toBeDefined();
    expect(askTheCode?.descriptorPath).toMatch(/ask-the-code\/agent\.yaml$/);
    expect(askTheCode?.ecrRepositoryName).toBe("leanish/agent-ask-the-code");
    expect(askTheCode?.imageTag.length).toBeGreaterThan(0);
  });

  it("has unique agent ids", () => {
    const ids = AGENTS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
