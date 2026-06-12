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
  createTargetCredentialsResolver,
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
 * document-it's AWS Lambda entry module. The exported `handler` is the
 * function registered with the Lambda runtime; the AWS event source
 * mapping for the agent's own input SQS queue routes records to it.
 *
 * Scheduler-trigger agent: the queue receives the EventBridge Scheduler
 * cron tick (stage=init) and the handler's own `runtime.publish` fan-out
 * (stage=breakdown, sourceTrigger=self). There is no consumer trigger,
 * so no `ConsumerRegistry` and no envelope signing key are wired —
 * envelope-shaped bodies are rejected by the shim.
 *
 * Required env vars (provisioned by `infra/`):
 *
 *   AWS_REGION                — standard AWS env var.
 *   IDEMPOTENCY_TABLE_NAME    — DynamoDB idempotency table.
 *   CATALOG_BUCKET            — S3 bucket holding the catalog bundle.
 *   CATALOG_KEY               — optional, defaults to `catalog.json`.
 *   CATALOG_TTL_MS            — optional, background-refresh window for the
 *                               cached catalog snapshot (defaults inside
 *                               S3Catalog).
 *   SELF_QUEUE_URL            — the agent's own input queue URL
 *                               (`runtime.publish` target).
 *   SELF_QUEUE_ARN            — same queue as ARN (EventBridge Scheduler
 *                               targets take ARNs).
 *   SCHEDULE_GROUP_NAME       — per-agent EventBridge Scheduler group for
 *                               `runtime.publishDelayed` one-shot schedules.
 *   SCHEDULER_ROLE_ARN        — role Scheduler assumes to SendMessage to the
 *                               queue.
 *   WORKSPACE_ROOT            — optional, defaults to
 *                               `/tmp/document-it-workspaces`.
 *   AGENT_CONFIG_PATH         — optional, override the path to agent.yaml.
 *                               Defaults to the bundled `<pkg>/agent.yaml`.
 *   GITHUB_TOKEN              — the `github` need; expected in the Lambda
 *                               environment and inherited by the coding-agent
 *                               subprocess (the `verify-docs` skill drives
 *                               `gh`). ADR-0010 plans cold-start resolution
 *                               from SSM Parameter Store SecureString, but
 *                               neither the runtime nor infra implements that
 *                               yet — provisioning the secret into the env is
 *                               currently a deploy-time concern.
 */
export interface CreateDocumentItLambdaOptions {
  /** Override per-runner config (timeouts, captureCap, etc.). Optional. */
  readonly claudeCodeOptions?: ClaudeCodeRunnerOptions;
  readonly codexOptions?: CodexRunnerOptions;
  /**
   * Optional full override of the coding-agent runner map — useful for
   * integration tests that wire a `FakeCodingAgentRunner` instead of
   * spawning the live CLIs.
   */
  readonly runners?: Map<string, CodingAgentRunner>;
}

/** Lambda handler signature — input is an SQS batch, output is the partial-batch response. */
export type DocumentItLambdaHandler = (event: SqsEvent) => Promise<SqsBatchResponse>;

/**
 * Construct the Lambda handler. Production uses the cached
 * `documentItLambdaHandler` export below; this factory is the testable
 * seam.
 */
export async function createDocumentItLambdaHandler(
  options: CreateDocumentItLambdaOptions = {},
): Promise<DocumentItLambdaHandler> {
  const region = process.env["AWS_REGION"] ?? "us-east-1";
  const idempotencyTable = requireEnv("IDEMPOTENCY_TABLE_NAME");
  const catalogBucket = requireEnv("CATALOG_BUCKET");
  const catalogKey = process.env["CATALOG_KEY"] ?? "catalog.json";
  const catalogTtlMs = parseOptionalInt("CATALOG_TTL_MS");
  const selfQueueUrl = requireEnv("SELF_QUEUE_URL");
  const selfQueueArn = requireEnv("SELF_QUEUE_ARN");
  const scheduleGroupName = requireEnv("SCHEDULE_GROUP_NAME");
  const schedulerRoleArn = requireEnv("SCHEDULER_ROLE_ARN");
  const workspaceRoot = process.env["WORKSPACE_ROOT"] ?? "/tmp/document-it-workspaces";

  const agentConfigPath = process.env["AGENT_CONFIG_PATH"] ?? defaultAgentYamlPath();
  // The scheduler trigger is a phase-2 descriptor feature; the default
  // (phase-1) parser rejects it, so the entry shim opts in explicitly.
  const descriptor = await loadDescriptorFromFile(agentConfigPath, { phase: "phase-2" });
  // The agent's own skills/ directory sits next to its agent.yaml
  // (entry-point skills live with the agent); the runtime's bundled
  // skills/ is the fallback for shared support skills
  // (`karpathy-guidelines`).
  const agentSkillsDir = join(dirname(agentConfigPath), "skills");

  const logger = new ConsoleLogger({ minLevel: "info" }).with({
    agent: descriptor.identifier,
  });

  const dynamo = new DynamoDBClient({ ...awsClientDefaults(), region });
  const s3 = new AwsS3Client({
    ...awsClientDefaults(),
    region,
    // Path-style addressing is required against custom S3 endpoints
    // (LocalStack, MinIO); real AWS S3 supports both.
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
    ...(descriptor.needs.includes("target-credentials")
      ? {
          targetCredentials: createTargetCredentialsResolver({
            catalog,
            mode: "aws",
            region,
            logger,
          }),
        }
      : {}),
  });

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
 *   export const handler = documentItLambdaHandler;
 *
 * is the canonical Lambda registration in `infra/`.
 */
let cachedHandlerPromise: Promise<DocumentItLambdaHandler> | undefined;

export const documentItLambdaHandler: DocumentItLambdaHandler = async (event) => {
  cachedHandlerPromise ??= createDocumentItLambdaHandler();
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
  // Both resolve correctly because agent.yaml is bundled at the package
  // root (see package.json#files).
  return join(dirname(fileURLToPath(import.meta.url)), "..", "agent.yaml");
}
