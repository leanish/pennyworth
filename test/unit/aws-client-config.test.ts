import { describe, expect, it } from "vitest";

import { awsClientDefaults } from "../../src/aws-mode/client-config.js";

describe("awsClientDefaults", () => {
  it("returns the canonical retry knobs", () => {
    const cfg = awsClientDefaults();
    expect(cfg.maxAttempts).toBe(5);
    expect(cfg.retryMode).toBe("adaptive");
  });

  it("returns a fresh object each call (no shared mutable state)", () => {
    const a = awsClientDefaults();
    const b = awsClientDefaults();
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });
});
