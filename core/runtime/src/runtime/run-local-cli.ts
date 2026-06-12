import { readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs as nodeParseArgs } from "node:util";

import { randomUUID } from "node:crypto";

import {
  type CatalogReadOnly,
  FilesystemCatalog,
  InMemoryCatalog,
} from "@leanish/catalog-it";

import { loadDescriptorFromFile } from "../descriptor/parse.js";
import { MemoryConsumerRegistry } from "../consumer-registry/memory.js";
import { envelopeToRuntimeMessage } from "../envelope/to-runtime-message.js";
import { type SignedEnvelope, verifyEnvelope } from "../envelope/verify.js";
import { ConsoleLogger } from "../logger/console-logger.js";
import { wireClients } from "../needs/wire-clients.js";
import { ClaudeCodeRunner } from "../skill/claude-code-runner.js";
import { CodexRunner } from "../skill/codex-runner.js";
import { FakeCodingAgentRunner } from "../skill/fake-runner.js";
import type { CodingAgentRunner } from "../skill/runner.js";
import type { AgentDefinition } from "../types/agent.js";
import type { Logger } from "../types/logger.js";
import type { RuntimeMessage } from "../types/runtime-message.js";
import { InMemoryWorkspace } from "../working-copy/in-memory-workspace.js";
import { LocalGitWorkspace } from "../working-copy/local-git-workspace.js";
import type { Workspace } from "../working-copy/workspace.js";

import { buildRuntime, defaultRuntimeSkillsDir } from "./build-runtime.js";
import { runLocal } from "./run-local.js";

/**
 * CLI entry point exported separately from the `bin/` script so it can be
 * unit-tested and re-used programmatically.
 *
 * Surface (deliberately small for phase 1):
 *
 *   agent-runtime run-local --agent-config <path> [--agent-module <path>]
 *                          [--message <path>]
 *                          [--catalog-root <path>]
 *                          [--workspace-root <path>]
 *                          [--skills-dir <path>]
 *                          [--fake-runner]
 *                          [--consumer-secret <secret>]
 *                          [--log-level <debug|info|warn|error>]
 *
 * Reading the message: `--message <path>` loads from disk; otherwise stdin
 * is read (so `cat msg.json | run-local …` works).
 *
 * Returns the process exit code so the bin script can map it to
 * `process.exit(code)` without losing async cleanup.
 */
export interface RunLocalCliOptions {
  readonly stdin?: NodeJS.ReadableStream;
  readonly stdout?: NodeJS.WritableStream;
  readonly stderr?: NodeJS.WritableStream;
}

export async function runLocalCli(
  argv: ReadonlyArray<string>,
  options: RunLocalCliOptions = {},
): Promise<number> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const stdin = options.stdin ?? process.stdin;

  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    stdout.write(USAGE);
    return 0;
  }

  const subcommand = argv[0];
  if (subcommand !== "run-local") {
    stderr.write(`unknown subcommand: ${subcommand}\n\n${USAGE}`);
    return 2;
  }

  let args: ParsedArgs;
  try {
    args = parseArgs(argv.slice(1));
  } catch (err) {
    stderr.write(`${(err as Error).message}\n\n${USAGE}`);
    return 2;
  }

  try {
    await runLocalCommand(args, { stdin, stdout, stderr });
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    stderr.write(`run-local failed: ${message}\n`);
    if (err instanceof Error && err.stack !== undefined) {
      stderr.write(err.stack + "\n");
    }
    return 1;
  }
}

interface ParsedArgs {
  readonly agentConfig: string;
  readonly agentModule: string;
  readonly message?: string;
  readonly catalogRoot?: string;
  readonly workspaceRoot?: string;
  readonly skillsDir?: string;
  readonly fakeRunner: boolean;
  readonly logLevel: "debug" | "info" | "warn" | "error";
  /**
   * Optional consumer signing secret. When provided AND stdin/`--message`
   * is envelope-shaped, the CLI verifies the HMAC against this secret
   * before normalising. Without it, envelope-shaped input is trusted
   * (signature ignored) — the trust-shape default that makes the CLI
   * easy to use with captured production envelopes whose producer key
   * isn't available locally. Read from `$ATC_DEV_CONSUMER_SECRET` if the
   * flag is omitted but the env var is set.
   */
  readonly consumerSecret?: string;
}

