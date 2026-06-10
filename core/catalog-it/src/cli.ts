import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs as nodeParseArgs } from "node:util";

import { S3Client as AwsS3Client } from "@aws-sdk/client-s3";
import { confirm as inquirerConfirm, checkbox } from "@inquirer/prompts";

import { runAdd, type AddOptions, type AddDeps } from "./add.js";
import { bundleCatalog } from "./bundle.js";
import { resolveCodingAgent, type RunResult } from "./coding-agent.js";
import { runDiscover, type DiscoverOptions, type DiscoverDeps } from "./discover.js";
import { FilesystemCatalog } from "./filesystem-catalog.js";
import { listRepos, type RunGh } from "./github.js";
import { type RunGit } from "./inspection-clone.js";
import { publishCatalog } from "./publish.js";
import { readPublishState, writePublishState } from "./publish-state.js";
import { pullCatalog } from "./pull.js";
import { validateCatalog } from "./validate.js";

/**
 * `catalogit` CLI. Subcommands:
 *
 *   catalogit validate --catalog-root <path>
 *   catalogit publish  --catalog-root <path> --bucket <name>
 *                      [--key <name>] [--region <name>] [--if-match <etag>]
 *                      [--dry-run] [--out <path>] [--force]
 *
 * `validate` spine-checks every project YAML and reports issues with file
 * paths (exit code 1 on any issue, 0 when clean).
 *
 * `publish` reads the local catalog and PUTs the bundle to
 * `s3://<bucket>/<key>` (default key: `catalog.json`). With `--dry-run`,
 * only bundles locally — no S3 contact.
 */
export interface CatalogitCliOptions {
  readonly stdout?: NodeJS.WritableStream;
  readonly stderr?: NodeJS.WritableStream;
  /** Injected S3 client for testing; production code builds one from flags. */
  readonly s3Client?: import("@aws-sdk/client-s3").S3Client;
}

export async function catalogitCli(
  argv: ReadonlyArray<string>,
  options: CatalogitCliOptions = {},
): Promise<number> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;

  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    stdout.write(USAGE);
    return 0;
  }

  const subcommand = argv[0];
  const rest = argv.slice(1);

  try {
    switch (subcommand) {
      case "validate":
        return await runValidate(rest, stdout, stderr);
      case "publish":
        return await runPublish(rest, stdout, stderr, options.s3Client);
      case "pull":
        return await runPullCmd(rest, stdout, stderr);
      case "add":
        return await runAddCmd(rest, stdout, stderr);
      case "discover":
        return await runDiscoverCmd(rest, stdout, stderr);
      default:
        stderr.write(`unknown subcommand: ${subcommand}\n\n${USAGE}`);
        return 2;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    stderr.write(`catalogit ${subcommand} failed: ${message}\n`);
    if (err instanceof Error && err.stack !== undefined) {
      stderr.write(err.stack + "\n");
    }
    return 1;
  }
}

async function runValidate(
  argv: ReadonlyArray<string>,
  stdout: NodeJS.WritableStream,
  stderr: NodeJS.WritableStream,
): Promise<number> {
  const args = parseMixedFlags(argv, { strings: ["catalog-root"], booleans: [] });
  const catalogRoot = resolveCatalogRoot(args.strings);

  const result = await validateCatalog({ catalogRoot });
  if (result.issues.length === 0) {
    stdout.write(
      `catalog OK — ${result.projectsScanned} project${result.projectsScanned === 1 ? "" : "s"} validated\n`,
    );
    return 0;
  }
  for (const issue of result.issues) {
    stderr.write(`${issue.file}: ${issue.message}\n`);
  }
  stderr.write(
    `\ncatalog FAILED — ${result.issues.length} issue${result.issues.length === 1 ? "" : "s"} across ${result.projectsScanned} scanned file${result.projectsScanned === 1 ? "" : "s"}\n`,
  );
  return 1;
}

