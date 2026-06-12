import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { catalogitCli } from "../../src/index.js";
import {
  buildAddOptionsFromFlags,
  buildDiscoverOptionsFromFlags,
  runProcess,
  type MixedFlags,
} from "../../src/cli.js";

function capture(stream: PassThrough): () => string {
  let buf = "";
  stream.on("data", (chunk) => {
    buf += chunk.toString("utf8");
  });
  return () => buf;
}

async function makeFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "catalogit-cli-test-"));
  await mkdir(join(root, "projects"), { recursive: true });
  await writeFile(
    join(root, "projects", "leanish_atc.yaml"),
    [
      "id: leanish/atc",
      "source:",
      "  url: https://github.com/leanish/atc.git",
      "  branch: main",
      "extensions:",
      "  atc:",
      "    enabled: true",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(root, "projects", "leanish_reviewit.yaml"),
    [
      "id: leanish/reviewit",
      "source:",
      "  url: https://github.com/leanish/reviewit.git",
      "  branch: main",
      "",
    ].join("\n"),
  );
  return root;
}

describe("catalogitCli", () => {
  let catalogRoot: string;
  beforeAll(async () => {
    catalogRoot = await makeFixture();
  });

  it("prints usage when invoked with --help", async () => {
    const stdout = new PassThrough();
    const read = capture(stdout);
    const code = await catalogitCli(["--help"], { stdout, stderr: new PassThrough() });
    expect(code).toBe(0);
    expect(read()).toContain("Usage:");
    expect(read()).toContain("--dry-run");
    expect(read()).toContain("publish");
  });

  it("rejects an unknown subcommand", async () => {
    const stderr = new PassThrough();
    const read = capture(stderr);
    const code = await catalogitCli(["bogus"], {
      stdout: new PassThrough(),
      stderr,
    });
    expect(code).toBe(2);
    expect(read()).toContain("unknown subcommand: bogus");
  });

  it("rejects bundle subcommand as unknown", async () => {
    const stderr = new PassThrough();
    const read = capture(stderr);
    const code = await catalogitCli(["bundle", "--catalog-root", catalogRoot], {
      stdout: new PassThrough(),
      stderr,
    });
    expect(code).toBe(2);
    expect(read()).toContain("unknown subcommand: bundle");
  });

  it("publish without --bucket and without --dry-run: exit 2 with bucket-required error", async () => {
    const stderr = new PassThrough();
    const read = capture(stderr);
    const code = await catalogitCli(["publish"], {
      stdout: new PassThrough(),
      stderr,
    });
    expect(code).toBe(2);
    expect(read()).toContain("--bucket is required");
  });

  it("defaults --catalog-root to the XDG path when no flag and no env override", async () => {
    // Run `validate` with no --catalog-root; should resolve through the
    // documented chain to `$XDG_DATA_HOME/catalogit/`. Point XDG_DATA_HOME at
    // a fresh temp dir (no catalogit/ inside) so the FilesystemCatalog.load
    // ENOENT is guaranteed regardless of the developer's real ~/.local/share
    // or CATALOGIT_ROOT env.
    const savedRoot = process.env["CATALOGIT_ROOT"];
    const savedXdg = process.env["XDG_DATA_HOME"];
    delete process.env["CATALOGIT_ROOT"];
    process.env["XDG_DATA_HOME"] = await mkdtemp(join(tmpdir(), "catit-xdg-"));
    try {
      const stderr = new PassThrough();
      const read = capture(stderr);
      const code = await catalogitCli(["validate"], {
        stdout: new PassThrough(),
        stderr,
      });
      expect(code).toBe(1);
      // The default path (under XDG_DATA_HOME) is in the message:
      expect(read()).toMatch(/catalogit\/projects/);
    } finally {
      if (savedRoot === undefined) delete process.env["CATALOGIT_ROOT"];
      else process.env["CATALOGIT_ROOT"] = savedRoot;
      if (savedXdg === undefined) delete process.env["XDG_DATA_HOME"];
      else process.env["XDG_DATA_HOME"] = savedXdg;
    }
  });

  it("prints usage containing add and discover when invoked with --help", async () => {
    const stdout = new PassThrough();
    const read = capture(stdout);
    const code = await catalogitCli(["--help"], { stdout, stderr: new PassThrough() });
    expect(code).toBe(0);
    expect(read()).toContain("add");
    expect(read()).toContain("discover");
    expect(read()).toContain("--skeleton");
    expect(read()).toContain("--coding-agent");
  });

  it("routes add to the add handler and returns 2 when <id> is missing", async () => {
    const stderr = new PassThrough();
    const read = capture(stderr);
    // No positional id supplied — should return 2 and write usage hint.
    const code = await catalogitCli(["add"], { stdout: new PassThrough(), stderr });
    expect(code).toBe(2);
    expect(read()).toContain("<id> is required");
  });

  it("routes add with an unknown flag to the error path (exit 1)", async () => {
    const stderr = new PassThrough();
    const read = capture(stderr);
    // --bogus is not a known add flag → parseMixedFlags throws → dispatcher
    // catches it and returns 1.
    const code = await catalogitCli(
      ["add", "leanish/atc", "--bogus"],
      { stdout: new PassThrough(), stderr },
    );
    expect(code).toBe(1);
    expect(read()).toContain("unknown flag");
  });

  it("routes discover with an unknown flag to the error path (exit 1)", async () => {
    const stderr = new PassThrough();
    const read = capture(stderr);
    const code = await catalogitCli(
      ["discover", "--totally-unknown"],
      { stdout: new PassThrough(), stderr },
    );
    expect(code).toBe(1);
    expect(read()).toContain("unknown flag");
  });
});

