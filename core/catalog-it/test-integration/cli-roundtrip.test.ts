import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { S3Client } from "@aws-sdk/client-s3";

import { catalogitCli, parseProjectYaml, publishCatalog, type Project } from "../src/index.js";
import {
  createS3TestClient,
  createTestBucket,
  emptyAndDeleteBucket,
  localStackEndpoint,
  requireLocalStack,
} from "./helpers/localstack.js";

/**
 * Curator-workflow round-trip through the real CLI surface:
 * add → validate → publish → pull → stale-baseline publish, against a real
 * S3 backend (LocalStack).
 *
 * `publish`/`pull` deliberately do NOT use the `CatalogitCliOptions.s3Client`
 * injection seam: the suite sets `AWS_ENDPOINT_URL` (+ dummy credentials)
 * and lets the CLI build its own client, so the production construction
 * path — endpoint resolution from env and the path-style switch custom
 * endpoints require — is what gets exercised. A regression there (e.g.
 * dropping `forcePathStyle`) fails this suite instead of only failing live
 * runs. The LocalStack helper client is used solely for bucket lifecycle
 * and for simulating a concurrent curator.
 *
 * `add` spawns live subprocesses (`gh`, `git`, the coding agent), so this
 * suite shims all three with tiny scripts on a prepended PATH — no
 * github.com network, no real coding agent. The shims are still real
 * subprocesses, so the live seams (arg wiring, stdin close, env) are
 * exercised end-to-end. The gh shim reports `master` for source repos
 * and `trunk` for the `--from-github` metadata repo, so both a hardcoded
 * "main" and metadata contamination of `source.branch` would be visible.
 */
const GH_SHIM = [
  "#!/bin/sh",
  '# argv: repo view <owner/repo> --json description,repositoryTopics,defaultBranchRef',
  'case "$3" in',
  "  meta/*) printf '{\"description\":\"Metadata repo\",\"repositoryTopics\":null,\"defaultBranchRef\":{\"name\":\"trunk\"}}' ;;",
  "  *)      printf '{\"description\":\"Fixture repo\",\"repositoryTopics\":null,\"defaultBranchRef\":{\"name\":\"master\"}}' ;;",
  "esac",
  "",
].join("\n");

const CODEX_SHIM = [
  "#!/bin/sh",
  "printf '```markdown\\n## What it does\\nIntegration-test drafted description.\\n```\\n'",
  "",
].join("\n");

function gitShim(logPath: string): string {
  return ["#!/bin/sh", `echo "$@" >> "${logPath}"`, "exit 0", ""].join("\n");
}

function capture(stream: PassThrough): () => string {
  let buf = "";
  stream.on("data", (chunk) => {
    buf += chunk.toString("utf8");
  });
  return () => buf;
}

async function runCli(
  argv: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const readOut = capture(stdout);
  const readErr = capture(stderr);
  const code = await catalogitCli(argv, { stdout, stderr });
  return { code, stdout: readOut(), stderr: readErr() };
}

/** Env the suite overrides so the CLI's own S3 client targets LocalStack. */
const AWS_ENV_KEYS = [
  "AWS_ENDPOINT_URL",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_REGION",
  // The SDK prefers an ambient profile over env credentials — it must not
  // leak into the suite (see the README's LocalStack note).
  "AWS_PROFILE",
] as const;

