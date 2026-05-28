import { describe, it, expect } from "vitest";
import { buildDraftingPrompt } from "../../src/drafting-prompt.js";

describe("buildDraftingPrompt", () => {
  it("includes the id, section conventions, and the fenced-block instruction", () => {
    const p = buildDraftingPrompt({ id: "leanish/foo" });
    expect(p).toContain("leanish/foo");
    expect(p).toMatch(/what this agent does/i);
    expect(p).toMatch(/```markdown/);
  });
  it("includes GitHub metadata when provided", () => {
    const p = buildDraftingPrompt({ id: "leanish/foo", githubMeta: { description: "Does X", topics: ["t1"] } });
    expect(p).toContain("Does X");
    expect(p).toContain("t1");
  });
});
