import { describe, expect, it } from "vitest";

import { ClaudeRunner } from "../src/index.js";

describe("ClaudeRunner session reporting", () => {
  it("does not report a session id before it has run (self-assigned UUID is internal)", () => {
    expect(new ClaudeRunner().sessionId).toBeUndefined();
  });

  it("reports the provided id immediately when resuming (the session already exists)", () => {
    expect(new ClaudeRunner("11111111-2222-3333-4444-555555555555").sessionId).toBe(
      "11111111-2222-3333-4444-555555555555",
    );
  });
});