// ---------------------------------------------------------------------------
// publish — new behavior: dry-run, state-file conflict guard, --force, --out
// ---------------------------------------------------------------------------

async function makePublishFixture(): Promise<{
  catalogRoot: string;
  stateFile: string;
}> {
  const catalogRoot = await mkdtemp(join(tmpdir(), "catalogit-publish-test-"));
  await mkdir(join(catalogRoot, "projects"), { recursive: true });
  await writeFile(
    join(catalogRoot, "projects", "leanish_atc.yaml"),
    [
      "id: leanish/atc",
      "source:",
      "  url: https://github.com/leanish/atc.git",
      "  branch: main",
      "",
    ].join("\n"),
  );
  return { catalogRoot, stateFile: join(catalogRoot, ".catalogit-state.json") };
}

function fakeS3ClientSuccess(etag: string): S3Client {
  const client = new S3Client({ region: "us-east-1" });
  vi.spyOn(client, "send").mockImplementation(async (cmd) => {
    if (cmd instanceof PutObjectCommand) {
      return { ETag: etag };
    }
    throw new Error("unexpected command");
  });
  return client;
}

function fakeS3Client412(): S3Client {
  const client = new S3Client({ region: "us-east-1" });
  vi.spyOn(client, "send").mockImplementation(async (_cmd) => {
    const err = Object.assign(new Error("PreconditionFailed"), {
      name: "PreconditionFailed",
      $metadata: { httpStatusCode: 412 },
    });
    throw err;
  });
  return client;
}