async function runPublish(
  argv: ReadonlyArray<string>,
  stdout: NodeJS.WritableStream,
  stderr: NodeJS.WritableStream,
  injectedClient?: import("@aws-sdk/client-s3").S3Client,
): Promise<number> {
  const args = parseMixedFlags(argv, {
    strings: ["catalog-root", "bucket", "key", "region", "if-match", "out"],
    booleans: ["dry-run", "force"],
  });

  const isDryRun = args.booleans["dry-run"] === true;
  const isForce = args.booleans["force"] === true;
  const outPath = args.strings["out"];
  const catalogRoot = resolveCatalogRoot(args.strings);

  // Validation
  if (outPath !== undefined && !isDryRun) {
    stderr.write("catalogit publish: `--out` is only valid with `--dry-run`\n");
    return 2;
  }
  if (!isDryRun && args.strings["bucket"] === undefined) {
    stderr.write("catalogit publish: --bucket is required\n\n" + USAGE);
    return 2;
  }

  // Load + bundle (needed for both dry-run and real publish)
  const catalog = await FilesystemCatalog.load({ catalogRoot });
  const body = bundleCatalog(catalog.list());

  // Dry-run path: no S3, no state file
  if (isDryRun) {
    if (outPath !== undefined) {
      const absolute = resolve(outPath);
      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, body + "\n");
      stdout.write(`wrote ${Buffer.byteLength(body, "utf8")} bytes to ${absolute}\n`);
    } else {
      stdout.write(body + "\n");
    }
    return 0;
  }

  // Real publish path
  const bucket = args.strings["bucket"]!;

  // Determine ifMatch
  let ifMatch: string | undefined;
  if (args.strings["if-match"] !== undefined) {
    // Explicit override — use it, skip state-file logic entirely
    ifMatch = args.strings["if-match"];
  } else if (isForce) {
    // Bypass state-file check; publish unconditionally
    ifMatch = undefined;
  } else {
    // Safety default: read the conflict-detection baseline written by pull.
    const state = await readPublishState(catalogRoot);
    if (state.kind === "missing") {
      stderr.write(
        `catalogit publish: no .catalogit-state.json at ${catalogRoot}. ` +
          "Run `catalogit pull` first to establish the conflict-detection baseline, " +
          "or pass --force to skip.\n",
      );
      return 5;
    }
    if (state.kind === "malformed") {
      stderr.write(
        `catalogit publish: .catalogit-state.json at ${catalogRoot} could not be used (${state.reason}). ` +
          "Re-run `catalogit pull` to rewrite it, or pass --force to skip.\n",
      );
      return 5;
    }
    ifMatch = state.etag;
  }

  // Build the S3 client (or use injected one for tests)
  // Retry knobs mirror agent-runtime's `awsClientDefaults()` — kept inline
  // here to preserve catalogit's "no agent-runtime dependency" invariant.
  const client =
    injectedClient ??
    new AwsS3Client({
      maxAttempts: 5,
      retryMode: "adaptive",
      ...(args.strings["region"] !== undefined ? { region: args.strings["region"] } : {}),
    });

  let result: import("./publish.js").PublishCatalogResult;
  try {
    result = await publishCatalog({
      bucket,
      projects: catalog.list(),
      client,
      ...(args.strings["key"] !== undefined ? { key: args.strings["key"] } : {}),
      ...(ifMatch !== undefined ? { ifMatch } : {}),
    });
  } catch (err) {
    const is412 =
      (err instanceof Error && err.name === "PreconditionFailed") ||
      (typeof (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode ===
        "number" &&
        (err as { $metadata: { httpStatusCode: number } }).$metadata.httpStatusCode === 412);
    if (is412) {
      stderr.write(
        "catalogit publish: remote has changed since your last pull. " +
          "Run `catalogit pull` first, then retry.\n",
      );
      return 5;
    }
    throw err;
  }

  // On success: update the conflict-detection baseline if we got an ETag back
  if (result.etag !== undefined) {
    await writePublishState(catalogRoot, result.etag);
  }

  stdout.write(
    JSON.stringify(
      {
        bucket: result.bucket,
        key: result.key,
        bytes: result.bytes,
        ...(result.etag !== undefined ? { etag: result.etag } : {}),
        ...(result.versionId !== undefined ? { versionId: result.versionId } : {}),
      },
      null,
      2,
    ) + "\n",
  );
  return 0;
}