function parseArgs(argv: ReadonlyArray<string>): ParsedArgs {
  const { values } = nodeParseArgs({
    args: [...argv],
    options: {
      "agent-config": { type: "string" },
      "agent-module": { type: "string" },
      "message": { type: "string" },
      "catalog-root": { type: "string" },
      "workspace-root": { type: "string" },
      "skills-dir": { type: "string" },
      "fake-runner": { type: "boolean", default: false },
      "log-level": { type: "string", default: "info" },
      "consumer-secret": { type: "string" },
    },
    allowPositionals: false,
    strict: true,
  });

  const agentConfig = values["agent-config"];
  if (agentConfig === undefined) throw new Error("--agent-config is required");
  const agentModule =
    values["agent-module"] ?? join(dirname(resolve(agentConfig)), "dist", "index.js");

  const logLevelRaw = values["log-level"] ?? "info";
  if (
    logLevelRaw !== "debug" &&
    logLevelRaw !== "info" &&
    logLevelRaw !== "warn" &&
    logLevelRaw !== "error"
  ) {
    throw new Error(`--log-level must be one of: debug, info, warn, error`);
  }
  const message = values["message"];
  const catalogRoot = values["catalog-root"];
  const workspaceRoot = values["workspace-root"];
  const skillsDir = values["skills-dir"];
  const consumerSecret = values["consumer-secret"] ?? process.env["ATC_DEV_CONSUMER_SECRET"];

  return {
    agentConfig,
    agentModule,
    fakeRunner: values["fake-runner"] === true,
    logLevel: logLevelRaw,
    ...(message !== undefined ? { message } : {}),
    ...(catalogRoot !== undefined ? { catalogRoot } : {}),
    ...(workspaceRoot !== undefined ? { workspaceRoot } : {}),
    ...(skillsDir !== undefined ? { skillsDir } : {}),
    ...(consumerSecret !== undefined && consumerSecret.length > 0
      ? { consumerSecret }
      : {}),
  };
}

interface RunLocalContext {
  readonly stdin: NodeJS.ReadableStream;
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
}

async function runLocalCommand(args: ParsedArgs, ctx: RunLocalContext): Promise<void> {
  const descriptor = await loadDescriptorFromFile(args.agentConfig);
  const agent = await loadAgentModule(args.agentModule);
  const message = await loadMessage(args.message, ctx.stdin, {
    ...(args.consumerSecret !== undefined ? { consumerSecret: args.consumerSecret } : {}),
  });

  const logger: Logger = new ConsoleLogger({
    minLevel: args.logLevel,
    stream: ctx.stderr,
  }).with({ agent: descriptor.identifier });

  // `buildRuntime` runs the startup-time schema-subset compat gate internally
  // (every declared skill must accept the configured codingAgent — failures
  // throw `DescriptorValidationError`). Custom entry shims get the same
  // check, so the CLI no longer needs to invoke it eagerly.
  //
  // Skill search order: explicit `--skills-dir` wins outright when set
  // (legacy single-dir mode for tests). Otherwise, we look in
  // `<agent-config-dir>/skills/` first (the agent's own entry-point and
  // agent-specific skills) and fall back to the runtime's bundled
  // `skills/` (shared support skills like `karpathy-guidelines`).
  // See ADR-0001 for the locality rationale.
  const resolvedSkillsDirs: ReadonlyArray<string> = args.skillsDir !== undefined
    ? [args.skillsDir]
    : [join(dirname(resolve(args.agentConfig)), "skills"), defaultRuntimeSkillsDir()];

  const catalog = await buildCatalog(args.catalogRoot);
  const workspace = buildWorkspace(args.workspaceRoot);
  const runners = buildRunners(args.fakeRunner);
  const clients = wireClients({
    mode: "local",
    needs: descriptor.needs,
    env: process.env,
    region: process.env["AWS_REGION"] ?? "us-east-1",
    logger,
  });

  const runtime = await buildRuntime({
    descriptor,
    catalog,
    workspace,
    runners,
    clients,
    logger,
    skillsDirs: resolvedSkillsDirs,
  });

  const reply = await runLocal({ agent, descriptor, runtime, message });
  // The handler's return value IS the terminal reply (per the contract).
  // Local mode surfaces it directly on stdout so a developer can pipe it
  // through `jq` or assert against it from a script. Handlers that return
  // `undefined` render as `null` (JSON.stringify's natural undefined →
  // omitted behavior produces "" which we'd rather make explicit), which
  // preserves the JSON-parseable invariant without faking a "status:ok"
  // envelope (the previous behavior masked silent no-op handlers).
  ctx.stdout.write(JSON.stringify(reply ?? null) + "\n");
}