describe("publish subcommand", () => {
  it("dry-run (stdout): writes bundle + newline to stdout, no S3 client", async () => {
    const { catalogRoot } = await makePublishFixture();
    const stdout = new PassThrough();
    const read = capture(stdout);

    const code = await catalogitCli(
      ["publish", "--dry-run", "--catalog-root", catalogRoot],
      { stdout, stderr: new PassThrough() },
    );

    expect(code).toBe(0);
    const parsed = JSON.parse(read()) as { version: string; projects: { id: string }[] };
    expect(parsed.version).toBe("1");
    expect(parsed.projects.map((p) => p.id)).toEqual(["leanish/atc"]);
    // output ends with a newline (after the JSON)
    expect(read().trimEnd()).toBe(read().trimEnd()); // basic smoke
    expect(read().endsWith("\n")).toBe(true);
  });

  it("dry-run --out: writes bundle to file, stdout has 'wrote N bytes' line", async () => {
    const { catalogRoot } = await makePublishFixture();
    const outDir = await mkdtemp(join(tmpdir(), "catalogit-out-"));
    const outPath = join(outDir, "bundle.json");
    const stdout = new PassThrough();
    const read = capture(stdout);

    const code = await catalogitCli(
      ["publish", "--dry-run", "--catalog-root", catalogRoot, "--out", outPath],
      { stdout, stderr: new PassThrough() },
    );

    expect(code).toBe(0);
    const fileContent = await readFile(outPath, "utf8");
    const parsed = JSON.parse(fileContent) as { version: string };
    expect(parsed.version).toBe("1");
    expect(read()).toMatch(/wrote \d+ bytes to .+bundle\.json/);
  });

  it("--out without --dry-run: exit 2 with validation error", async () => {
    const { catalogRoot } = await makePublishFixture();
    const stderr = new PassThrough();
    const read = capture(stderr);

    const code = await catalogitCli(
      ["publish", "--out", "/tmp/x.json", "--catalog-root", catalogRoot],
      { stdout: new PassThrough(), stderr },
    );

    expect(code).toBe(2);
    expect(read()).toContain("--out` is only valid with `--dry-run`");
  });

  it("publish without --bucket (no --dry-run): exit 2 with bucket-required error", async () => {
    const { catalogRoot } = await makePublishFixture();
    const stderr = new PassThrough();
    const read = capture(stderr);

    const code = await catalogitCli(
      ["publish", "--catalog-root", catalogRoot],
      { stdout: new PassThrough(), stderr },
    );

    expect(code).toBe(2);
    expect(read()).toContain("--bucket is required");
  });

  it("publish --bucket without state file: exit 5, stderr mentions catalogit pull", async () => {
    const { catalogRoot } = await makePublishFixture();
    const stderr = new PassThrough();
    const read = capture(stderr);
    const s3Client = fakeS3ClientSuccess('"new-etag"');

    const code = await catalogitCli(
      ["publish", "--bucket", "my-bucket", "--catalog-root", catalogRoot],
      { stdout: new PassThrough(), stderr, s3Client },
    );

    expect(code).toBe(5);
    expect(read()).toContain("catalogit pull");
    // S3 was not called
    expect(vi.mocked(s3Client.send)).not.toHaveBeenCalled();
  });

  it("publish --bucket with state file: S3 PUT with If-Match, state file updated on success", async () => {
    const { catalogRoot, stateFile } = await makePublishFixture();
    // Write a state file as pull would
    await writeFile(stateFile, JSON.stringify({ etag: '"old-etag"' }) + "\n", "utf8");

    const stdout = new PassThrough();
    const read = capture(stdout);
    const s3Client = fakeS3ClientSuccess('"new-etag"');

    const code = await catalogitCli(
      ["publish", "--bucket", "my-bucket", "--catalog-root", catalogRoot],
      { stdout, stderr: new PassThrough(), s3Client },
    );

    expect(code).toBe(0);
    // S3 was called with If-Match
    const call = vi.mocked(s3Client.send).mock.calls[0]?.[0] as PutObjectCommand;
    expect(call).toBeInstanceOf(PutObjectCommand);
    expect(call.input.IfMatch).toBe('"old-etag"');

    // State file updated with new ETag
    const stateRaw = await readFile(stateFile, "utf8");
    const state = JSON.parse(stateRaw) as { etag: string };
    expect(state.etag).toBe('"new-etag"');

    // stdout has the JSON summary
    const summary = JSON.parse(read()) as { bucket: string; key: string; bytes: number };
    expect(summary.bucket).toBe("my-bucket");
    expect(summary.key).toBe("catalog.json");
    expect(typeof summary.bytes).toBe("number");
  });

  it("publish --bucket --force without state file: S3 PUT without If-Match, state file written", async () => {
    const { catalogRoot, stateFile } = await makePublishFixture();
    const s3Client = fakeS3ClientSuccess('"force-etag"');

    const code = await catalogitCli(
      ["publish", "--bucket", "my-bucket", "--force", "--catalog-root", catalogRoot],
      { stdout: new PassThrough(), stderr: new PassThrough(), s3Client },
    );

    expect(code).toBe(0);
    const call = vi.mocked(s3Client.send).mock.calls[0]?.[0] as PutObjectCommand;
    expect(call).toBeInstanceOf(PutObjectCommand);
    expect(call.input.IfMatch).toBeUndefined();

    const stateRaw = await readFile(stateFile, "utf8");
    const state = JSON.parse(stateRaw) as { etag: string };
    expect(state.etag).toBe('"force-etag"');
  });

  it("publish --bucket --if-match: S3 PUT uses the provided ETag, state file updated", async () => {
    const { catalogRoot, stateFile } = await makePublishFixture();
    // Even with a state file present, --if-match takes precedence
    await writeFile(stateFile, JSON.stringify({ etag: '"state-etag"' }) + "\n", "utf8");

    const s3Client = fakeS3ClientSuccess('"returned-etag"');

    const code = await catalogitCli(
      ["publish", "--bucket", "my-bucket", "--if-match", "my-custom-etag", "--catalog-root", catalogRoot],
      { stdout: new PassThrough(), stderr: new PassThrough(), s3Client },
    );

    expect(code).toBe(0);
    const call = vi.mocked(s3Client.send).mock.calls[0]?.[0] as PutObjectCommand;
    expect(call.input.IfMatch).toBe("my-custom-etag");

    const stateRaw = await readFile(stateFile, "utf8");
    const state = JSON.parse(stateRaw) as { etag: string };
    expect(state.etag).toBe('"returned-etag"');
  });

  it("publish --bucket with 412 response: exit 5, stderr mentions catalogit pull, state file not updated", async () => {
    const { catalogRoot, stateFile } = await makePublishFixture();
    await writeFile(stateFile, JSON.stringify({ etag: '"old-etag"' }) + "\n", "utf8");

    const stderr = new PassThrough();
    const read = capture(stderr);
    const s3Client = fakeS3Client412();

    const code = await catalogitCli(
      ["publish", "--bucket", "my-bucket", "--catalog-root", catalogRoot],
      { stdout: new PassThrough(), stderr, s3Client },
    );

    expect(code).toBe(5);
    expect(read()).toContain("catalogit pull");
    // State file not updated — still has the old etag
    const stateRaw = await readFile(stateFile, "utf8");
    const state = JSON.parse(stateRaw) as { etag: string };
    expect(state.etag).toBe('"old-etag"');
  });
});

