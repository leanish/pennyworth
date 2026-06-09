import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/index.js";
import { scriptedRunners, verdict } from "./helpers.js";

describe("runCli", () => {
  it("writes result and steps files", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "parley-cli-test-"));
    const resultPath = join(tempDir, "result.json");
    const stepsPath = join(tempDir, "steps.json");
    const { runners } = scriptedRunners({
      codex: [verdict("agree")],
      claude: [verdict("agree", "done")],
    });
    const stdout = new BufferSink();
    const stderr = new BufferSink();

    try {
      const code = await runCli(
        ["--output", resultPath, "--steps-output", stepsPath, "review this"],
        { stdout, stderr },
        { createRunners: () => runners },
      );

      expect(code).toBe(0);
      expect(stderr.value).toBe("");
      expect(stdout.value).toContain("status: settled");
      expect(JSON.parse(await readFile(resultPath, "utf8"))).toMatchObject({
        status: "settled",
        roundsExecuted: 1,
      });
      expect(JSON.parse(await readFile(stepsPath, "utf8"))).toHaveLength(2);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("returns usage error for invalid rounds", async () => {
    const stdout = new BufferSink();
    const stderr = new BufferSink();

    const code = await runCli(["--rounds", "0", "review this"], { stdout, stderr }, { createRunners: () => scriptedRunners({}).runners });

    expect(code).toBe(1);
    expect(stderr.value).toContain("--rounds must be a positive integer");
  });

  it("prints help with exit code 0", async () => {
    const stdout = new BufferSink();
    const stderr = new BufferSink();

    const code = await runCli(["--help"], { stdout, stderr });

    expect(code).toBe(0);
    expect(stdout.value).toContain("Usage: parley");
    expect(stderr.value).toBe("");
  });
});

class BufferSink {
  value = "";

  write(message: string | Uint8Array): boolean {
    this.value += typeof message === "string" ? message : Buffer.from(message).toString("utf8");
    return true;
  }
}