async function loadAgentModule(modulePath: string): Promise<AgentDefinition> {
  const abs = isAbsolute(modulePath) ? modulePath : resolve(modulePath);
  await stat(abs).catch(() => {
    throw new Error(
      `--agent-module path does not exist: ${abs}. Did you build the agent? (npm run build)`,
    );
  });
  const url = pathToFileURL(abs).href;
  const mod = (await import(url)) as { default?: AgentDefinition };
  if (mod.default === undefined || typeof mod.default.handle !== "function") {
    throw new Error(
      `agent module at ${abs} must default-export an AgentDefinition (use defineAgent({...}))`,
    );
  }
  return mod.default;
}

export interface LoadMessageOptions {
  /**
   * Optional consumer signing secret (UTF-8). When provided AND the input
   * is envelope-shaped, the CLI verifies the HMAC against this secret
   * before normalising. The verification uses a synthetic single-record
   * `MemoryConsumerRegistry` built from the envelope's own `consumer`
   * field, so the CLI doesn't need a separate registry on disk — the
   * intent is "this is the secret the producer used to sign this exact
   * envelope". Without the option, envelope-shaped input is trusted
   * (signature ignored) — the trust-shape default that makes the CLI
   * easy to use with captured envelopes whose producer key isn't
   * available locally.
   */
  readonly consumerSecret?: string;
  /** Override for tests. Defaults to `() => new Date().toISOString()`. */
  readonly clock?: () => string;
}