// ---------------------------------------------------------------------------
// pull — CLI wiring over pullCatalog via the injected-client seam
// ---------------------------------------------------------------------------

function fakeS3ClientBundle(bundleJson: string, etag: string): S3Client {
  const client = new S3Client({ region: "us-east-1" });
  vi.spyOn(client, "send").mockImplementation(async (cmd) => {
    if (cmd instanceof GetObjectCommand) {
      return { Body: { transformToString: async () => bundleJson }, ETag: etag };
    }
    throw new Error("unexpected command");
  });
  return client;
}

describe("pull subcommand", () => {
  it("pull --bucket: writes bundle projects + state file via the injected client", async () => {
    const catalogRoot = await mkdtemp(join(tmpdir(), "catalogit-pull-test-"));
    const bundle = JSON.stringify({
      version: "1",
      projects: [
        {
          id: "leanish/atc",
          source: { url: "https://github.com/leanish/atc.git", branch: "main" },
        },
      ],
    });
    const stdout = new PassThrough();
    const read = capture(stdout);
    const s3Client = fakeS3ClientBundle(bundle, '"pull-etag"');

    const code = await catalogitCli(
      ["pull", "--bucket", "my-bucket", "--no-prune", "--catalog-root", catalogRoot],
      { stdout, stderr: new PassThrough(), s3Client },
    );

    expect(code).toBe(0);
    expect(read()).toContain("pull: 1 written, 0 overwritten");
    const yaml = await readFile(join(catalogRoot, "projects", "leanish_atc.yaml"), "utf8");
    expect(yaml).toContain("id: leanish/atc");
    const state = JSON.parse(
      await readFile(join(catalogRoot, ".catalogit-state.json"), "utf8"),
    ) as { etag: string };
    expect(state.etag).toBe('"pull-etag"');
  });

  it("pull --prune --no-prune: exit 2 before any S3 contact", async () => {
    const catalogRoot = await mkdtemp(join(tmpdir(), "catalogit-pull-test-"));
    const stderr = new PassThrough();
    const read = capture(stderr);
    const s3Client = fakeS3ClientBundle("{}", '"unused"');

    const code = await catalogitCli(
      ["pull", "--bucket", "b", "--prune", "--no-prune", "--catalog-root", catalogRoot],
      { stdout: new PassThrough(), stderr, s3Client },
    );

    expect(code).toBe(2);
    expect(read()).toContain("--prune and --no-prune are mutually exclusive");
    expect(vi.mocked(s3Client.send)).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// buildAddOptionsFromFlags — pure option builder (no subprocess, no TTY)
// ---------------------------------------------------------------------------

function noFlags(extra?: Record<string, string>): MixedFlags {
  return { strings: extra ?? {}, booleans: {} };
}

describe("buildAddOptionsFromFlags", () => {
  it("defaults to codex agent and no flags", () => {
    const opts = buildAddOptionsFromFlags("leanish/atc", noFlags());
    expect(opts.id).toBe("leanish/atc");
    expect(opts.agent).toBe("codex");
    expect(opts.force).toBe(false);
    expect(opts.skeleton).toBe(false);
    expect(opts.from).toBeUndefined();
    expect(opts.fromGithub).toBeUndefined();
  });

  it("picks up --from and --from-github strings", () => {
    const opts = buildAddOptionsFromFlags("leanish/atc", {
      strings: { from: "/local/path", "from-github": "other/repo" },
      booleans: {},
    });
    expect(opts.from).toBe("/local/path");
    expect(opts.fromGithub).toBe("other/repo");
  });

  it("picks up boolean flags", () => {
    const opts = buildAddOptionsFromFlags("leanish/atc", {
      strings: {},
      booleans: { force: true, "skeleton": true },
    });
    expect(opts.force).toBe(true);
    expect(opts.skeleton).toBe(true);
  });

  it("resolves claude agent when --coding-agent is set", () => {
    const opts = buildAddOptionsFromFlags("leanish/atc", {
      strings: { "coding-agent": "claude" },
      booleans: {},
    });
    expect(opts.agent).toBe("claude");
  });

  it("uses --catalog-root when provided", () => {
    const opts = buildAddOptionsFromFlags("leanish/atc", {
      strings: { "catalog-root": "/custom/root" },
      booleans: {},
    });
    expect(opts.catalogRoot).toBe("/custom/root");
  });
});

// ---------------------------------------------------------------------------
// buildDiscoverOptionsFromFlags — pure option builder
// ---------------------------------------------------------------------------

describe("buildDiscoverOptionsFromFlags", () => {
  it("defaults to no owner, codex agent, no flags", () => {
    const opts = buildDiscoverOptionsFromFlags(noFlags());
    expect(opts.owner).toBeUndefined();
    expect(opts.agent).toBe("codex");
    expect(opts.includeArchived).toBe(false);
    expect(opts.force).toBe(false);
    expect(opts.skeleton).toBe(false);
    expect(opts.add).toBeUndefined();
  });

  it("splits --add on commas", () => {
    const opts = buildDiscoverOptionsFromFlags({
      strings: { add: "repo-a, repo-b,repo-c" },
      booleans: {},
    });
    expect(opts.add).toEqual(["repo-a", "repo-b", "repo-c"]);
  });

  it("passes '*' through literally", () => {
    const opts = buildDiscoverOptionsFromFlags({
      strings: { add: "*" },
      booleans: {},
    });
    expect(opts.add).toEqual(["*"]);
  });

  it("picks up --owner", () => {
    const opts = buildDiscoverOptionsFromFlags({
      strings: { owner: "myorg" },
      booleans: {},
    });
    expect(opts.owner).toBe("myorg");
  });

  it("picks up --include-archived boolean", () => {
    const opts = buildDiscoverOptionsFromFlags({
      strings: {},
      booleans: { "include-archived": true },
    });
    expect(opts.includeArchived).toBe(true);
  });
});

// Live-seam regression test: deliberately spawns a tiny `node -e` child.
// `runProcess` must close the child's stdin even without `input` — `codex exec`
// reads piped stdin to EOF before starting, so an open pipe hangs it forever.
describe("runProcess", () => {
  it("closes the child's stdin when no input is given (EOF reaches the child)", async () => {
    const result = await runProcess(
      "node",
      ["-e", "process.stdin.on('data', () => {}); process.stdin.on('end', () => process.exit(7));"],
      {},
    );
    expect(result.code).toBe(7);
  });

  it("delivers input then EOF when input is given", async () => {
    const result = await runProcess(
      "node",
      ["-e", "let b = ''; process.stdin.on('data', (d) => (b += d)); process.stdin.on('end', () => { process.stdout.write(b); process.exit(0); });"],
      { input: "hi" },
    );
    expect(result).toEqual({ code: 0, stdout: "hi", stderr: "" });
  });

  it("forwards env to the child when provided (the git seam disables credential prompts)", async () => {
    const result = await runProcess(
      "node",
      ["-e", "process.stdout.write(process.env.CATALOGIT_TEST_MARKER ?? 'missing');"],
      { env: { ...process.env, CATALOGIT_TEST_MARKER: "forwarded" } },
    );
    expect(result).toEqual({ code: 0, stdout: "forwarded", stderr: "" });
  });

  it("kills the child and reports code 124 when timeoutMs elapses", async () => {
    const result = await runProcess(
      "node",
      ["-e", "setTimeout(() => {}, 60_000);"],
      { timeoutMs: 200 },
    );
    expect(result.code).toBe(124);
    expect(result.stderr).toContain("timed out after 200ms");
  });
});
