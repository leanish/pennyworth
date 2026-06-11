import { describe, expect, it } from "vitest";

import agent, * as pkg from "../src/index.js";
import type {
  BreakdownPayload,
  InitPayload,
  RevisitPayload,
  SecureItPayload,
} from "../src/index.js";

/**
 * Smoke test for the package's public surface: the default export is the
 * agent definition, the handler helpers are exported, and the per-stage
 * payload types compile.
 */
describe("@leanish/secure-it package exports", () => {
  it("default export is an agent definition with identifier 'secure-it'", () => {
    expect(agent).toBeDefined();
    expect(agent.identifier).toBe("secure-it");
    expect(typeof agent.handle).toBe("function");
  });

  it("exports the handler entry points", () => {
    expect(typeof pkg.handleSecureItMessage).toBe("function");
    expect(typeof pkg.isExplicitlyOptedIn).toBe("function");
    expect(pkg.CONSUMER_ID).toBe("secure-it");
  });

  it("exports the per-stage payload types (compile-time anchors)", () => {
    const init: InitPayload = {};
    const breakdown: BreakdownPayload = { projectId: "leanish/widget" };
    const revisit: RevisitPayload = {
      repo: "leanish/widget",
      branch: "secure-it/GHSA-x",
      alertRef: "GHSA-x",
      revisitCount: 0,
    };
    const union: SecureItPayload = init satisfies SecureItPayload;

    expect(init).toBeDefined();
    expect(breakdown.projectId).toBe("leanish/widget");
    expect(revisit.revisitCount).toBe(0);
    expect(union).toBe(init);
  });
});
