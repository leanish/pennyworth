import { describe, expect, it } from "vitest";

import type {
  DocSet,
  DocumentItBreakdownPayload,
  DocumentItInitPayload,
  DocumentItPayload,
  VerifyDocsInput,
  VerifyDocsOutput,
} from "../src/index.js";
import agent from "../src/index.js";

describe("@leanish/document-it package exports", () => {
  it("default-exports the defineAgent handler", () => {
    expect(agent.identifier).toBe("document-it");
    expect(typeof agent.handle).toBe("function");
  });

  it("exports the per-stage payload and skill contract types", () => {
    // Compile-time anchors: if any of the type aliases below disappears
    // this test file fails to typecheck.
    const init: DocumentItInitPayload = {};
    const breakdown: DocumentItBreakdownPayload = { projectId: "acme/widgets" };
    const _example: DocumentItPayload = breakdown satisfies DocumentItPayload;

    const docSet: DocSet = { space: "WID", pageIds: ["101"], labels: ["docs"] };
    const input: VerifyDocsInput = {
      project: { id: "acme/widgets", source: { url: "https://github.com/acme/widgets.git" } },
      docSet,
    };
    const output: VerifyDocsOutput = {
      summary: "all good",
      inRepoDrift: [
        {
          type: "stale",
          location: "README.md",
          claim: "x",
          correction: "y",
          confidence: 1,
        },
      ],
      publishedDrift: [],
    };

    expect(init).toBeDefined();
    expect(_example).toBe(breakdown);
    expect(breakdown.projectId).toBe("acme/widgets");
    expect(input.docSet.space).toBe("WID");
    expect(output.inRepoDrift[0]?.type).toBe("stale");
    expect(output.pullRequest).toBeUndefined();
  });
});
