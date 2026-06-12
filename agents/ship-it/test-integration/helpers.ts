import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// SendMessage is needed to (a) deliver consumer envelopes onto the real
// input queue and (b) reproduce the EventBridge Scheduler fire (LocalStack
// Community stores schedules but never executes them — see the runtime's
// test-integration/self-publish.test.ts). The SQS SDK package resolves
// from the workspace root (it is a dependency of @leanish/runtime);
// integration-test-only, never imported by src/.
import { SendMessageCommand } from "@aws-sdk/client-sqs";

import { canonicalize, DynamoConsumerRegistry } from "@leanish/runtime";
import type { LocalStackHarness } from "@leanish/runtime/testing";

/** The consumerId + kind the webhook normalizer registers under (README §ConsumerRegistry). */
export const NORMALIZER_CONSUMER_ID = "webhook-normalizer";
export const SHIP_IT_EVENT_KIND = "ship-it-event";

/** Every env var `createShipItLambdaHandler` reads — captured/restored by the suites. */
export const SHIP_IT_ENV_NAMES = [
  "IDEMPOTENCY_TABLE_NAME",
  "CONSUMER_REGISTRY_TABLE_NAME",
  "CATALOG_BUCKET",
  "CATALOG_KEY",
  "CATALOG_TTL_MS",
  "WORKSPACE_ROOT",
  "AGENT_CONFIG_PATH",
  "SELF_QUEUE_URL",
  "SELF_QUEUE_ARN",
  "SCHEDULE_GROUP_NAME",
  "SCHEDULER_ROLE_ARN",
  "SHIP_IT_SIGNING_KEY_TTL_MS",
] as const;

/** A catalog project record in the deployed bundle shape (ADR-0014 `version: "1"`). */
export interface CatalogProjectRecord {
  readonly id: string;
  readonly source: { readonly url: string; readonly branch: string };
  readonly extensions: Readonly<Record<string, unknown>>;
}

export interface ShipItStackContext {
  readonly queueUrl: string;
  readonly queueArn: string;
  readonly scheduleGroupName: string;
  readonly idempotencyTable: string;
  readonly consumerRegistryTable: string;
  readonly catalogBucket: string;
  /** Raw HMAC secret registered for the `webhook-normalizer` consumer (via SSM SecureString). */
  readonly consumerSecret: string;
}

/**
 * Provision one fresh ship-it deployment on LocalStack and point the
 * Lambda env contract at it:
 *
 *   - DynamoDB idempotency + consumer-registry tables (real conditional writes)
 *   - S3 catalog bundle (real `S3Catalog.load` at handler build)
 *   - SQS input queue (consumer envelopes AND self-published revisits)
 *   - EventBridge Scheduler group (real `CreateSchedule` from publishDelayed)
 *   - SSM SecureString signing key + the deployment-shaped ConsumerRecord
 *     (`kind: "ssm-parameter"`), so envelope verification exercises ship-it's
 *     own `createSigningKeyResolver` end to end.
 */
export async function provisionShipItStack(
  stack: LocalStackHarness,
  projects: ReadonlyArray<CatalogProjectRecord>,
): Promise<ShipItStackContext> {
  const idempotencyTable = await stack.createIdempotencyTable("ship-it-idem");
  const consumerRegistryTable = await stack.createConsumerRegistryTable("ship-it-consumers");
  const catalogBucket = await stack.createBucket("ship-it-catalog");
  const queue = await stack.createQueue("ship-it-input");
  const scheduleGroupName = await stack.createScheduleGroup("ship-it-schedules");

  // Deployed bundle shape per catalog-it's `bundleCatalog` (`data-format.md`).
  await stack.putObject(
    catalogBucket,
    "catalog.json",
    JSON.stringify({ version: "1", projects }),
    "application/json",
  );

  const consumerSecret = `ship-it-e2e-secret-${stack.id}`;
  const parameterName = await stack.createSecureStringParameter(
    `/leanish/test/${stack.id}/webhook-normalizer-hmac`,
    consumerSecret,
  );
  const registry = new DynamoConsumerRegistry({
    tableName: consumerRegistryTable,
    client: stack.dynamoClient(),
  });
  await registry.put({
    consumerId: NORMALIZER_CONSUMER_ID,
    signingKey: { kind: "ssm-parameter", name: parameterName },
    allowedKinds: [SHIP_IT_EVENT_KIND],
  });

  process.env["IDEMPOTENCY_TABLE_NAME"] = idempotencyTable;
  process.env["CONSUMER_REGISTRY_TABLE_NAME"] = consumerRegistryTable;
  process.env["CATALOG_BUCKET"] = catalogBucket;
  process.env["SELF_QUEUE_URL"] = queue.queueUrl;
  process.env["SELF_QUEUE_ARN"] = queue.queueArn;
  process.env["SCHEDULE_GROUP_NAME"] = scheduleGroupName;
  process.env["SCHEDULER_ROLE_ARN"] = "arn:aws:iam::000000000000:role/scheduler-send";
  process.env["WORKSPACE_ROOT"] = mkdtempSync(join(tmpdir(), "ship-it-e2e-workspace-"));

  return {
    queueUrl: queue.queueUrl,
    queueArn: queue.queueArn,
    scheduleGroupName,
    idempotencyTable,
    consumerRegistryTable,
    catalogBucket,
    consumerSecret,
  };
}

