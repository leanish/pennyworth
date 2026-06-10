import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";

import {
  awsClientDefaults,
  buildRuntime,
  ClaudeCodeRunner,
  CodexRunner,
  ConsoleLogger,
  createSqsLambdaShim,
  defaultRuntimeSkillsDir,
  DynamoConsumerRegistry,
  DynamoIdempotencyStore,
  loadDescriptorFromFile,
  LocalGitWorkspace,
  S3Catalog,
  wireClients,
  type ClaudeCodeRunnerOptions,
  type CodexRunnerOptions,
  type CodingAgentRunner,
  type ConsumerRecord,
  type SqsBatchResponse,
  type SqsEvent,
} from "@leanish/runtime/lambda";
import { S3Client as AwsS3Client } from "@aws-sdk/client-s3";
import { SSMClient } from "@aws-sdk/client-ssm";

import agent from "./agent.js";
import { createSigningKeyResolver } from "./signing-key-resolver.js";

/**
 * ATC's AWS Lambda entry module. The exported `handler` is the function
 * registered with the Lambda runtime; AWS event source mapping for the
 * input SQS queue routes records to it.
 *
 * One-shot cold-start init builds:
 *   - The parsed `agent.yaml` descriptor
 *   - The DynamoDB-backed `IdempotencyStore` (ADR-0006)
 *   - The DynamoDB-backed `ConsumerRegistry` (envelope-verification side)
 *   - The S3-backed `Catalog`
 *   - The `LocalGitWorkspace` rooted at `/tmp` (Lambda's writable mount)
 *   - The wired `runtime` (catalog + workspace + clients + runners)
 *   - The SQS Lambda shim that wraps verify → claim → dispatch → complete
 *
 * The Lambda runtime calls `handler(event)` per invocation; init runs
 * once per cold container.
 *
 * Required env vars (provisioned by `agent-infra`):
 *
 *   AWS_REGION                    — standard AWS env var.
 *   IDEMPOTENCY_TABLE_NAME        — DynamoDB table per ADR-0006.
 *   CONSUMER_REGISTRY_TABLE_NAME  — DynamoDB table per ADR-0006 + ATC §queue-api.
 *   CATALOG_BUCKET                — S3 bucket holding the catalog bundle.
 *   CATALOG_KEY                   — optional, defaults to `catalog.json`.
 *   CATALOG_TTL_MS                — optional, defaults to 5 minutes. Background-
 *                                   refresh window for the cached catalog snapshot
 *                                   (ETag + 304-aware; serves stale on refresh
 *                                   failure). Set to a small value in dev/test
 *                                   to exercise refresh quickly, or to a very
 *                                   large value to effectively disable refresh.
 *   EVENT_BUS_NAME                — EventBridge custom bus for ATC's lifecycle events.
 *   WORKSPACE_ROOT                — optional, defaults to `/tmp/atc-workspaces`.
 *   AGENT_CONFIG_PATH             — optional, override the path to agent.yaml. Defaults
 *                                   to the bundled `<pkg>/agent.yaml` (resolved
 *                                   relative to this module); ops scenarios that ship
 *                                   the descriptor at a non-default path (custom Lambda
 *                                   layers, mounted EFS, etc.) set this explicitly.
 *
 * Skill body location is bundled into the deployable; the path resolves
 * relative to this module so the same code works for `node dist/lambda.js`
 * during local-mode integration runs.
 */
export interface CreateAtcLambdaOptions {
  /** Override per-runner config (timeouts, captureCap, etc.). Optional. */
  readonly claudeCodeOptions?: ClaudeCodeRunnerOptions;
  readonly codexOptions?: CodexRunnerOptions;
  /**
   * Optional full override of the coding-agent runner map. Bypasses the
   * default `claude-code` / `codex` construction entirely — useful for
   * integration tests that wire a `FakeCodingAgentRunner` to avoid
   * spawning the live CLIs. When omitted, the default map is built from
   * `claudeCodeOptions` + `codexOptions`.
   */
  readonly runners?: Map<string, CodingAgentRunner>;
}

/** Lambda handler signature — input is an SQS batch, output is the partial-batch response. */
export type AtcLambdaHandler = (event: SqsEvent) => Promise<SqsBatchResponse>;

/**
 * Construct the Lambda handler. Most production code uses the cached
 * `handler` export below; this factory is the testable seam (so unit
 * tests can override `DynamoDBClient` etc.).
 */
