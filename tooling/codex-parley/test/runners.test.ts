import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import { ClaudeRunner, CodexRunner, MissingCliError } from "../src/index.js";

describe("subprocess runners", () => {
  it("extracts Claude verdict from structured_output", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "parley-claude-runner-"));
    await writeExecutable(
      join(tempDir, "claude"),
      [
        "#!/bin/sh",
        "printf '%s\\n' '{\"structured_output\":{\"status\":\"agree\",\"summary\":\"ok\",\"reason\":\"ok\",\"body\":\"structured body\"},\"result\":\"ignored prose\"}'",
      ].join("\n"),
    );
    const runner = new ClaudeRunner({ cwd: tempDir, env: withPath(tempDir) });

    const output = await runner.run({
      cli: "claude",
      prompt: "review",
      verbose: false,
    });

    expect(output.sessionId).toMatch(/[0-9a-f-]{36}/);
    expect(output.verdict.body).toBe("structured body");
  });

  it("extracts Codex thread id from JSONL and verdict from output-last-message file", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "parley-codex-runner-"));
    await writeExecutable(
      join(tempDir, "codex"),
      [
        "#!/bin/sh",
        "out=''",
        "while [ \"$#\" -gt 0 ]; do",
        "  if [ \"$1\" = '-o' ]; then",
        "    shift",
        "    out=\"$1\"",
        "  fi",
        "  shift",
        "done",
        "printf '%s\\n' '{\"type\":\"thread.started\",\"thread_id\":\"thread-123\"}'",
        "printf '%s\\n' '{\"status\":\"agree\",\"summary\":\"ok\",\"reason\":\"ok\",\"body\":\"codex body\"}' > \"$out\"",
      ].join("\n"),
    );
    const runner = new CodexRunner({ cwd: tempDir, env: withPath(tempDir) });

    const output = await runner.run({
      cli: "codex",
      prompt: "review",
      verbose: false,
    });

    expect(output.sessionId).toBe("thread-123");
    expect(output.verdict.body).toBe("codex body");
  });

  it("does not turn a missing Claude binary into a failed session", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "parley-missing-claude-"));
    const runner = new ClaudeRunner({ cwd: tempDir, env: { PATH: tempDir } });

    await expect(
      runner.run({
        cli: "claude",
        prompt: "review",
        verbose: false,
      }),
    ).rejects.toBeInstanceOf(MissingCliError);
  });

  it("keeps Claude's session id when structured output is malformed", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "parley-claude-malformed-"));
    await writeExecutable(join(tempDir, "claude"), ["#!/bin/sh", "printf '%s\\n' '{\"result\":\"missing structured output\"}'"].join("\n"));
    const runner = new ClaudeRunner({ cwd: tempDir, env: withPath(tempDir) });

    await expect(
      runner.run({
        cli: "claude",
        prompt: "review",
        verbose: false,
      }),
    ).rejects.toMatchObject({
      cli: "claude",
      sessionId: expect.stringMatching(/[0-9a-f-]{36}/),
    });
  });

  it("keeps Codex's captured session id when output-last-message is malformed", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "parley-codex-malformed-"));
    await writeExecutable(
      join(tempDir, "codex"),
      [
        "#!/bin/sh",
        "out=''",
        "while [ \"$#\" -gt 0 ]; do",
        "  if [ \"$1\" = '-o' ]; then",
        "    shift",
        "    out=\"$1\"",
        "  fi",
        "  shift",
        "done",
        "printf '%s\\n' '{\"type\":\"thread.started\",\"thread_id\":\"thread-456\"}'",
        "printf '%s\\n' 'not json' > \"$out\"",
      ].join("\n"),
    );
    const runner = new CodexRunner({ cwd: tempDir, env: withPath(tempDir) });

    await expect(
      runner.run({
        cli: "codex",
        prompt: "review",
        verbose: false,
      }),
    ).rejects.toMatchObject({
      cli: "codex",
      sessionId: "thread-456",
    });
  });

  it("keeps Claude's session id when stdout exceeds the capture limit", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "parley-claude-output-limit-"));
    await writeExecutable(
      join(tempDir, "claude"),
      [
        "#!/bin/sh",
        "i=0",
        "while [ \"$i\" -lt 5000 ]; do",
        "  printf '%01024d' 0",
        "  i=$((i + 1))",
        "done",
      ].join("\n"),
    );
    const runner = new ClaudeRunner({ cwd: tempDir, env: withPath(tempDir) });

    await expect(
      runner.run({
        cli: "claude",
        prompt: "review",
        verbose: false,
      }),
    ).rejects.toMatchObject({
      cli: "claude",
      sessionId: expect.stringMatching(/[0-9a-f-]{36}/),
    });
  });

  it("keeps Codex's captured session id when stdout exceeds the capture limit", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "parley-codex-output-limit-"));
    await writeExecutable(
      join(tempDir, "codex"),
      [
        "#!/bin/sh",
        "printf '%s\\n' '{\"type\":\"thread.started\",\"thread_id\":\"thread-limit\"}'",
        "i=0",
        "while [ \"$i\" -lt 5000 ]; do",
        "  printf '%01024d' 0",
        "  i=$((i + 1))",
        "done",
      ].join("\n"),
    );
    const runner = new CodexRunner({ cwd: tempDir, env: withPath(tempDir) });

    await expect(
      runner.run({
        cli: "codex",
        prompt: "review",
        verbose: false,
      }),
    ).rejects.toMatchObject({
      cli: "codex",
      sessionId: "thread-limit",
    });
  });
});

async function writeExecutable(path: string, content: string): Promise<void> {
  await writeFile(path, `${content}\n`, "utf8");
  await chmod(path, 0o755);
}

function withPath(dir: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: `${dir}${delimiter}${process.env.PATH ?? ""}`,
  };
}
