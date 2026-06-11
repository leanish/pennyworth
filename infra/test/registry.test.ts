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

  it("registers the ship-it agent with a descriptor path + ECR repo", () => {
    const shipIt = AGENTS.find((a) => a.id === "ship-it");
    expect(shipIt).toBeDefined();
    expect(shipIt?.descriptorPath).toMatch(/ship-it\/agent\.yaml$/);
    expect(shipIt?.ecrRepositoryName).toBe("leanish/agent-ship-it");
    expect(shipIt?.imageTag.length).toBeGreaterThan(0);
  });

  it("registers the secure-it agent with a descriptor path + ECR repo", () => {
    const secureIt = AGENTS.find((a) => a.id === "secure-it");
    expect(secureIt).toBeDefined();
    expect(secureIt?.descriptorPath).toMatch(/secure-it\/agent\.yaml$/);
    expect(secureIt?.ecrRepositoryName).toBe("leanish/agent-secure-it");
    expect(secureIt?.imageTag.length).toBeGreaterThan(0);
  });

  it("registers the ship-it agent with a descriptor path + ECR repo", () => {
    const shipIt = AGENTS.find((a) => a.id === "ship-it");
    expect(shipIt).toBeDefined();
    expect(shipIt?.descriptorPath).toMatch(/ship-it\/agent\.yaml$/);
    expect(shipIt?.ecrRepositoryName).toBe("leanish/agent-ship-it");
    expect(shipIt?.imageTag.length).toBeGreaterThan(0);
  });

  it("has unique agent ids", () => {
    const ids = AGENTS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