export async function createAtcLambdaHandler(
  options: CreateAtcLambdaOptions = {},
): Promise<AtcLambdaHandler> {
  const region = process.env["AWS_REGION"] ?? "us-east-1";
  const idempotencyTable = requireEnv("IDEMPOTENCY_TABLE_NAME");
  const consumerRegistryTable = requireEnv("CONSUMER_REGISTRY_TABLE_NAME");
  const catalogBucket = requireEnv("CATALOG_BUCKET");
  const catalogKey = process.env["CATALOG_KEY"] ?? "catalog.json";
  const catalogTtlMs = parseOptionalInt("CATALOG_TTL_MS");
  const workspaceRoot = process.env["WORKSPACE_ROOT"] ?? "/tmp/atc-workspaces";

  const agentConfigPath = process.env["AGENT_CONFIG_PATH"] ?? defaultAgentYamlPath();
  const descriptor = await loadDescriptorFromFile(agentConfigPath);
  // The agent's own skills/ directory sits next to its agent.yaml (per
  // ADR-0001 — agent-specific entry-point skills live with the agent).
  // The runtime's bundled skills/ is the fallback for shared support
  // skills (`karpathy-guidelines`); `defaultRuntimeSkillsDir()` resolves
  // to it relative to the @leanish/runtime install.
  const agentSkillsDir = join(dirname(agentConfigPath), "skills");

  // Build the logger early so the S3 catalog can surface refresh errors
  // through it (background-refresh failures don't throw — the only way
  // to observe them is via this callback).
  const logger = new ConsoleLogger({ minLevel: "info" }).with({
    agent: descriptor.identifier,
  });

  const dynamo = new DynamoDBClient({ ...awsClientDefaults(), region });
  const s3 = new AwsS3Client({
    ...awsClientDefaults(),
    region,
    // Path-style addressing is required when talking to a custom S3
    // endpoint (LocalStack, MinIO). Real AWS S3 supports both, so the
    // override is safe to enable whenever an endpoint override is in
    // play. Standard production (no `AWS_ENDPOINT_URL`) uses
    // virtual-hosted addressing per the SDK default.
    ...(process.env["AWS_ENDPOINT_URL"] !== undefined ? { forcePathStyle: true } : {}),
  });
  const ssm = new SSMClient({ ...awsClientDefaults(), region });

  const idempotencyStore = new DynamoIdempotencyStore({
    tableName: idempotencyTable,
    client: dynamo,
  });
  const consumerRegistry = new DynamoConsumerRegistry({
    tableName: consumerRegistryTable,
    client: dynamo,
  });
  const catalog = await S3Catalog.load({
    bucket: catalogBucket,
    key: catalogKey,
    client: s3,
    ...(catalogTtlMs !== undefined ? { snapshotTtlMs: catalogTtlMs } : {}),
    onRefreshError: (err: unknown) => {
      logger.warn("catalog refresh failed; serving stale snapshot", {
        bucket: catalogBucket,
        key: catalogKey,
        error: err instanceof Error ? err.message : String(err),
      });
    },
  });
  const workspace = new LocalGitWorkspace({ workspaceRoot });
  const signingKeyTtlMs = parseOptionalInt("ATC_SIGNING_KEY_TTL_MS");
  const resolveSigningKey = createSigningKeyResolver({
    ssmClient: ssm,
    ...(signingKeyTtlMs !== undefined ? { cacheTtlMs: signingKeyTtlMs } : {}),
  });

  const runners =
    options.runners ??
    new Map<string, CodingAgentRunner>([
      ["claude-code", new ClaudeCodeRunner(options.claudeCodeOptions ?? {})],
      ["codex", new CodexRunner(options.codexOptions ?? {})],
    ]);

  const clients = wireClients({
    mode: "aws",
    needs: descriptor.needs,
    env: process.env,
    region,
    logger,
  });

  const runtime = await buildRuntime({
    descriptor,
    catalog,
    workspace,
    runners,
    clients,
    logger,
    skillsDirs: [agentSkillsDir, defaultRuntimeSkillsDir()],
  });

  return createSqsLambdaShim({
    agent,
    descriptor,
    runtime,
    idempotencyStore,
    consumerRegistry,
    logger: runtime.logger,
    resolveSigningKey,
  });
}

/**
 * Lazy cold-start handler. The first invocation awaits the init Promise;
 * subsequent invocations short-circuit through the cached handler.
 *
 *   export const handler = atcLambdaHandler;
 *
 * is the canonical Lambda registration in `agent-infra`.
 */
let cachedHandlerPromise: Promise<AtcLambdaHandler> | undefined;

export const atcLambdaHandler: AtcLambdaHandler = async (event) => {
  cachedHandlerPromise ??= createAtcLambdaHandler();
  const h = await cachedHandlerPromise;
  return h(event);
};

/**
 * Literal-only resolver kept for unit tests that don't need the
 * SSM Parameter Store round trip. Production code uses
 * `createSigningKeyResolver({...})` (see `signing-key-resolver.ts`),
 * which handles both `literal` and `ssm-parameter` variants with a TTL
 * cache + typed `signing-key-unavailable` errors.
 */
export async function resolveSigningKeyFromRecord(record: ConsumerRecord): Promise<Buffer> {
  const key = record.signingKey;
  if (key.kind === "literal") {
    return Buffer.from(key.base64, "base64");
  }
  throw new Error(
    `resolveSigningKeyFromRecord is the unit-test path and only supports signingKey.kind='literal'. ` +
      `Use createSigningKeyResolver({...}) for the production / integration path.`,
  );
}

function parseOptionalInt(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.length === 0) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(
      `${name} must be a non-negative integer (ms); got '${raw}'. Omit to use the default.`,
    );
  }
  return n;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (v === undefined || v.length === 0) {
    throw new Error(
      `${name} is required in the Lambda environment. ` +
        `agent-infra provisions this; check the deployable's CloudFormation parameters.`,
    );
  }
  return v;
}

function defaultAgentYamlPath(): string {
  // Source: <pkg>/src/lambda.ts → ../agent.yaml.
  // Compiled: <pkg>/dist/lambda.js → ../agent.yaml.
  // Both resolve correctly because agent.yaml is bundled at the package
  // root (see package.json#files).
  return join(dirname(fileURLToPath(import.meta.url)), "..", "agent.yaml");
}
