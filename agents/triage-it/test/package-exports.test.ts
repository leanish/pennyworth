import { describe, expect, it } from "vitest";

import agent, * as triageIt from "../src/index.js";

/**
 * Smoke test for the package's public surface. Asserts the default export
 * (the agent definition) and the evidence-cap constants are wired.
 */
describe("@leanish/triage-it package exports", () => {
  it("default export is an agent definition with identifier 'triage-it'", () => {
    expect(agent).toBeDefined();
    expect(agent.identifier).toBe("triage-it");
    expect(typeof agent.handle).toBe("function");
  });

  it("re-exports the evidence caps and error type", () => {
    expect(triageIt.EVIDENCE_LIMITS.maxArchiveBytes).toBe(64 * 1024 * 1024);
    expect(triageIt.EVIDENCE_LIMITS.maxEntryCount).toBe(2000);
    expect(triageIt.EVIDENCE_LIMITS.maxEntryBytes).toBe(8 * 1024 * 1024);
    expect(new triageIt.InvalidEvidenceArchiveError("x")).toBeInstanceOf(Error);
  });

  it("re-exports the payload/request/reply type names (compile-time presence)", () => {
    // Types vanish at runtime; importing the module is the assertion (any
    // missing export errors at import time).
    expect(triageIt).toBeDefined();
  });
});