/**
 * A throwaway local git repository (one commit on `main`) usable as a
 * catalog `source.url` — `LocalGitWorkspace` clones plain paths with the
 * same code path as remote URLs, so the working-copy sync is real.
 */
export function createLocalGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "ship-it-e2e-repo-"));
  const git = (args: ReadonlyArray<string>): void => {
    execFileSync("git", [...args], { cwd: dir, stdio: "ignore" });
  };
  git(["init", "-b", "main"]);
  writeFileSync(join(dir, "README.md"), "# ship-it e2e fixture project\n");
  git(["add", "."]);
  git([
    "-c",
    "user.email=e2e@example.test",
    "-c",
    "user.name=e2e",
    "commit",
    "-m",
    "fixture commit",
  ]);
  return dir;
}

/** A valid `ShipItRequest` for the fixture project; override per test. */
export function shipItRequest(
  projectId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ticketKey: "ABC-123",
    projectId,
    ticketStatus: "Ready for Implementation",
    labels: ["ship-it", "backend"],
    ticketSummary: "Add a widget counter",
    ticketDescription: "Show the number of widgets on the dashboard.",
    acceptanceCriteria: ["the dashboard shows the widget count"],
    ...overrides,
  };
}

/**
 * Sign a `ship-it-event` envelope exactly as the webhook normalizer does:
 * HMAC-SHA256 hex over
 * `timestamp\nconsumer\nendUser\n<conversationKey-or-empty>\ncanonicalize(payload)`.
 */
export function makeSignedEnvelope(args: {
  readonly payload: Record<string, unknown>;
  readonly secret: string;
  readonly requestId?: string;
  readonly endUser?: string;
  readonly tamper?: boolean;
}): Record<string, unknown> {
  const timestamp = new Date().toISOString();
  const endUser = args.endUser ?? "jira:e2e-user";
  const message =
    timestamp +
    "\n" +
    NORMALIZER_CONSUMER_ID +
    "\n" +
    endUser +
    "\n" +
    "" +
    "\n" +
    canonicalize(args.payload);
  const signature = createHmac("sha256", args.secret).update(message).digest("hex");
  return {
    kind: SHIP_IT_EVENT_KIND,
    requestId: args.requestId ?? `evt-${Date.now()}`,
    consumer: NORMALIZER_CONSUMER_ID,
    endUser,
    timestamp,
    payload: args.payload,
    signature: args.tamper === true ? signature.replace(/^./, (c) => (c === "0" ? "1" : "0")) : signature,
  };
}

/** Deliver a raw body to the real input queue (consumer envelope or Scheduler fire). */
export async function sendToQueue(
  stack: LocalStackHarness,
  queueUrl: string,
  body: string,
): Promise<void> {
  await stack
    .sqsClient()
    .send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: body }));
}

/** Read exactly one message off the queue; fail loudly otherwise. */
export async function readOneMessage(
  stack: LocalStackHarness,
  queueUrl: string,
): Promise<{ body: string; messageId: string }> {
  const messages = await stack.readMessages(queueUrl, { maxMessages: 1, timeoutMs: 10_000 });
  if (messages.length !== 1 || messages[0] === undefined) {
    throw new Error(`expected exactly 1 message on ${queueUrl}, got ${messages.length}`);
  }
  return messages[0];
}

/** Wrap a skill output object in the fenced-JSON shape the runners emit. */
export function fenced(value: unknown): { responseText: string } {
  return { responseText: "```json\n" + JSON.stringify(value) + "\n```" };
}
