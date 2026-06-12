import {
  ConflictException,
  CreateScheduleCommand,
  SchedulerClient,
} from "@aws-sdk/client-scheduler";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";

import { awsClientDefaults } from "../aws-mode/client-config.js";
import type { Logger } from "../types/logger.js";
import type { PublishArgs, PublishDelayedArgs } from "../types/runtime.js";

import { buildSelfMessageBody, deriveScheduleName } from "./serialize.js";
import type { SelfPublisher } from "./self-publisher.js";

/**
 * AWS-mode self-publisher (ADR-0011).
 *
 *   - `publish` → SQS `SendMessage` to the agent's own input queue.
 *   - `publishDelayed` → EventBridge Scheduler `CreateSchedule`:
 *       Name                  = `<agentId>-<sha256-canonical-32hex>` (dedupe key)
 *       GroupName             = per-agent schedule group
 *       ScheduleExpression    = `at(now + afterSeconds)` (UTC, second precision)
 *       Target                = SQS SendMessage with the serialised body
 *       ActionAfterCompletion = DELETE (one-shot; no schedule accumulation)
 *       FlexibleTimeWindow    = OFF (fires exactly at the scheduled time)
 *     A `ConflictException` means an identical logical schedule already
 *     exists — treated as success (idempotent re-publish), per the ADR.
 *
 * No cancellation API in v1: if the work completes before the schedule
 * fires, the receiving handler detects "already done" and exits (handlers
 * are idempotent by contract).
 */
export interface AwsSelfPublisherOptions {
  readonly agentId: string;
  /** The agent's own input queue (publish target). */
  readonly queueUrl: string;
  /** Same queue as ARN (Scheduler targets take ARNs). */
  readonly queueArn: string;
  /** Per-agent EventBridge Scheduler group, e.g. `leanish-agent-secure-it`. */
  readonly scheduleGroupName: string;
  /** Role Scheduler assumes to SendMessage to the queue (provisioned by infra). */
  readonly schedulerRoleArn: string;
  readonly region: string;
  readonly logger: Logger;
  /** Injectable for tests. */
  readonly sqsClient?: Pick<SQSClient, "send">;
  readonly schedulerClient?: Pick<SchedulerClient, "send">;
  readonly clock?: () => Date;
}

export function createAwsSelfPublisher(options: AwsSelfPublisherOptions): SelfPublisher {
  const sqs =
    options.sqsClient ??
    new SQSClient({
      ...awsClientDefaults(),
      region: options.region,
      // When `AWS_ENDPOINT_URL` is set (LocalStack, dev gateway), respect
      // the configured endpoint instead of letting the SDK override it
      // with the QueueUrl's host (same rationale as the `sqs` need's
      // client in needs/sqs.ts). In production this flag is a no-op.
      ...(process.env["AWS_ENDPOINT_URL"] !== undefined
        ? { useQueueUrlAsEndpoint: false }
        : {}),
    });
  const scheduler =
    options.schedulerClient ??
    new SchedulerClient({ ...awsClientDefaults(), region: options.region });
  const clock = options.clock ?? (() => new Date());

  return {
    async publish(args: PublishArgs): Promise<void> {
      const body = buildSelfMessageBody({
        stage: args.stage,
        payload: args.payload,
        clock: () => clock().toISOString(),
      });
      options.logger.debug("selfPublish.publish", {
        stage: args.stage,
        queueUrl: options.queueUrl,
      });
      await sqs.send(
        new SendMessageCommand({
          QueueUrl: options.queueUrl,
          MessageBody: JSON.stringify(body),
        }),
      );
    },

    async publishDelayed(args: PublishDelayedArgs): Promise<void> {
      const body = buildSelfMessageBody({
        stage: args.stage,
        payload: args.payload,
        clock: () => clock().toISOString(),
      });
      const name = deriveScheduleName({
        agentId: options.agentId,
        stage: args.stage,
        payload: args.payload,
      });
      const fireAt = new Date(clock().getTime() + args.afterSeconds * 1000);
      // Scheduler `at()` takes second-precision UTC without the trailing Z.
      const expression = `at(${fireAt.toISOString().slice(0, 19)})`;
      options.logger.debug("selfPublish.publishDelayed", {
        stage: args.stage,
        name,
        expression,
      });
      try {
        await scheduler.send(
          new CreateScheduleCommand({
            Name: name,
            GroupName: options.scheduleGroupName,
            ScheduleExpression: expression,
            ScheduleExpressionTimezone: "UTC",
            FlexibleTimeWindow: { Mode: "OFF" },
            ActionAfterCompletion: "DELETE",
            Target: {
              Arn: options.queueArn,
              RoleArn: options.schedulerRoleArn,
              Input: JSON.stringify(body),
            },
          }),
        );
      } catch (err) {
        if (err instanceof ConflictException) {
          // Same derived name ⇒ structurally the same logical schedule
          // (the name hashes {agentId, stage, payload}; `afterSeconds` is
          // deliberately NOT part of the identity — a re-publish with a
          // different delay still dedupes onto the first schedule, and a
          // caller that genuinely needs a distinct pending schedule must
          // change the payload identity). Dedupe is the designed
          // behaviour, not an error (ADR-0011 §Idempotency).
          options.logger.debug("selfPublish.publishDelayed deduped (schedule exists)", {
            name,
          });
          return;
        }
        throw err;
      }
    },
  };
}
