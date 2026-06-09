import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const describeIfRealCli = process.env["PARLEY_REAL_CLI_ACCEPTANCE"] === "1" ? describe : describe.skip;

describeIfRealCli("real CLI acceptance", () => {
  it("lets the actor edit a scratch working tree while returning schema-conforming verdicts", async () => {
    const repoRoot = resolve(import.meta.dirname, "..");
    const scratchDir = await mkdtemp(join(tmpdir(), "parley-real-cli-"));
    const taskFile = join(scratchDir, "task.txt");
    const resultPath = join(scratchDir, "result.json");
    const stepsPath = join(scratchDir, "steps.json");

    try {
      await writeFile(taskFile, "initial\n", "utf8");
      await execFileAsync("git", ["init"], {
        cwd: scratchDir,
        timeout: 30_000,
      });
      await execFileAsync(
        "node",
        [
          join(repoRoot, "dist/bin/parley.js"),
          "--rounds",
          "1",
          "--verbose",
          "--output",
          resultPath,
          "--steps-output",
          stepsPath,
          "Inspect task.txt. The acceptance marker line is `parley-real-acceptance`.",
          "If task.txt does not contain `parley-real-acceptance`, edit task.txt to add exactly that line. Then return agree.",
        ],
        {
          cwd: scratchDir,
          timeout: 600_000,
          maxBuffer: 10 * 1024 * 1024,
        },
      ).catch((error: unknown) => {
        if (isExpectedNonZeroParleyExit(error)) {
          return;
        }
        throw new Error(`parley acceptance command failed\n${commandOutput(error)}`);
      });

      const result = JSON.parse(await readFile(resultPath, "utf8")) as { status?: string };
      const steps = JSON.parse(await readFile(stepsPath, "utf8")) as unknown[];
      const edited = await readFile(taskFile, "utf8");

      expect(result.status).not.toBe("failed");
      expect(steps).toHaveLength(2);
      expect(edited).toContain("parley-real-acceptance");
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });
});

function isExpectedNonZeroParleyExit(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  return code === 2 || code === 3;
}

function commandOutput(error: unknown): string {
  if (typeof error !== "object" || error === null) {
    return String(error);
  }
  const record = error as { stdout?: unknown; stderr?: unknown; message?: unknown; code?: unknown };
  return [
    `code: ${String(record.code)}`,
    `message: ${String(record.message)}`,
    `stdout:\n${String(record.stdout ?? "")}`,
    `stderr:\n${String(record.stderr ?? "")}`,
  ].join("\n");
}