async function runPullCmd(
  argv: ReadonlyArray<string>,
  stdout: NodeJS.WritableStream,
  stderr: NodeJS.WritableStream,
): Promise<number> {
  const args = parseMixedFlags(argv, {
    strings: ["catalog-root", "bucket", "key", "region"],
    booleans: ["prune", "no-prune"],
  });

  const bucket = args.strings["bucket"];
  if (bucket === undefined) {
    stderr.write("catalogit pull: --bucket is required\n\n" + USAGE);
    return 2;
  }

  const hasPrune = args.booleans["prune"] === true;
  const hasNoPrune = args.booleans["no-prune"] === true;
  if (hasPrune && hasNoPrune) {
    stderr.write("catalogit pull: --prune and --no-prune are mutually exclusive\n");
    return 2;
  }

  const pruneMode = hasPrune ? "always" : hasNoPrune ? "never" : "ask";
  const catalogRoot = resolveCatalogRoot(args.strings);

  const client = new AwsS3Client({
    maxAttempts: 5,
    retryMode: "adaptive",
    ...(args.strings["region"] !== undefined ? { region: args.strings["region"] } : {}),
  });

  try {
    const summary = await pullCatalog(
      {
        bucket,
        catalogRoot,
        pruneMode,
        ...(args.strings["key"] !== undefined ? { key: args.strings["key"] } : {}),
      },
      { client, confirm },
    );
    stdout.write(
      `pull: ${summary.written.length} written, ${summary.overwritten.length} overwritten, ` +
        `${summary.localOnlyDeleted.length} local-only deleted, ${summary.localOnlyKept.length} local-only kept\n`,
    );
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    stderr.write(`catalogit pull failed: ${message}\n`);
    return 2;
  }
}

// ---------------------------------------------------------------------------
// add / discover handlers
// ---------------------------------------------------------------------------

async function runAddCmd(
  argv: ReadonlyArray<string>,
  stdout: NodeJS.WritableStream,
  stderr: NodeJS.WritableStream,
): Promise<number> {
  // Separate the positional <id> from flags manually: the first non-flag token
  // is the id; remaining tokens are parsed as flags.
  const { positionals, flagArgv } = extractPositionals(argv);

  if (positionals.length === 0) {
    stderr.write("catalogit add: <id> is required\n\n" + USAGE);
    return 2;
  }
  const id = positionals[0]!;

  const args = parseMixedFlags(flagArgv, {
    strings: ["from", "from-github", "catalog-root", "coding-agent"],
    booleans: ["force", "skeleton"],
  });

  const addOptions = buildAddOptionsFromFlags(id, args);
  const deps = buildLiveDeps(stderr);
  const result = await runAdd(addOptions, deps);

  if (result.status === "added") {
    stdout.write(`added ${id}\n`);
  } else if (result.status === "overridden") {
    stdout.write(`re-drafted ${id}\n`);
  } else if (result.status === "skeleton") {
    stdout.write(`skeleton written for ${id} — edit manually or re-run to draft\n`);
  }

  return result.exitCode;
}

async function runDiscoverCmd(
  argv: ReadonlyArray<string>,
  stdout: NodeJS.WritableStream,
  stderr: NodeJS.WritableStream,
): Promise<number> {
  const args = parseMixedFlags(argv, {
    strings: ["owner", "add", "catalog-root", "coding-agent"],
    booleans: ["include-archived", "force", "skeleton"],
  });

  const discoverOptions = buildDiscoverOptionsFromFlags(args);
  const deps = buildLiveDiscoverDeps(stdout, stderr);
  const result = await runDiscover(discoverOptions, deps);
  return result.exitCode;
}

// ---------------------------------------------------------------------------
// Pure option-builders (exported so tests can call them without subprocesses)
// ---------------------------------------------------------------------------

export interface MixedFlags {
  readonly strings: Record<string, string>;
  readonly booleans: Record<string, boolean>;
}

/** Build AddOptions from already-parsed flags + a positional id. */
export function buildAddOptionsFromFlags(
  id: string,
  args: MixedFlags,
): AddOptions {
  return {
    id,
    catalogRoot: resolveCatalogRoot(args.strings),
    ...(args.strings["from"] !== undefined ? { from: args.strings["from"] } : {}),
    ...(args.strings["from-github"] !== undefined
      ? { fromGithub: args.strings["from-github"] }
      : {}),
    agent: resolveCodingAgent(args.strings["coding-agent"], process.env),
    force: args.booleans["force"] ?? false,
    skeleton: args.booleans["skeleton"] ?? false,
    isTty: process.stdin.isTTY === true,
  };
}

/** Build DiscoverOptions from already-parsed flags. */
export function buildDiscoverOptionsFromFlags(args: MixedFlags): DiscoverOptions {
  const addRaw = args.strings["add"];
  const add =
    addRaw !== undefined ? addRaw.split(",").map((s) => s.trim()) : undefined;
  return {
    ...(args.strings["owner"] !== undefined ? { owner: args.strings["owner"] } : {}),
    includeArchived: args.booleans["include-archived"] ?? false,
    ...(add !== undefined ? { add } : {}),
    agent: resolveCodingAgent(args.strings["coding-agent"], process.env),
    force: args.booleans["force"] ?? false,
    skeleton: args.booleans["skeleton"] ?? false,
    catalogRoot: resolveCatalogRoot(args.strings),
    isTty: process.stdin.isTTY === true,
  };
}

