import { describe, expect, it } from "vitest";

import { actorPrompt, reviewerPrompt, synthesisPrompt } from "../src/index.js";

describe("reviewerPrompt (agent-1, read-only)", () => {
  it("opens with prompt-1 raw in read-only mode", () => {
    const p = reviewerPrompt({ prompt1: "which lib for serialization?", prompt2: undefined, resumed: false, siblingBody: undefined });
    expect(p).toBe("which lib for serialization?");
  });

  it("frames the opener as new guidance when resumed", () => {
    const p = reviewerPrompt({ prompt1: "consider perf too", prompt2: undefined, resumed: true, siblingBody: undefined });
    expect(p).toContain("New guidance from the human:");
  });

  it("on later read-only turns asks to agree/expand/correct the sibling", () => {
    const p = reviewerPrompt({ prompt1: "x", prompt2: undefined, resumed: false, siblingBody: "SIB" });
    expect(p).toBe("Your sibling agent says SIB; please agree, expand it or correct it");
  });

  it("in action mode the opener asks for a textual plan, not action", () => {
    const p = reviewerPrompt({ prompt1: "review the PR", prompt2: "handle the findings", resumed: false, siblingBody: undefined });
    expect(p).toContain('The user says "review the PR"');
    expect(p).toContain("textual form how you'd deal with it");
  });

  it("in action mode later agent-1 turns just relay the sibling (it only reviews)", () => {
    const p = reviewerPrompt({ prompt1: "review the PR", prompt2: "handle the findings", resumed: false, siblingBody: "DID X" });
    expect(p).toBe("Your sibling agent says DID X");
  });
});

describe("actorPrompt (agent-2)", () => {
  it("in action mode restates prompt-1 + prompt-2 and asks to act on agreed parts", () => {
    const p = actorPrompt({ prompt1: "review the PR", prompt2: "handle the findings", resumed: false, siblingBody: "FOUND Y", firstTurn: false });
    expect(p).toContain('The user says "review the PR"');
    expect(p).toContain("your sibling agent says FOUND Y");
    expect(p).toContain("please handle the findings on the parts you agree");
    // the verdict-block is appended by ClaudeRunner (CLI quirk), not baked into the prompt
    expect(p).not.toContain("```json");
  });

  it("in read-only mode the first turn carries prompt-1 plus the agree/expand/correct bridge", () => {
    const p = actorPrompt({ prompt1: "which lib?", prompt2: undefined, resumed: false, siblingBody: "LEAD", firstTurn: true });
    expect(p).toContain("which lib?");
    expect(p).toContain("Your sibling agent says LEAD; please agree, expand it or correct it");
  });

  it("in read-only mode later turns are just the bridge", () => {
    const p = actorPrompt({ prompt1: "which lib?", prompt2: undefined, resumed: false, siblingBody: "LEAD", firstTurn: false });
    expect(p).toBe("Your sibling agent says LEAD; please agree, expand it or correct it");
  });
});

describe("synthesisPrompt", () => {
  it("asks agent-2 to consolidate in read-only mode", () => {
    expect(synthesisPrompt(false)).toContain("consolidated");
  });

  it("asks agent-2 to report changed/not-changed/caveats in action mode", () => {
    const p = synthesisPrompt(true);
    expect(p).toContain("what you changed");
    expect(p).toContain("caveats");
  });
});
