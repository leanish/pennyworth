import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { S3Client as AwsS3Client } from "@aws-sdk/client-s3";
import { SSMClient } from "@aws-sdk/client-ssm";

import {
  awsClientDefaults,
  buildRuntime,
  ClaudeCodeRunner,
  CodexRunner,
  ConsoleLogger,
  createAwsSelfPublisher,
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
  type SqsBatchResponse,
  type SqsEvent,
} from "@leanish/runtime/lambda";

import agent from "./agent.js";
import { createSigningKeyResolver } from "./signing-key-resolver.js";

/**
 * ship-it's AWS Lambda entry module. The exported `handler` is the function
 * registered with the Lambda runtime; the input SQS queue's event source
 * mapping routes records to it. Two wire shapes arrive on the same queue:
 *
 *   - signed `ship-it-event` consumer envelopes from the webhook normalizer
 *     (verified against the ConsumerRegistry), and
 *   - the agent's own self-published `revisit` runtime messages (delivered
 *     by the EventBridge Scheduler one-shot, ADR-0011).
 *
 * Required env vars (provisioned by `infra/`):
 *
 *   AWS_REGION                    — standard AWS env var.
 *   IDEMPOTENCY_TABLE_NAME        — DynamoDB table per ADR-0006.
 *   CONSUMER_REGISTRY_TABLE_NAME  — DynamoDB table holding consumer records
 *                                   (the webhook normalizer's signing key).
 *   CATALOG_BUCKET                — S3 bucket holding the catalog bundle.
 *   SHIP_IT_QUEUE_URL             — the agent's own input queue URL (self-publish target).
 *   SHIP_IT_QUEUE_ARN             — same queue as ARN (Scheduler targets take ARNs).
 *   SHIP_IT_SCHEDULE_GROUP_NAME   — per-agent EventBridge Scheduler group.
 *   SHIP_IT_SCHEDULER_ROLE_ARN    — role Scheduler assumes to SendMessage to the queue.
 *
 * Optional env vars:
 *
 *   CATALOG_KEY                   — defaults to `catalog.json`.
 *   CATALOG_TTL_MS                — background-refresh window for the cached
 *                                   catalog snapshot; defaults to 5 minutes.
 *   WORKSPACE_ROOT                — defaults to `/tmp/ship-it-workspaces`.
 *   AGENT_CONFIG_PATH             — override the path to agent.yaml; defaults
 *                                   to the bundled `<pkg>/agent.yaml`.
 *   SHIP_IT_SIGNING_KEY_TTL_MS    — TTL for cached consumer signing keys;
 *                                   defaults to 10 minutes.
 */
export interface CreateShipItLambdaOptions {
  /** Override per-runner config (timeouts, captureCap, etc.). Optional. */
  readonly claudeCodeOptions?: ClaudeCodeRunnerOptions;
  readonly codexOptions?: CodexRunnerOptions;
  /**
   * Optional full override of the coding-agent runner map — useful for
   * integration tests that wire a `FakeCodingAgentRunner` to avoid
   * spawning the live CLIs.
   */
  readonly runners?: Map<string, CodingAgentRunner>;
}

/** Lambda handler signature — input is an SQS batch, output is the partial-batch response. */
export type ShipItLambdaHandler = (event: SqsEvent) => Promise<SqsBatchResponse>;

/**
 * Construct the Lambda handler. Production uses the cached `shipItLambdaHandler`
 * export below; this factory is the testable seam.
 */
export async function createShipItLambdaHandler(
  options: CreateShipItLambdaOptions = {},
): Promise<ShipItLambdaHandler> {
  const region = process.env["AWS_REGION"] ?? "us-east-1";
  const idempotencyTable = requireEnv("IDEMPOTENCY_TABLE_NAME");
  const consumerRegistryTable = requireEnv("CONSUMER_REGISTRY_TABLE_NAME");
  const catalogBucket = requireEnv("CATALOG_BUCKET");
  const catalogKey = process.env["CATALOG_KEY"] ?? "catalog.json";
  const catalogTtlMs = parseOptionalInt("CATALOG_TTL_MS");
  const workspaceRoot = process.env["WORKSPACE_ROOT"] ?? "/tmp/ship-it-workspaces";
  const selfQueueUrl = requireEnv("SHIP_IT_QUEUE_URL");
  const selfQueueArn = requireEnv("SHIP_IT_QUEUE_ARN");
  const scheduleGroupName = requireEnv("SHIP_IT_SCHEDULE_GROUP_NAME");
  const schedulerRoleArn = requireEnv("SHIP_IT_SCHEDULER_ROLE_ARN");

  const agentConfigPath = process.env["AGENT_CONFIG_PATH"] ?? defaultAgentYamlPath();
  const descriptor = await loadDescriptorFromFile(agentConfigPath);
  // The agent's own skills/ directory sits next to its agent.yaml (per
  // ADR-0001); the runtime's bundled skills/ is the fallback for shared
  // support skills (`karpathy-guidelines`).
  const agentSkillsDir = join(dirname(agentConfigPath), "skills");

  const logger = new ConsoleLogger({ minLevel: "info" }).with({
    agent: descriptor.identifier,
  });

  const dynamo = new DynamoDBClient({ ...awsClientDefaults(), region });
  const s3 = new AwsS3Client({
    ...awsClientDefaults(),
    region,
    // Path-style addressing is required for custom S3 endpoints
    // (LocalStack, MinIO); real AWS S3 supports both.
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
  const signingKeyTtlMs = parseOptionalInt("SHIP_IT_SIGNING_KEY_TTL_MS");
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

  const selfPublisher = createAwsSelfPublisher({
    agentId: descriptor.identifier,
    queueUrl: selfQueueUrl,
    queueArn: selfQueueArn,
    scheduleGroupName,
    schedulerRoleArn,
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
    selfPublisher,
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
    // ship-it mixes a signedEnvelope consumer trigger with its own UNSIGNED
    // self-published `revisit` runtime messages on the same queue. Without
    // this acknowledgment the shim rejects every revisit delivery (the
    // forgery guard: a consumer with SendMessage could otherwise craft a
    // runtime-message-shaped body and bypass HMAC verification). Setting it
    // is safe HERE because the queue's SendMessage grants are limited to
    // the internal webhook normalizer and the agent's own Scheduler role —
    // see ASSUMPTIONS.md §5.
    allowUnsignedRuntimeMessagesWithConsumerTrigger: true,
  });
}

/**
 * Lazy cold-start handler. The first invocation awaits the init Promise;
 * subsequent invocations short-circuit through the cached handler.
 */
let cachedHandlerPromise: Promise<ShipItLambdaHandler> | undefined;

export const shipItLambdaHandler: ShipItLambdaHandler = async (event) => {
  cachedHandlerPromise ??= createShipItLambdaHandler();
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
        `infra provisions this; check the deployable's CloudFormation parameters.`,
    );
  }
  return v;
}

function defaultAgentYamlPath(): string {
  // Source: <pkg>/src/lambda.ts → ../agent.yaml.
  // Compiled: <pkg>/dist/lambda.js → ../agent.yaml.
  return join(dirname(fileURLToPath(import.meta.url)), "..", "agent.yaml");
}
