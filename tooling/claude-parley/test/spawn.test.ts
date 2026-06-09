import { describe, expect, it } from "vitest";

import { spawnCapture } from "../src/agents/spawn.js";

describe("spawnCapture", () => {
  it("captures multibyte UTF-8 output intact across chunk boundaries", async () => {
    const unit = "🚀café—naïve—😀"; // mix of 2-, 3-, and 4-byte UTF-8 sequences
    const count = 5000; // ~100 KB forces multiple stdout chunks, splitting characters mid-sequence
    const program = `process.stdout.write(${JSON.stringify(unit)}.repeat(${count}))`;
    const res = await spawnCapture(process.execPath, ["-e", program]);
    expect(res.code).toBe(0);
    expect(res.stdout).toBe(unit.repeat(count));
    expect(res.stdout).not.toContain("�"); // no replacement characters
  });

  it("rejects with a friendly message when the binary is missing", async () => {
    await expect(spawnCapture("definitely-not-a-real-binary-xyz", [])).rejects.toThrow(
      /not found on PATH/,
    );
  });
});
