import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  SCRUBBED_AWS_ENV_VARS,
  scrubbedProcessEnv,
  spawnCapture,
} from "../../src/skill/spawn-capture.js";

/**
 * Fake binary that prints selected env vars, so we can assert what the
 * subprocess actually saw: the AWS credential scrub, the per-invocation
 * merge, and the secret redaction of captured output.
 */
let envEchoBin: string;

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "spawn-capture-env-"));
  envEchoBin = join(dir, "env-echo");
  await writeFile(
    envEchoBin,
    `#!/bin/sh
echo "AWS_ACCESS_KEY_ID=[$AWS_ACCESS_KEY_ID]"
echo "AWS_PROFILE=[$AWS_PROFILE]"
echo "MY_TOKEN=[$MY_TOKEN]"
echo "KEPT_VAR=[$KEPT_VAR]"
`,
  );
  await chmod(envEchoBin, 0o755);
});

const TOUCHED = ["AWS_ACCESS_KEY_ID", "AWS_PROFILE", "KEPT_VAR"] as const;
const saved = new Map<string, string | undefined>();

function setProcessEnv(name: string, value: string): void {
  if (!saved.has(name)) saved.set(name, process.env[name]);
  process.env[name] = value;
}

afterEach(() => {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  saved.clear();
});

function capture(env: Record<string, string>, secrets?: { name: string; value: string }[]) {
  return spawnCapture({
    bin: envEchoBin,
    args: [],
    cwd: tmpdir(),
    env,
    timeoutMs: 10_000,
    captureCapBytes: 1024 * 1024,
    label: "EnvEchoTest",
    ...(secrets !== undefined ? { secrets } : {}),
  });
}

describe("spawnCapture subprocess env", () => {
  it("scrubs AWS credential vars from the inherited base", async () => {
    for (const name of TOUCHED) setProcessEnv(name, `leak-${name}`);
    const result = await capture({});
    expect(result.responseText).toContain("AWS_ACCESS_KEY_ID=[]");
    expect(result.responseText).toContain("AWS_PROFILE=[]");
    // Non-credential vars still inherit.
    expect(result.responseText).toContain("KEPT_VAR=[leak-KEPT_VAR]");
  });

  it("lets explicit options.env re-add scrubbed vars (deliberate operator override)", async () => {
    setProcessEnv("AWS_ACCESS_KEY_ID", "ambient");
    const result = await capture({ AWS_ACCESS_KEY_ID: "deliberate" });
    expect(result.responseText).toContain("AWS_ACCESS_KEY_ID=[deliberate]");
  });

  it("redacts secret values from captured stdout", async () => {
    const result = await capture({ MY_TOKEN: "s3cr3t-value" }, [
      { name: "MY_TOKEN", value: "s3cr3t-value" },
    ]);
    expect(result.responseText).toContain("MY_TOKEN=[<redacted:MY_TOKEN>]");
    expect(result.responseText).not.toContain("s3cr3t-value");
  });

  it("scrubbedProcessEnv removes exactly the documented set", () => {
    for (const name of SCRUBBED_AWS_ENV_VARS) setProcessEnv(name, "x");
    const env = scrubbedProcessEnv();
    for (const name of SCRUBBED_AWS_ENV_VARS) {
      expect(env[name]).toBeUndefined();
    }
  });
});
