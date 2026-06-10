import { describe, expect, it } from "vitest";

import type {
  SecureitBreakdownPayload,
  SecureitInitPayload,
  SecureitPayload,
  SecureitRevisitPayload,
} from "../src/index.js";
import * as pkg from "../src/index.js";

describe("@leanish/secure-it package exports (phase-2 placeholder)", () => {
  it("exports the per-stage payload types but no runtime values", () => {
    // Compile-time anchors: if any of the type aliases below disappears
    // the test file fails to typecheck.
    const init: SecureitInitPayload = {};
    const breakdown: SecureitBreakdownPayload = { projectId: "leanish/atc" };
    const revisit: SecureitRevisitPayload = {
      repo: "leanish/atc",
      branch: "secureit/GHSA-x",
      alertRef: "GHSA-x",
      revisitCount: 0,
    };
    const _example: SecureitPayload = init satisfies SecureitPayload;

    // Use the values so unused-locals doesn't complain.
    expect(init).toBeDefined();
    expect(breakdown.projectId).toBe("leanish/atc");
    expect(revisit.revisitCount).toBe(0);
    expect(_example).toBe(init);

    // No `default` export today — the placeholder has no handler.
    // (Phase-2 will add one; this assertion catches an accidental
    // re-introduction.)
    expect((pkg as { default?: unknown }).default).toBeUndefined();
  });
});
