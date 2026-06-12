import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { GetScheduleCommand, ListSchedulesCommand } from "@aws-sdk/client-scheduler";
import { SendMessageCommand } from "@aws-sdk/client-sqs";

import { publishCatalog, type Project } from "@leanish/catalog-it";
import type { SelfMessageBody } from "@leanish/runtime";
import { FakeCodingAgentRunner, LocalStackHarness } from "@leanish/runtime/testing";

import { createBumpItLambdaHandler, type BumpItLambdaHandler } from "../src/lambda.js";

const execFileAsync = promisify(execFile);

/**
 * Every env var the bump-it Lambda entry reads. Tests snapshot/restore
 * these around the suite so per-test stacks can set them freely.
 */
export const BUMP_IT_ENV_VARS = [
  "IDEMPOTENCY_TABLE_NAME",
  "CATALOG_BUCKET",
  "CATALOG_KEY",
  "CATALOG_TTL_MS",
  "SELF_QUEUE_URL",
  "SELF_QUEUE_ARN",
  "SCHEDULE_GROUP_NAME",
  "SCHEDULER_ROLE_ARN",
  "WORKSPACE_ROOT",
  "AGENT_CONFIG_PATH",
] as const;

/**
 * Seed a throwaway local git repository (one commit on `main` with a
 * `build.gradle`) and return its `file://` clone URL. Keeps the
 * working-copy sync REAL — `LocalGitWorkspace` runs a genuine `git clone`
 * — without depending on network access to github.com.
 */
export async function seedLocalGitRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bump-it-e2e-repo-"));
  const git = (...args: string[]) => execFileAsync("git", ["-C", dir, ...args]);
  await execFileAsync("git", ["init", "-b", "main", dir]);
  await git("config", "user.email", "bump-it-e2e@example.invalid");
  await git("config", "user.name", "bump-it e2e fixture");
  await writeFile(
    join(dir, "build.gradle"),
    'plugins { id "java" }\ndependencies { }\n',
    "utf8",
  );
  await git("add", "build.gradle");
  await git("commit", "-m", "seed fixture repo");
  return pathToFileURL(dir).href;
}

export interface BumpItStack {
  readonly handler: BumpItLambdaHandler;
  readonly fakeRunner: FakeCodingAgentRunner;
  readonly queueUrl: string;
  readonly queueArn: string;
  readonly scheduleGroup: string;
  readonly idempotencyTable: string;
  readonly bucket: string;
}

/**
 * Provision one fresh bump-it stack on LocalStack: idempotency table,
 * input (self) queue, schedule group, catalog bucket with the given
 * projects published, the env contract `createBumpItLambdaHandler`
 * reads, and the handler itself wired to a strict
 * `FakeCodingAgentRunner` (register per-entrypoint responses on
 * `fakeRunner` before driving messages).
 *
 * Each call simulates one Lambda cold start — building a second stack
 * against the same bucket after a catalog republish models the realistic
 * "breakdown lands on a later cold start that reads the current catalog".
 */
export async function provisionBumpItStack(
  stack: LocalStackHarness,
  projects: ReadonlyArray<Project>,
): Promise<BumpItStack> {
  const idempotencyTable = await stack.createIdempotencyTable("bump-it-idem");
  const { queueUrl, queueArn } = await stack.createQueue("bump-it-input");
  const scheduleGroup = await stack.createScheduleGroup("bump-it-sched");
  const bucket = await stack.createBucket("bump-it-catalog");
  await publishCatalog({ bucket, key: "catalog.json", projects: [...projects], client: stack.s3Client() });

  process.env["IDEMPOTENCY_TABLE_NAME"] = idempotencyTable;
  process.env["CATALOG_BUCKET"] = bucket;
  process.env["SELF_QUEUE_URL"] = queueUrl;
  process.env["SELF_QUEUE_ARN"] = queueArn;
  process.env["SCHEDULE_GROUP_NAME"] = scheduleGroup;
  process.env["SCHEDULER_ROLE_ARN"] = "arn:aws:iam::000000000000:role/bump-it-scheduler-send";
  process.env["WORKSPACE_ROOT"] = await mkdtemp(join(tmpdir(), "bump-it-e2e-ws-"));

  const fakeRunner = new FakeCodingAgentRunner("claude-code");
  const handler = await createBumpItLambdaHandler({
    runners: new Map([["claude-code", fakeRunner]]),
  });

  return { handler, fakeRunner, queueUrl, queueArn, scheduleGroup, idempotencyTable, bucket };
}

