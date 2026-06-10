import { describe, expect, it } from "vitest";

import { AGENTS } from "../src/registry.js";

// CDK-free: exercises the agent registry (the deploy roster) without
// instantiating any aws-cdk-lib construct, so it runs in the fast gate.
describe("agent registry", () => {
  it("registers the ask-the-code agent with a descriptor path + ECR repo", () => {
    const atc = AGENTS.find((a) => a.id === "atc");
    expect(atc).toBeDefined();
    expect(atc?.descriptorPath).toMatch(/ask-the-code\/agent\.yaml$/);
    expect(atc?.ecrRepositoryName).toBe("leanish/agent-atc");
    expect(atc?.imageTag.length).toBeGreaterThan(0);
  });

  it("registers the secure-it agent with a descriptor path + ECR repo", () => {
    const secureIt = AGENTS.find((a) => a.id === "secure-it");
    expect(secureIt).toBeDefined();
    expect(secureIt?.descriptorPath).toMatch(/secure-it\/agent\.yaml$/);
    expect(secureIt?.ecrRepositoryName).toBe("leanish/agent-secure-it");
    expect(secureIt?.imageTag.length).toBeGreaterThan(0);
  });

  it("has unique agent ids", () => {
    const ids = AGENTS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
