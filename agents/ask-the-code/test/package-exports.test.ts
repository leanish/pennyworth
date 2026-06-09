import { describe, expect, it } from "vitest";

import agent, * as atc from "../src/index.js";
import * as devPublish from "../src/dev-publish.js";

/**
 * Smoke test for the package's public surface. Asserts the default export
 * (the agent definition) and the dev-publish CLI are both wired correctly.
 */
describe("@leanish/agent-atc package exports", () => {
  it("default export is an agent definition with identifier 'atc'", () => {
    expect(agent).toBeDefined();
    expect(agent.identifier).toBe("atc");
    expect(typeof agent.handle).toBe("function");
  });

  it("re-exports the payload type names (compile-time presence)", () => {
    // Types vanish at runtime; we only verify the value-namespace existence
    // by importing the module (any missing export errors at import time).
    expect(atc).toBeDefined();
  });

  it("devPublishCli is callable", () => {
    expect(typeof devPublish.devPublishCli).toBe("function");
  });
});
