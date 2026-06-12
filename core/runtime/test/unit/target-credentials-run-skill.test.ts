import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { InMemoryCatalog, type Project } from "@leanish/catalog-it";

import { TargetCredentialsError } from "../../src/errors.js";
import { ConsoleLogger } from "../../src/logger/console-logger.js";
import { buildRuntime } from "../../src/runtime/build-runtime.js";
import { FakeCodingAgentRunner } from "../../src/skill/fake-runner.js";
import { SsmProvider, type SsmApi } from "../../src/target-credentials/providers/ssm.js";
import { createTargetCredentialsResolver } from "../../src/target-credentials/resolver.js";
import type { AgentDescriptor } from "../../src/types/descriptor.js";
import type { WorkingCopy } from "../../src/types/working-copy.js";
import { InMemoryWorkspace } from "../../src/working-copy/in-memory-workspace.js";

const QUIET_LOGGER = new ConsoleLogger({ minLevel: "error" });

const SKILL_FILE = `---
name: probe
description: Test
inputSchema: { type: object }
outputSchema: { type: object }
---

# probe
`;

let skillsDir: string;

beforeAll(async () => {
  skillsDir = await mkdtemp(join(tmpdir(), "target-credentials-skills-"));
  await mkdir(join(skillsDir, "probe"), { recursive: true });
  await writeFile(join(skillsDir, "probe", "SKILL.md"), SKILL_FILE);
});

function descriptor(needs: string[]): AgentDescriptor {
  return {
    identifier: "probe-agent",
    compute: "lambda",
    triggers: [{ type: "consumer", queueArnRef: "q", dlqArnRef: "dlq", signedEnvelope: false }],
    stages: ["init"],
    codingAgent: "claude-code",
    model: "m",
    skills: { entrypoints: ["probe"], support: [] },
    needs,
    extensions: {},
  };
}

const PROJECT: Project = {
  id: "acme/app",
  source: { url: "https://github.com/acme/app.git", branch: "main" },
  extensions: {
    credentials: [
      {
        provider: "ssm",
        parameter: "/leanish/projects/acme/app/credentials/NPM_TOKEN",
        env: "NPM_TOKEN",
      },
    ],
  },
};

const WORKING_COPY: WorkingCopy = {
  projectId: "acme/app",
  path: "/tmp/acme-app",
  branch: "main",
  headSha: "abc123",
};

const SSM_API: SsmApi = {
  async getParameter(name) {
    return { value: `value-of:${name}` };
  },
};

function fakeRunner(): FakeCodingAgentRunner {
  const runner = new FakeCodingAgentRunner("claude-code");
  runner.register("probe", () => ({ responseText: '```json\n{"ok": true}\n```' }));
  return runner;
}

async function runtimeWith(args: {
  needs: string[];
  wireResolver: boolean;
}): Promise<{ runner: FakeCodingAgentRunner; runSkill: () => Promise<unknown> }> {
  const catalog = new InMemoryCatalog([PROJECT]);
  const runner = fakeRunner();
  const runtime = await buildRuntime({
    descriptor: descriptor(args.needs),
    catalog,
    workspace: new InMemoryWorkspace(),
    runners: new Map([["claude-code", runner]]),
    clients: {},
    logger: QUIET_LOGGER,
    skillsDirs: [skillsDir],
    skipCompatCheck: true,
    ...(args.wireResolver
      ? {
          targetCredentials: createTargetCredentialsResolver({
            catalog,
            mode: "local",
            region: "us-east-1",
            logger: QUIET_LOGGER,
            ssmProvider: new SsmProvider({ region: "us-east-1", api: SSM_API }),
          }),
        }
      : {}),
  });
  return {
    runner,
    runSkill: () =>
      runtime.runSkill({ entrypoint: "probe", input: {}, workingCopies: [WORKING_COPY] }),
  };
}

describe("runSkill target-credentials threading", () => {
  it("injects resolved env + secrets into the invocation when the need is declared", async () => {
    const { runner, runSkill } = await runtimeWith({
      needs: ["target-credentials"],
      wireResolver: true,
    });
    await runSkill();
    expect(runner.invocations).toHaveLength(1);
    expect(runner.invocations[0]?.env).toEqual({
      NPM_TOKEN: "value-of:/leanish/projects/acme/app/credentials/NPM_TOKEN",
    });
    expect(runner.invocations[0]?.secrets).toEqual([
      { name: "NPM_TOKEN", value: "value-of:/leanish/projects/acme/app/credentials/NPM_TOKEN" },
    ]);
  });

  it("throws not-configured when the need is declared but no resolver is wired", async () => {
    const { runSkill } = await runtimeWith({ needs: ["target-credentials"], wireResolver: false });
    try {
      await runSkill();
      expect.unreachable("expected TargetCredentialsError");
    } catch (err) {
      expect(err).toBeInstanceOf(TargetCredentialsError);
      expect((err as TargetCredentialsError).reason).toBe("not-configured");
    }
  });

  it("never resolves when the need is not declared, even with a resolver wired", async () => {
    const { runner, runSkill } = await runtimeWith({ needs: [], wireResolver: true });
    await runSkill();
    expect(runner.invocations[0]?.env).toBeUndefined();
    expect(runner.invocations[0]?.secrets).toBeUndefined();
  });
});