// ---------------------------------------------------------------------------
// Live seams (production-only; `runProcess` is exported for the stdin-close
// regression test)
// ---------------------------------------------------------------------------

export function runProcess(
  cmd: string,
  args: readonly string[],
  opts: { cwd?: string; input?: string; timeoutMs?: number },
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, [...args], { cwd: opts.cwd });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer =
      opts.timeoutMs !== undefined
        ? setTimeout(() => {
            timedOut = true;
            child.kill("SIGKILL");
          }, opts.timeoutMs)
        : undefined;
    const done = (result: RunResult): void => {
      if (timer !== undefined) clearTimeout(timer);
      resolve(result);
    };
    child.stdout.on("data", (b: Buffer) => (stdout += b));
    child.stderr.on("data", (b: Buffer) => (stderr += b));
    child.on("error", () =>
      done({ code: 127, stdout, stderr: stderr || `failed to spawn ${cmd}` }),
    );
    child.on("close", (code: number | null) =>
      done(
        timedOut
          ? {
              code: 124,
              stdout,
              stderr: `${stderr}\n${cmd} timed out after ${opts.timeoutMs}ms and was killed`,
            }
          : { code: code ?? 1, stdout, stderr },
      ),
    );
    // Always close stdin (with input when provided). `codex exec` reads piped
    // stdin to EOF even when the prompt is an argument — an open pipe makes it
    // wait forever before starting.
    child.stdin.end(opts.input);
  });
}

// Hard caps so no live subprocess can stall a run forever: `gh` calls are
// quick API lookups; `git` covers shallow inspection clones of large repos.
const GH_TIMEOUT_MS = 60_000;
const GIT_TIMEOUT_MS = 5 * 60_000;

const runGit: RunGit = (args) => runProcess("git", args, { timeoutMs: GIT_TIMEOUT_MS });
const runGh: RunGh = (args) => runProcess("gh", args, { timeoutMs: GH_TIMEOUT_MS });

const confirm = (message: string): Promise<boolean> =>
  inquirerConfirm({ message });

const select = (
  choices: { name: string; value: string; checked?: boolean }[],
): Promise<string[]> => checkbox({ message: "Select repos to import", choices });

function buildLiveDeps(stderr: NodeJS.WritableStream): AddDeps {
  return { runProcess, runGh, runGit, confirm, stderr };
}

function buildLiveDiscoverDeps(
  stdout: NodeJS.WritableStream,
  stderr: NodeJS.WritableStream,
): DiscoverDeps {
  return { runProcess, runGh, runGit, confirm, select, listRepos, stdout, stderr };
}

// ---------------------------------------------------------------------------
// Flag-parsing helpers
// ---------------------------------------------------------------------------

/**
 * Splits argv into positional tokens (non-flag, non-flag-value) and the
 * remaining flag-only argv. A token is treated as positional when it doesn't
 * start with `--` and the previous token wasn't a string flag name.
 *
 * This simple splitter is intentionally naive: it only extracts leading
 * positionals before the first `--foo` flag. That is sufficient for the
 * `add <id>` case where <id> always comes first.
 */
function extractPositionals(argv: ReadonlyArray<string>): {
  positionals: string[];
  flagArgv: ReadonlyArray<string>;
} {
  const positionals: string[] = [];
  let i = 0;
  while (i < argv.length && !argv[i]!.startsWith("--")) {
    positionals.push(argv[i]!);
    i++;
  }
  return { positionals, flagArgv: argv.slice(i) };
}

/**
 * Like `parseFlags` but accepts a mix of string and boolean options.
 * Returns strings and booleans in separate maps for clarity.
 */