describe("catalogit CLI add → validate → publish → pull round-trip", () => {
  let client: S3Client;
  let bucket: string;
  let curatorRoot: string;
  let pullerRoot: string;
  let gitLogPath: string;
  let savedPath: string | undefined;
  const savedAwsEnv = new Map<string, string | undefined>();

  const projectFile = "projects/leanish_roundtrip-lib.yaml";
  const mixedCaseFile = "projects/leanish_mixedcase-lib.yaml";

  beforeAll(async () => {
    await requireLocalStack();
    client = createS3TestClient();
    bucket = await createTestBucket(client);

    curatorRoot = await mkdtemp(join(tmpdir(), "catit-cli-curator-"));
    pullerRoot = await mkdtemp(join(tmpdir(), "catit-cli-puller-"));

    const shimDir = await mkdtemp(join(tmpdir(), "catit-cli-shims-"));
    gitLogPath = join(shimDir, "git-args.log");
    await writeFile(join(shimDir, "gh"), GH_SHIM, { mode: 0o755 });
    await writeFile(join(shimDir, "git"), gitShim(gitLogPath), { mode: 0o755 });
    await writeFile(join(shimDir, "codex"), CODEX_SHIM, { mode: 0o755 });

    savedPath = process.env["PATH"];
    process.env["PATH"] = `${shimDir}:${savedPath ?? ""}`;

    for (const key of AWS_ENV_KEYS) {
      savedAwsEnv.set(key, process.env[key]);
    }
    process.env["AWS_ENDPOINT_URL"] = localStackEndpoint();
    process.env["AWS_ACCESS_KEY_ID"] = "test";
    process.env["AWS_SECRET_ACCESS_KEY"] = "test";
    process.env["AWS_REGION"] = "us-east-1";
    delete process.env["AWS_PROFILE"];
  });

  afterAll(async () => {
    if (savedPath !== undefined) process.env["PATH"] = savedPath;
    for (const [key, value] of savedAwsEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (bucket !== undefined) {
      await emptyAndDeleteBucket(client, bucket);
    }
    client?.destroy();
  });

  it("add records the source repo's gh default branch, untouched by --from-github", async () => {
    const result = await runCli([
      "add",
      "leanish/roundtrip-lib",
      "--from-github",
      "meta/upstream-docs",
      "--coding-agent",
      "codex",
      "--catalog-root",
      curatorRoot,
    ]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("added leanish/roundtrip-lib");

    const raw = await readFile(join(curatorRoot, projectFile), "utf8");
    const project = parseProjectYaml(raw, projectFile);
    expect(project.id).toBe("leanish/roundtrip-lib");
    expect(project.source.url).toBe("https://github.com/leanish/roundtrip-lib.git");
    // From the gh shim's SOURCE-repo answer — "main" would mean hardcoding,
    // "trunk" would mean the --from-github metadata repo leaked in.
    expect(project.source.branch).toBe("master");
    expect(project.description).toBe("## What it does\nIntegration-test drafted description.");
  });

  it("mixed-case add input normalizes id AND filename to lowercase", async () => {
    // Regression: a filename keeping the CLI arg's casing while the record
    // id is lowercased makes the freshly-added catalog fail its own
    // `catalogit validate` (filename⇄id invariant).
    const result = await runCli([
      "add",
      "LeanISH/MixedCase-Lib",
      "--coding-agent",
      "codex",
      "--catalog-root",
      curatorRoot,
    ]);

    expect(result.code).toBe(0);
    const raw = await readFile(join(curatorRoot, mixedCaseFile), "utf8");
    const project = parseProjectYaml(raw, mixedCaseFile);
    expect(project.id).toBe("leanish/mixedcase-lib");
    expect(project.source.url).toBe("https://github.com/leanish/mixedcase-lib.git");
  });

  it("add ran the inspection clone non-interactively (no credential prompts)", async () => {
    const gitArgs = await readFile(gitLogPath, "utf8");
    expect(gitArgs).toContain("clone --depth 1 --single-branch");
    // Regression guard for the credential-prompt hang: configured helpers
    // are reset and auth routes through `gh` so clones can never block on
    // an interactive prompt.
    expect(gitArgs).toContain("credential.helper=");
    expect(gitArgs).toContain("credential.helper=!gh auth git-credential");
  });

  it("validate passes on the curated catalog", async () => {
    const result = await runCli(["validate", "--catalog-root", curatorRoot]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("catalog OK — 2 projects validated");
  });

  it("publish refuses without a baseline, then --force succeeds via the CLI's own client", async () => {
    const refused = await runCli(["publish", "--bucket", bucket, "--catalog-root", curatorRoot]);
    expect(refused.code).toBe(5);
    expect(refused.stderr).toContain("catalogit pull");

    // No injected client: this PUT only succeeds if the CLI-built client
    // honors AWS_ENDPOINT_URL and switches to path-style addressing.
    const forced = await runCli([
      "publish",
      "--bucket",
      bucket,
      "--force",
      "--catalog-root",
      curatorRoot,
    ]);
    expect(forced.code).toBe(0);
    const summary = JSON.parse(forced.stdout) as { bucket: string; key: string; etag?: string };
    expect(summary.bucket).toBe(bucket);
    expect(summary.key).toBe("catalog.json");
    expect(summary.etag).toBeDefined();

    const state = JSON.parse(
      await readFile(join(curatorRoot, ".catalogit-state.json"), "utf8"),
    ) as { etag: string };
    expect(state.etag).toBe(summary.etag);
  });

  it("pull syncs a fresh catalog root byte-identically and records the baseline", async () => {
    const result = await runCli([
      "pull",
      "--bucket",
      bucket,
      "--no-prune",
      "--catalog-root",
      pullerRoot,
    ]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("pull: 2 written, 0 overwritten");

    for (const file of [projectFile, mixedCaseFile]) {
      const original = await readFile(join(curatorRoot, file), "utf8");
      const pulled = await readFile(join(pullerRoot, file), "utf8");
      expect(pulled).toBe(original);
    }

    const curatorState = await readFile(join(curatorRoot, ".catalogit-state.json"), "utf8");
    const pullerState = await readFile(join(pullerRoot, ".catalogit-state.json"), "utf8");
    expect(pullerState).toBe(curatorState);
  });

  it("rejects a publish whose baseline went stale after a concurrent publish", async () => {
    // A concurrent curator publishes different bytes — the remote ETag moves.
    const concurrent: Project = {
      id: "leanish/roundtrip-lib",
      source: { url: "https://github.com/leanish/roundtrip-lib.git", branch: "master" },
      description: "edited concurrently",
      extensions: {},
    };
    await publishCatalog({ bucket, projects: [concurrent], client });

    const stateBefore = await readFile(join(pullerRoot, ".catalogit-state.json"), "utf8");
    const result = await runCli(["publish", "--bucket", bucket, "--catalog-root", pullerRoot]);
    expect(result.code).toBe(5);
    expect(result.stderr).toContain("remote has changed since your last pull");
    // The stale baseline must survive the rejected publish.
    const stateAfter = await readFile(join(pullerRoot, ".catalogit-state.json"), "utf8");
    expect(stateAfter).toBe(stateBefore);

    // The documented recovery: pull (re-baseline), then publish.
    const repull = await runCli([
      "pull",
      "--bucket",
      bucket,
      "--no-prune",
      "--catalog-root",
      pullerRoot,
    ]);
    expect(repull.code).toBe(0);
    const retry = await runCli(["publish", "--bucket", bucket, "--catalog-root", pullerRoot]);
    expect(retry.code).toBe(0);
  });
});
