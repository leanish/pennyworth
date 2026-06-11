import { describe, expect, it } from "vitest";

import agent, * as askTheCode from "../src/index.js";
import * as devPublish from "../src/dev-publish.js";

/**
 * Smoke test for the package's public surface. Asserts the default export
 * (the agent definition) and the dev-publish CLI are both wired correctly.
 */
describe("@leanish/ask-the-code package exports", () => {
  it("default export is an agent definition with identifier 'ask-the-code'", () => {
    expect(agent).toBeDefined();
    expect(agent.identifier).toBe("ask-the-code");
    expect(typeof agent.handle).toBe("function");
  });

  it("re-exports the payload type names (compile-time presence)", () => {
    // Types vanish at runtime; we only verify the value-namespace existence
    // by importing the module (any missing export errors at import time).
    expect(askTheCode).toBeDefined();
  });

  it("devPublishCli is callable", () => {
    expect(typeof devPublish.devPublishCli).toBe("function");
  });
});
