import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { S3Client as AwsS3Client } from "@aws-sdk/client-s3";

import {
  awsClientDefaults,
  buildRuntime,
  ClaudeCodeRunner,
  CodexRunner,
  ConsoleLogger,
  createAwsSelfPublisher,
  createSqsLambdaShim,
  defaultRuntimeSkillsDir,
  DynamoIdempotencyStore,
  loadDescriptorFromFile,
  LocalGitWorkspace,
  S3Catalog,
  wireClients,
  type ClaudeCodeRunnerOptions,
  type CodexRunnerOptions,
  type CodingAgentRunner,
  type SqsBatchResponse,
  type SqsEvent,
} from "@leanish/runtime/lambda";

import agent from "./agent.js";

/**
 * bump-it's AWS Lambda entry module. The exported `handler` is the
 * function registered with the Lambda runtime; the AWS event source
 * mapping for the input SQS queue routes records to it.
 *
 * Simpler than ATC's entry by design: bump-it declares a `scheduler`
 * trigger only, so there is no consumer registry, no envelope signing
 * keys, and no terminal reply channel. What it adds over ATC is the
 * self-publisher — `runtime.publish` / `runtime.publishDelayed` back the
 * breakdown fan-out and the delayed revisit loop.
 *
 * One-shot cold-start init builds:
 *   - The parsed `agent.yaml` descriptor (phase-2 parser — scheduler trigger)
 *   - The DynamoDB-backed `IdempotencyStore`
 *   - The S3-backed catalog
 *   - The `LocalGitWorkspace` rooted under `/tmp` (Lambda's writable mount)
 *   - The AWS self-publisher (SQS SendMessage + EventBridge Scheduler one-shots)
 *   - The wired `runtime` and the SQS Lambda shim
 *
 * Required env vars (provisioned by the infra package):
 *
 *   AWS_REGION             — standard AWS env var.
 *   IDEMPOTENCY_TABLE_NAME — DynamoDB table for the three-state delivery claim.
 *   CATALOG_BUCKET         — S3 bucket holding the catalog bundle.
 *   SELF_QUEUE_URL         — the agent's own input queue URL (publish target).
 *   SELF_QUEUE_ARN         — same queue as ARN (Scheduler targets take ARNs).
 *   SCHEDULE_GROUP_NAME    — per-agent EventBridge Scheduler group for one-shot
 *                            revisit schedules.
 *   SCHEDULER_ROLE_ARN     — role Scheduler assumes to SendMessage to the queue.
 *   GITHUB_TOKEN           — via the `github` need: the resolved fine-grained
 *                            PAT the skills' `gh` subprocesses inherit.
 *
 * Optional env vars:
 *
 *   CATALOG_KEY            — defaults to `catalog.json`.
 *   CATALOG_TTL_MS         — background-refresh window for the cached catalog
 *                            snapshot; defaults to 5 minutes.
 *   WORKSPACE_ROOT         — defaults to `/tmp/bump-it-workspaces`.
 *   AGENT_CONFIG_PATH      — override the path to agent.yaml; defaults to the
 *                            bundled `<pkg>/agent.yaml` resolved relative to
 *                            this module.
 */
export interface CreateBumpItLambdaOptions {
  /** Override per-runner config (timeouts, captureCap, etc.). Optional. */
  readonly claudeCodeOptions?: ClaudeCodeRunnerOptions;
  readonly codexOptions?: CodexRunnerOptions;
  /**
   * Optional full override of the coding-agent runner map — useful for
   * integration tests that wire a `FakeCodingAgentRunner` instead of
   * spawning the live CLIs. When omitted, the default map is built from
   * `claudeCodeOptions` + `codexOptions`.
   */
  readonly runners?: Map<string, CodingAgentRunner>;
}

/** Lambda handler signature — input is an SQS batch, output is the partial-batch response. */
export type BumpItLambdaHandler = (event: SqsEvent) => Promise<SqsBatchResponse>;