function parseMixedFlags(
  argv: ReadonlyArray<string>,
  spec: { strings: ReadonlyArray<string>; booleans: ReadonlyArray<string> },
): MixedFlags {
  const options: Record<string, { type: "string" } | { type: "boolean" }> = {};
  for (const name of spec.strings) options[name] = { type: "string" };
  for (const name of spec.booleans) options[name] = { type: "boolean" };

  let values: Record<string, string | boolean | undefined>;
  try {
    ({ values } = nodeParseArgs({
      args: [...argv],
      options,
      allowPositionals: false,
      strict: true,
    }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/Unknown option/.test(message)) {
      throw new Error(
        `unknown flag for this subcommand: ${message.replace(/.*'(--[^']+)'.*/, "$1")}`,
      );
    }
    if (/argument missing/i.test(message) || /requires a value/i.test(message)) {
      throw new Error(message.replace(/^.*?(?=')/, "flag "));
    }
    throw err;
  }

  const strings: Record<string, string> = {};
  const booleans: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(values)) {
    if (typeof v === "string") strings[k] = v;
    else if (typeof v === "boolean") booleans[k] = v;
  }
  return { strings, booleans };
}

/**
 * `<catalogRoot>` resolution per `data-format.md`:
 *   1. explicit `--catalog-root <path>` flag (highest precedence)
 *   2. `CATALOGIT_ROOT` env var
 *   3. `${XDG_DATA_HOME:-$HOME/.local/share}/catalogit/` (default)
 */
function resolveCatalogRoot(args: Record<string, string>): string {
  if (args["catalog-root"] !== undefined) {
    return resolve(args["catalog-root"]);
  }
  const envRoot = process.env["CATALOGIT_ROOT"];
  if (envRoot !== undefined && envRoot.length > 0) {
    return resolve(envRoot);
  }
  const xdg = process.env["XDG_DATA_HOME"];
  if (xdg !== undefined && xdg.length > 0) {
    return join(xdg, "catalogit");
  }
  return join(homedir(), ".local", "share", "catalogit");
}

const USAGE = `Usage:
  catalogit validate [--catalog-root <path>]
  catalogit publish  [--catalog-root <path>]
                     [--dry-run]         bundle locally only; no S3 contact
                     [--out <path>]      write bundle to file (requires --dry-run)
                     --bucket <name>     required unless --dry-run
                     [--key <name>]      default: catalog.json
                     [--region <name>]
                     [--if-match <etag>] override the state-file ETag (skips state-file logic)
                     [--force]           skip state-file conflict guard (publish unconditionally)
  catalogit pull     --bucket <name>
                     [--catalog-root <path>]
                     [--key <name>]      default: catalog.json
                     [--region <name>]
                     [--prune]           delete local-only files without prompting
                     [--no-prune]        keep local-only files without prompting
  catalogit add <id> [--from <url-or-path>] [--from-github <owner/repo>]
                     [--coding-agent codex|claude]
                     [--force] [--skeleton]
  catalogit discover [--owner <github-org>] [--include-archived]
                     [--add <names>]         comma-separated; use '*' for all
                     [--coding-agent codex|claude]
                     [--force] [--skeleton]

catalog-root resolution (highest to lowest):
  1. explicit --catalog-root <path>
  2. \$CATALOGIT_ROOT env var
  3. \${XDG_DATA_HOME:-\$HOME/.local/share}/catalogit/

validate Spine-check every <catalogRoot>/projects/*.yaml. Reports issues
         with file path + reason. Exit 0 when clean, 1 when any project fails.

publish  Bundle the local catalog and upload to s3://<bucket>/<key>.
         --dry-run  Bundle locally and write to stdout (or --out); no S3 call.
                    Safe preview of what publish would upload.
         --out      Write the dry-run bundle to <path> instead of stdout.
                    Only valid with --dry-run.
         Without --dry-run, --bucket is required. publish reads
         <catalogRoot>/.catalogit-state.json (written by pull) and sends
         If-Match: <etag> to prevent overwriting concurrent changes (exit 5
         on 412). --force skips the state-file check and publishes without
         If-Match. --if-match <etag> overrides the state-file value directly.
         On success, updates .catalogit-state.json with the new ETag.

pull     Download s3://<bucket>/<key> and sync local <catalogRoot>/projects/.
         Writes or overwrites each project YAML with the bundle's canonical
         content. Local-only YAMLs (not in the bundle) are handled per
         --prune / --no-prune; without either flag, prompts interactively.
         Writes <catalogRoot>/.catalogit-state.json with the S3 ETag so the
         next publish can use it as the conflict-detection baseline.

add      Draft and write a single project entry. <id> is "owner/repo".
         Requires the \`gh\` CLI and a coding agent (codex or claude) on PATH.
         --from        Local path or URL to inspect instead of cloning from GitHub.
         --from-github Fetch repo description/topics from a different owner/repo.
         --force       Re-draft even if the project is already cataloged.
         --skeleton    Write a skeleton YAML without running the coding agent.

discover List a GitHub owner's repos and import a selection. Without --add,
         opens an interactive checkbox (requires a TTY).
         Requires the \`gh\` CLI and a coding agent (codex or claude) on PATH.
         --owner            GitHub org/user whose repos to list (default: authenticated user).
         --include-archived Include archived repos in the listing.
         --add              Comma-separated repo names to import non-interactively; '*' for all.
         --force            Re-draft already-cataloged projects.
         --skeleton         Write skeleton YAMLs without running the coding agent.
`;
