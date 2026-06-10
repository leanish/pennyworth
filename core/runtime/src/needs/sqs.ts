import {
  SQSClient as AwsSQSClient,
  SendMessageCommand,
} from "@aws-sdk/client-sqs";

import { awsClientDefaults } from "../aws-mode/client-config.js";
import type {
  SendMessageRequest,
  SendMessageResult,
  SqsClient,
} from "../types/clients.js";

import type { NeedSpec } from "./spec.js";

/**
 * `sqs` need. Provides `runtime.clients.sqs.sendMessage(...)`. ATC uses
 * this to deliver the terminal reply to the consumer's `envelope.replyTo`
 * queue.
 *
 * No required env vars — callers pass `queueUrl` or `queueArn` per call,
 * since they target consumer-owned queues rather than a single
 * runtime-configured destination.
 */
export const sqsNeed: NeedSpec<SqsClient> = {
  name: "sqs",
  envVars: [],
  iamActions: ["sqs:SendMessage"],
  awsFactory(ctx) {
    const client = new AwsSQSClient({
      ...awsClientDefaults(),
      region: ctx.region,
      // When `AWS_ENDPOINT_URL` is set (LocalStack, dev gateway), respect
      // the configured endpoint instead of overriding it with the
      // QueueUrl's host. SDK v3 default (`true`) breaks LocalStack
      // because `resolveQueueUrl(...)` rebuilds a real-AWS-shaped URL
      // from the consumer-provided ARN; without this flag the SendMessage
      // call would route to real AWS instead of LocalStack. In
      // single-region production this flag is a safe no-op.
      ...(process.env["AWS_ENDPOINT_URL"] !== undefined
        ? { useQueueUrlAsEndpoint: false }
        : {}),
    });
    return {
      async sendMessage(request: SendMessageRequest): Promise<SendMessageResult> {
        const queueUrl = resolveQueueUrl(request, ctx.region);
        // Debug breadcrumb — ConsoleLogger merges the AsyncLocalStorage
        // correlation context automatically, so the AWS call appears in
        // CloudWatch with the originating requestId / sourceTrigger / stage.
        ctx.logger.debug("sqs.sendMessage", { queueUrl, bytes: request.body.length });
        try {
          const result = await client.send(
            new SendMessageCommand({
              QueueUrl: queueUrl,
              MessageBody: request.body,
              ...(request.delaySeconds !== undefined ? { DelaySeconds: request.delaySeconds } : {}),
            }),
          );
          if (result.MessageId === undefined) {
            throw new Error(`SQS SendMessage returned no MessageId`);
          }
          return { messageId: result.MessageId };
        } catch (err) {
          ctx.logger.warn("sqs.sendMessage failed", {
            queueUrl,
            error: err instanceof Error ? err.message : String(err),
          });
          throw err;
        }
      },
    };
  },
  localFactory(ctx) {
    return {
      async sendMessage(request: SendMessageRequest): Promise<SendMessageResult> {
        // Local mode has no SQS substrate; the message is dropped. Warn
        // so the operator notices when an envelope.replyTo (or any other
        // SQS send) silently goes nowhere — matches the spec
        // ("Local mode ignores `replyTo` with a warn-log",
        // `queue-api.md`).
        ctx.logger.warn("local-mode sqs.sendMessage dropped (no SQS substrate)", {
          target: request.queueUrl ?? request.queueArn ?? "<missing>",
          bytes: request.body.length,
        });
        return { messageId: `local-${Date.now()}-${Math.random().toString(36).slice(2, 10)}` };
      },
    };
  },
};

function resolveQueueUrl(request: SendMessageRequest, region: string): string {
  if (request.queueUrl !== undefined) return request.queueUrl;
  if (request.queueArn === undefined) {
    throw new Error("sqs.sendMessage requires queueUrl or queueArn");
  }
  // arn:aws:sqs:<region>:<account>:<name> → https://sqs.<region>.amazonaws.com/<account>/<name>
  const parts = request.queueArn.split(":");
  if (parts.length !== 6 || parts[0] !== "arn" || parts[2] !== "sqs") {
    throw new Error(`malformed SQS ARN: ${request.queueArn}`);
  }
  const arnRegion = parts[3] ?? region;
  const account = parts[4]!;
  const name = parts[5]!;
  return `https://sqs.${arnRegion}.amazonaws.com/${account}/${name}`;
}
