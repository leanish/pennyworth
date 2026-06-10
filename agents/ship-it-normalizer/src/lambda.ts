import { S3Client as AwsS3Client } from "@aws-sdk/client-s3";
import { SQSClient } from "@aws-sdk/client-sqs";

import { S3Catalog, type CatalogReadOnly } from "@leanish/catalog-it";
import { awsClientDefaults, ConsoleLogger, type Logger } from "@leanish/runtime";

import { InMemoryTtlDedupeStore, type DedupeStore } from "./dedupe.js";
import { createNormalizerHandler, type NormalizerHandler } from "./handler.js";
import { SqsEnvelopeSender, type EnvelopeSender, type SqsSendClient } from "./sender.js";

/**
 * The webhook normalizer's AWS Lambda entry module (HTTP via a Lambda
 * Function URL). The exported `normalizerLambdaHandler` is the function
 * registered with the Lambda runtime.
 *
 * Required env vars:
 *
 *   AWS_REGION             — standard AWS env var; defaults to `us-east-1`.
 *   GITHUB_WEBHOOK_SECRET  — HMAC secret shared with the GitHub webhook
 *                            (`X-Hub-Signature-256` verification).
 *   JIRA_WEBHOOK_SECRET    — static shared secret the Jira webhook sends in
 *                            `x-leanish-webhook-secret` (v1 seam; JWT later).
 *   ENVELOPE_SIGNING_KEY   — base64-encoded signing-key bytes for outbound
 *                            `ship-it-event` envelopes. SSM-SecureString-backed
 *                            at deploy time (infra injects the decrypted value);
 *                            MUST equal the `webhook-normalizer` ConsumerRecord
 *                            key in ship-it's ConsumerRegistry.
 *   SHIP_IT_QUEUE_URL      — ship-it's input SQS queue (SendMessage target).
 *   CATALOG_BUCKET         — S3 bucket holding the catalog bundle.
 *   JIRA_PROJECT_MAP       — JSON object mapping Jira project keys to catalog
 *                            projectIds, e.g. `{"ABC": "acme/widgets"}`.
 *
 * Optional env vars:
 *
 *   CATALOG_KEY            — catalog object key; defaults to `catalog.json`.
 *   JIRA_ACCEPTANCE_FIELD  — Jira custom field id carrying acceptance
 *                            criteria (e.g. `customfield_10042`); when unset,
 *                            requests omit `acceptanceCriteria`.
 *
 * Secrets are deliberately SEPARATE: the inbound webhook secrets
 * (`GITHUB_WEBHOOK_SECRET`, `JIRA_WEBHOOK_SECRET`) authenticate providers
 * to this Lambda; the outbound `ENVELOPE_SIGNING_KEY` authenticates this
 * Lambda to ship-it. Rotating one never touches the other.
 */
export interface CreateNormalizerLambdaOptions {
  /** Inject a catalog (tests); skips `CATALOG_BUCKET` + the S3 fetch. */
  readonly catalog?: CatalogReadOnly;
  /** Inject a dedupe store; defaults to the in-memory TTL store (see ASSUMPTIONS.md §1). */
  readonly dedupe?: DedupeStore;
  /** Inject a sender (tests); skips `SHIP_IT_QUEUE_URL` + the SQS client. */
  readonly sender?: EnvelopeSender;
  /** Inject an SQS client (LocalStack); ignored when `sender` is supplied. */
  readonly sqsClient?: SqsSendClient;
}

/**
 * Construct the Function URL handler. Production uses the cached
 * `normalizerLambdaHandler` export below; this factory is the testable seam.
 */
export async function createNormalizerLambdaHandler(
  options: CreateNormalizerLambdaOptions = {},
): Promise<NormalizerHandler> {
  const region = process.env["AWS_REGION"] ?? "us-east-1";
  const githubWebhookSecret = requireEnv("GITHUB_WEBHOOK_SECRET");
  const jiraWebhookSecret = requireEnv("JIRA_WEBHOOK_SECRET");
  const envelopeSigningKey = Buffer.from(requireEnv("ENVELOPE_SIGNING_KEY"), "base64");
  const jiraProjectMap = parseJiraProjectMap(requireEnv("JIRA_PROJECT_MAP"));
  const jiraAcceptanceFieldId = process.env["JIRA_ACCEPTANCE_FIELD"];

  const logger = new ConsoleLogger({ minLevel: "info" }).with({
    component: "ship-it-normalizer",
  });

  const catalog = options.catalog ?? (await loadS3Catalog(region, logger));
  const sender =
    options.sender ??
    new SqsEnvelopeSender({
      queueUrl: requireEnv("SHIP_IT_QUEUE_URL"),
      client: options.sqsClient ?? new SQSClient({ ...awsClientDefaults(), region }),
    });

  return createNormalizerHandler({
    githubWebhookSecret,
    jiraWebhookSecret,
    envelopeSigningKey,
    catalog,
    jiraProjectMap,
    ...(jiraAcceptanceFieldId !== undefined && jiraAcceptanceFieldId.length > 0
      ? { jiraAcceptanceFieldId }
      : {}),
    dedupe: options.dedupe ?? new InMemoryTtlDedupeStore(),
    sender,
    logger,
  });
}

/**
 * Lazy cold-start handler. The first invocation awaits the init Promise;
 * subsequent invocations short-circuit through the cached handler.
 */
let cachedHandlerPromise: Promise<NormalizerHandler> | undefined;

export const normalizerLambdaHandler: NormalizerHandler = async (event) => {
  cachedHandlerPromise ??= createNormalizerLambdaHandler();
  const h = await cachedHandlerPromise;
  return h(event);
};

async function loadS3Catalog(region: string, logger: Logger): Promise<CatalogReadOnly> {
  const bucket = requireEnv("CATALOG_BUCKET");
  const key = process.env["CATALOG_KEY"] ?? "catalog.json";
  const s3 = new AwsS3Client({
    ...awsClientDefaults(),
    region,
    // Path-style addressing is required for custom S3 endpoints
    // (LocalStack, MinIO); real AWS S3 supports both.
    ...(process.env["AWS_ENDPOINT_URL"] !== undefined ? { forcePathStyle: true } : {}),
  });
  return S3Catalog.load({
    bucket,
    key,
    client: s3,
    onRefreshError: (err: unknown) => {
      logger.warn("catalog refresh failed; serving stale snapshot", {
        bucket,
        key,
        error: err instanceof Error ? err.message : String(err),
      });
    },
  });
}

function parseJiraProjectMap(raw: string): Readonly<Record<string, string>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("JIRA_PROJECT_MAP must be valid JSON, e.g. '{\"ABC\": \"acme/widgets\"}'");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("JIRA_PROJECT_MAP must be a JSON object of jiraKey → projectId");
  }
  const entries = Object.entries(parsed as Record<string, unknown>);
  for (const [jiraKey, projectId] of entries) {
    if (typeof projectId !== "string" || projectId.length === 0) {
      throw new Error(
        `JIRA_PROJECT_MAP['${jiraKey}'] must be a non-empty projectId string`,
      );
    }
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (v === undefined || v.length === 0) {
    throw new Error(
      `${name} is required in the Lambda environment. ` +
        `infra provisions this; check the deployable's configuration.`,
    );
  }
  return v;
}