async function loadMessage(
  path: string | undefined,
  stdin: NodeJS.ReadableStream,
  options: LoadMessageOptions = {},
): Promise<RuntimeMessage> {
  const clock = options.clock ?? (() => new Date().toISOString());
  const raw = path === undefined ? await readStdin(stdin) : await readFile(path, "utf8");
  if (raw.trim().length === 0) {
    throw new Error(
      "no message provided — pass --message <file> or pipe a RuntimeMessage or signed envelope JSON on stdin",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `failed to parse message JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("message must be a JSON object matching the RuntimeMessage or envelope shape");
  }
  // Two input shapes are accepted:
  //   - `RuntimeMessage { stage, payload, metadata }` — used directly.
  //   - `SignedEnvelope { kind, consumer, requestId, signature, payload, … }` —
  //     normalised via `envelopeToRuntimeMessage` so a developer can pipe a
  //     captured production envelope into `run-local` for replay/debugging.
  //
  // When `consumerSecret` is supplied, the envelope is HMAC-verified before
  // normalisation (synthetic single-record registry keyed on
  // `envelope.consumer`). Without it, envelope shapes are trusted —
  // sufficient for replay-and-debug, faster when the producer's key is
  // unavailable locally.
  const obj = parsed as Record<string, unknown>;
  if (looksLikeEnvelope(obj)) {
    // With a secret, HMAC-verify and use the parsed result. Without one,
    // trust the shape as-is (the documented replay-and-debug default).
    const envelope =
      options.consumerSecret !== undefined
        ? await verifyEnvelopeWithSecret(obj, options.consumerSecret)
        : (obj as unknown as SignedEnvelope);
    return envelopeToRuntimeMessage(envelope, {
      sqsMessageId: `local-${randomUUID()}`,
      receivedAt: clock(),
    }) as RuntimeMessage;
  }
  return parsed as RuntimeMessage;
}

async function verifyEnvelopeWithSecret(
  envelope: Record<string, unknown>,
  secret: string,
): Promise<SignedEnvelope> {
  const consumerId = envelope["consumer"];
  if (typeof consumerId !== "string" || consumerId.length === 0) {
    // `looksLikeEnvelope` already guarantees this, but TypeScript doesn't
    // know that. Defensive narrow.
    throw new Error("envelope verification: envelope.consumer is missing or empty");
  }
  // Local replay intentionally trusts the captured envelope's own `kind`: we
  // register exactly that kind as allowed, so the registry's `kind-not-allowed`
  // check never fires on this path. HMAC over the captured signature is the
  // only real verification here — this CLI re-checks a single captured
  // envelope, not an arbitrary consumer's allow-list.
  const allowedKindsRaw = envelope["kind"];
  const allowedKinds = typeof allowedKindsRaw === "string" ? [allowedKindsRaw] : [];
  const registry = new MemoryConsumerRegistry([
    {
      consumerId,
      signingKey: { kind: "literal", base64: Buffer.from(secret, "utf8").toString("base64") },
      allowedKinds,
    },
  ]);
  return verifyEnvelope({
    envelope,
    consumerRegistry: registry,
  });
}

function looksLikeEnvelope(value: Record<string, unknown>): boolean {
  // Envelope vs RuntimeMessage discriminator: an envelope has top-level
  // `kind` + `consumer` + `signature` (and no `stage` or `metadata`); a
  // RuntimeMessage has `stage` + `payload` + `metadata`. A captured
  // envelope also carries `requestId` at the top level (not nested
  // under metadata.requestId).
  if (typeof value["stage"] === "string" && typeof value["metadata"] === "object") {
    return false;
  }
  return (
    typeof value["kind"] === "string" &&
    typeof value["consumer"] === "string" &&
    typeof value["signature"] === "string"
  );
}

async function readStdin(stream: NodeJS.ReadableStream): Promise<string> {
  let raw = "";
  for await (const chunk of stream) {
    raw += typeof chunk === "string" ? chunk : (chunk as Buffer).toString("utf8");
  }
  return raw;
}

async function buildCatalog(catalogRoot: string | undefined): Promise<CatalogReadOnly> {
  if (catalogRoot === undefined) return new InMemoryCatalog([]);
  return FilesystemCatalog.load({ catalogRoot });
}

function buildWorkspace(workspaceRoot: string | undefined): Workspace {
  if (workspaceRoot === undefined) return new InMemoryWorkspace();
  return new LocalGitWorkspace({ workspaceRoot });
}

function buildRunners(fake: boolean): ReadonlyMap<string, CodingAgentRunner> {
  if (fake) {
    // CLI smoke-test ergonomics: every declared entrypoint gets a
    // schema-valid synthesised answer so `atc-dev-publish | run-local
    // --fake-runner` works without per-skill registration. The library
    // default is strict (`synthesiseDefault: false`) — the CLI overrides
    // here on purpose.
    return new Map([
      ["claude-code", new FakeCodingAgentRunner("claude-code", [], { synthesiseDefault: true })],
      ["codex", new FakeCodingAgentRunner("codex", [], { synthesiseDefault: true })],
    ]);
  }
  return new Map<string, CodingAgentRunner>([
    ["claude-code", new ClaudeCodeRunner()],
    ["codex", new CodexRunner()],
  ]);
}

const USAGE = `Usage:
  agent-runtime run-local --agent-config <path> [--agent-module <path>]
                          [--message <path>]
                          [--catalog-root <path>]
                          [--workspace-root <path>]
                          [--fake-runner]
                          [--consumer-secret <secret>]
                          [--log-level debug|info|warn|error]

Inputs:
  --agent-config    path to the agent's agent.yaml
  --agent-module    path to the built agent module (default: <agent-dir>/dist/index.js)
  --message         path to a RuntimeMessage OR signed-envelope JSON file (default: read stdin)
  --consumer-secret signing secret for opt-in HMAC verification when input is envelope-shaped
                    (also read from $ATC_DEV_CONSUMER_SECRET; without it envelope input is
                     trusted and signature is ignored — the trust-shape default)

Adapters:
  --catalog-root   FilesystemCatalog root (defaults to an empty InMemoryCatalog)
  --workspace-root LocalGitWorkspace root (defaults to InMemoryWorkspace)
  --skills-dir     single skills directory override (default search order:
                   <agent-config-dir>/skills, then the runtime's bundled skills/)
  --fake-runner    use FakeCodingAgentRunner instead of spawning 'claude'

Misc:
  --log-level      structured-log threshold (default: info)
`;