/**
 * Build another handler against the env the last `provisionBumpItStack`
 * call left in place — models a fresh Lambda cold start (new container,
 * same provisioned resources) reading the CURRENT catalog from S3.
 */
export async function coldStartHandler(): Promise<{
  handler: BumpItLambdaHandler;
  fakeRunner: FakeCodingAgentRunner;
}> {
  const fakeRunner = new FakeCodingAgentRunner("claude-code");
  const handler = await createBumpItLambdaHandler({
    runners: new Map([["claude-code", fakeRunner]]),
  });
  return { handler, fakeRunner };
}

/** Republish the catalog bundle (curator edit between stages). */
export async function republishCatalog(
  stack: LocalStackHarness,
  bucket: string,
  projects: ReadonlyArray<Project>,
): Promise<void> {
  await publishCatalog({ bucket, key: "catalog.json", projects: [...projects], client: stack.s3Client() });
}

/**
 * The EXACT recurring-tick wire shape agent-infra's EventBridge Scheduler
 * target sends to the input queue (see infra's agent-stack `Tick`):
 * `{"stage":"init","payload":{},"metadata":{"sourceTrigger":"scheduler"}}`.
 */
export function schedulerTickRecord(messageId: string): { messageId: string; body: string } {
  return {
    messageId,
    body: JSON.stringify({
      stage: "init",
      payload: {},
      metadata: { sourceTrigger: "scheduler" },
    }),
  };
}

/** Wrap a value in the canonical fenced-json terminal block. */
export function fencedJson(value: unknown): { responseText: string } {
  return { responseText: ["```json", JSON.stringify(value), "```"].join("\n") };
}

export interface CapturedSchedule {
  readonly name: string;
  readonly expression: string;
  readonly targetInput: string;
  readonly body: SelfMessageBody;
}

/**
 * List every one-shot schedule in the group and resolve each one's
 * `Target.Input` body. LocalStack Community's Scheduler is CRUD-only
 * (schedules never fire), so tests *simulate* the fire by sending
 * `targetInput` to the queue — byte-for-byte what the real SQS
 * SendMessage target delivers.
 */
export async function listSchedules(
  stack: LocalStackHarness,
  groupName: string,
): Promise<CapturedSchedule[]> {
  const scheduler = stack.schedulerClient();
  const listed = await scheduler.send(new ListSchedulesCommand({ GroupName: groupName }));
  const out: CapturedSchedule[] = [];
  for (const summary of listed.Schedules ?? []) {
    const schedule = await scheduler.send(
      new GetScheduleCommand({ Name: summary.Name, GroupName: groupName }),
    );
    if (schedule.Target?.Input === undefined || schedule.ScheduleExpression === undefined) {
      throw new Error(`schedule '${summary.Name}' has no Target.Input/ScheduleExpression`);
    }
    out.push({
      name: summary.Name ?? "",
      expression: schedule.ScheduleExpression,
      targetInput: schedule.Target.Input,
      body: JSON.parse(schedule.Target.Input) as SelfMessageBody,
    });
  }
  return out;
}

/** Parse `at(YYYY-MM-DDTHH:mm:ss)` (UTC, no trailing Z) into epoch millis. */
export function fireTimeMillis(expression: string): number {
  const match = /^at\((.+)\)$/.exec(expression);
  if (match === null) throw new Error(`not an at() expression: ${expression}`);
  return Date.parse(`${match[1]}Z`);
}

/**
 * Simulate an EventBridge Scheduler fire: deliver the schedule's
 * `Target.Input` to the input queue and read the landed SQS message back
 * (its MessageId is the delivery's idempotency key).
 */
export async function simulateScheduleFire(
  stack: LocalStackHarness,
  queueUrl: string,
  schedule: CapturedSchedule,
): Promise<{ messageId: string; body: string }> {
  await stack
    .sqsClient()
    .send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: schedule.targetInput }));
  const landed = await stack.readMessages(queueUrl, { maxMessages: 1, timeoutMs: 10_000 });
  if (landed.length !== 1 || landed[0] === undefined) {
    throw new Error(`expected exactly one fired message on the queue; got ${landed.length}`);
  }
  return landed[0];
}
