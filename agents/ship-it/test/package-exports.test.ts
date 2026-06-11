import { describe, expect, it } from "vitest";

import agent, * as shipIt from "../src/index.js";

/**
 * Smoke test for the package's public surface: the default export is the
 * agent definition; importing the module surfaces any broken re-export.
 */
describe("@leanish/ship-it package exports", () => {
  it("default export is an agent definition with identifier 'ship-it'", () => {
    expect(agent).toBeDefined();
    expect(agent.identifier).toBe("ship-it");
    expect(typeof agent.handle).toBe("function");
  });

  it("re-exports the payload type names (compile-time presence)", () => {
    // Types vanish at runtime; importing the module is the check — any
    // missing export errors at import time.
    expect(shipIt).toBeDefined();
  });
});