/**
 * Construct the Lambda handler. Production code uses the cached
 * `bumpItLambdaHandler` export below; this factory is the testable seam.
 */
export async function createBumpItLambdaHandler(
  options: CreateBumpItLambdaOptions = {},
): Promise<BumpItLambdaHandler> {
  const region = process.env["AWS_REGION"] ?? "us-east-1";
  const idempotencyTable = requireEnv("IDEMPOTENCY_TABLE_NAME");
  const catalogBucket = requireEnv("CATALOG_BUCKET");
  const selfQueueUrl = requireEnv("SELF_QUEUE_URL");
  const selfQueueArn = requireEnv("SELF_QUEUE_ARN");
  const scheduleGroupName = requireEnv("SCHEDULE_GROUP_NAME");
  const schedulerRoleArn = requireEnv("SCHEDULER_ROLE_ARN");
  const catalogKey = process.env["CATALOG_KEY"] ?? "catalog.json";
  const catalogTtlMs = parseOptionalInt("CATALOG_TTL_MS");
  const workspaceRoot = process.env["WORKSPACE_ROOT"] ?? "/tmp/bump-it-workspaces";

  const agentConfigPath = process.env["AGENT_CONFIG_PATH"] ?? defaultAgentYamlPath();
  // Phase-2 parser: the descriptor's `scheduler` trigger is rejected by
  // the default (phase-1) parse.
  const descriptor = await loadDescriptorFromFile(agentConfigPath, { phase: "phase-2" });
  // The agent's own skills/ directory sits next to its agent.yaml;
  // the runtime's bundled skills/ is the fallback for shared support
  // skills (karpathy-guidelines).
  const agentSkillsDir = join(dirname(agentConfigPath), "skills");

  const logger = new ConsoleLogger({ minLevel: "info" }).with({
    agent: descriptor.identifier,
  });

  const dynamo = new DynamoDBClient({ ...awsClientDefaults(), region });
  const s3 = new AwsS3Client({
    ...awsClientDefaults(),
    region,
    // Path-style addressing for custom S3 endpoints (LocalStack, MinIO);
    // real AWS S3 accepts both.
    ...(process.env["AWS_ENDPOINT_URL"] !== undefined ? { forcePathStyle: true } : {}),
  });

  const idempotencyStore = new DynamoIdempotencyStore({
    tableName: idempotencyTable,
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

  const selfPublisher = createAwsSelfPublisher({
    agentId: descriptor.identifier,
    queueUrl: selfQueueUrl,
    queueArn: selfQueueArn,
    scheduleGroupName,
    schedulerRoleArn,
    region,
    logger,
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
    selfPublisher,
  });

  // No consumerRegistry: the only trigger is `scheduler`, so every queue
  // body is a runtime message (scheduler tick or self-published fan-out)
  // and the input queue is IAM-private — no envelope verification path.
  return createSqsLambdaShim({
    agent,
    descriptor,
    runtime,
    idempotencyStore,
    logger: runtime.logger,
  });
}

/**
 * Lazy cold-start handler. The first invocation awaits the init Promise;
 * subsequent invocations short-circuit through the cached handler.
 *
 *   export const handler = bumpItLambdaHandler;
 *
 * is the canonical Lambda registration in the infra package.
 */
let cachedHandlerPromise: Promise<BumpItLambdaHandler> | undefined;

export const bumpItLambdaHandler: BumpItLambdaHandler = async (event) => {
  cachedHandlerPromise ??= createBumpItLambdaHandler();
  const h = await cachedHandlerPromise;
  return h(event);
};

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
        `The infra package provisions this; check the deployable's parameters.`,
    );
  }
  return v;
}

function defaultAgentYamlPath(): string {
  // Source: <pkg>/src/lambda.ts → ../agent.yaml.
  // Compiled: <pkg>/dist/lambda.js → ../agent.yaml.
  // Both resolve because agent.yaml ships at the package root
  // (see package.json#files).
  return join(dirname(fileURLToPath(import.meta.url)), "..", "agent.yaml");
}
