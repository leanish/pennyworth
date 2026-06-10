import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { CodexRunner } from "../../src/skill/codex-runner.js";
import { SkillLoader } from "../../src/skill/skill-loader.js";
import type { LoadedSkill } from "../../src/skill/skill.js";

const ASK_FILE = `---
name: ask
description: Test
inputSchema: { type: object }
outputSchema: { type: object }
---

# ask
`;

async function makeAskSkill(): Promise<LoadedSkill> {
  const dir = await mkdtemp(join(tmpdir(), "agent-runtime-codex-runner-skill-"));
  await mkdir(join(dir, "ask"), { recursive: true });
  await writeFile(join(dir, "ask", "SKILL.md"), ASK_FILE);
  return new SkillLoader({ skillsDirs: [dir] }).loadEntrypoint("ask");
}

/**
 * Stub `codex` binary that records its `CODEX_HOME` + argv into a file and
 * emits the canned response. We use the recorded file later to verify the
 * staging-dir + flags handshake.
 */
async function makeFakeBin(recordFile: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agent-runtime-fake-codex-"));
  const script = join(dir, "codex");
  await writeFile(
    script,
    `#!/bin/sh
{
  echo "CODEX_HOME=$CODEX_HOME"
  echo "ARGS=$*"
} > "${recordFile}"
cat <<'EOF'
\`\`\`json
{"answer": "codex fake answer"}
\`\`\`
EOF
`,
  );
  await chmod(script, 0o755);
  return script;
}

describe("CodexRunner (against a stub binary)", () => {
  let askSkill: LoadedSkill;
  beforeAll(async () => {
    askSkill = await makeAskSkill();
  });

  it("stages skills, sets CODEX_HOME, passes the suppression flags, captures stdout", async () => {
    const recordFile = join(await mkdtemp(join(tmpdir(), "codex-record-")), "record.txt");
    const fakeBin = await makeFakeBin(recordFile);
    const runner = new CodexRunner({ bin: fakeBin });
    const result = await runner.run({
      entrypoint: askSkill,
      supportSkills: [],
      renderedArguments: "question: What does X do?",
      workingCopies: [],
    });
    expect(result.responseText).toContain('"answer": "codex fake answer"');

    const record = await readFile(recordFile, "utf8");
    // CODEX_HOME points at a temp dir the runner created.
    const codexHome = /CODEX_HOME=(.+)/.exec(record)?.[1] ?? "";
    expect(codexHome).toMatch(/agent-runtime-skill-/);
    // The canonical suppression flags appear in argv.
    expect(record).toMatch(/ARGS=exec --ignore-user-config -c project_doc_max_bytes=0/);
  });

  it("identifies itself as 'codex'", () => {
    const runner = new CodexRunner({ bin: "/nonexistent" });
    expect(runner.codingAgent).toBe("codex");
  });

  it("mounts the first working copy as cwd and the rest via --add-dir", async () => {
    const wc1 = await mkdtemp(join(tmpdir(), "codex-runner-wc1-"));
    const wc2 = await mkdtemp(join(tmpdir(), "codex-runner-wc2-"));
    const recordFile = join(await mkdtemp(join(tmpdir(), "codex-record-")), "record.txt");
    const fakeBin = await makeFakeBin(recordFile);
    const runner = new CodexRunner({ bin: fakeBin });
    await runner.run({
      entrypoint: askSkill,
      supportSkills: [],
      renderedArguments: "x: 1",
      workingCopies: [
        { projectId: "p1", path: wc1, branch: "main", headSha: "0".repeat(40) },
        { projectId: "p2", path: wc2, branch: "main", headSha: "0".repeat(40) },
      ],
    });
    const record = await readFile(recordFile, "utf8");
    expect(record).toContain(`--add-dir ${wc2}`);
  });

  it("wires `effort` through as `-c <effortConfigKey>=<value>` (default: model_reasoning_effort)", async () => {
    const recordFile = join(await mkdtemp(join(tmpdir(), "codex-record-")), "record.txt");
    const fakeBin = await makeFakeBin(recordFile);
    const runner = new CodexRunner({ bin: fakeBin });
    await runner.run({
      entrypoint: askSkill,
      supportSkills: [],
      renderedArguments: "x: 1",
      workingCopies: [],
      effort: "high",
    });
    const record = await readFile(recordFile, "utf8");
    expect(record).toContain("-c model_reasoning_effort=high");
  });

  it("honors a custom `effortConfigKey` (used to pin against the live CLI's key shape)", async () => {
    const recordFile = join(await mkdtemp(join(tmpdir(), "codex-record-")), "record.txt");
    const fakeBin = await makeFakeBin(recordFile);
    const runner = new CodexRunner({ bin: fakeBin, effortConfigKey: "reasoning_effort" });
    await runner.run({
      entrypoint: askSkill,
      supportSkills: [],
      renderedArguments: "x: 1",
      workingCopies: [],
      effort: "medium",
    });
    const record = await readFile(recordFile, "utf8");
    expect(record).toContain("-c reasoning_effort=medium");
    expect(record).not.toContain("model_reasoning_effort");
  });

  it("propagates non-zero exit codes as errors with stderr tail", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-runtime-failing-codex-"));
    const failingBin = join(dir, "codex");
    await writeFile(failingBin, `#!/bin/sh\necho "codex boom" >&2\nexit 9\n`);
    await chmod(failingBin, 0o755);

    const runner = new CodexRunner({ bin: failingBin });
    await expect(
      runner.run({
        entrypoint: askSkill,
        supportSkills: [],
        renderedArguments: "x: 1",
        workingCopies: [],
      }),
    ).rejects.toThrowError(/exited with code 9.*codex boom/);
  });
});
