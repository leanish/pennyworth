import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GetItemCommand, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { GetParameterCommand } from "@aws-sdk/client-ssm";
import { GetObjectCommand } from "@aws-sdk/client-s3";

import { LocalStackHarness, isLocalStackReachable } from "../src/testing/localstack-harness.js";

/**
 * Sanity-check the LocalStack harness without touching any production
 * code. If this passes, the harness itself works; failures in actual
 * integration tests can be investigated against the wiring rather than
 * the harness scaffolding.
 *
 *   docker compose up -d localstack
 *   cd agent-runtime && npm run test:integration
 *
 * `stack.start()` below throws `LocalStackUnavailableError` if LocalStack
 * isn't reachable — the integration gate fails loudly rather than
 * silently skipping.
 */
describe("LocalStackHarness smoke", () => {
  const stack = new LocalStackHarness();

  beforeAll(async () => {
    await stack.start();
  });

  afterAll(async () => {
    await stack.stop();
  });

  it("creates a DynamoDB table you can put/get items in", async () => {
    const tableName = await stack.createIdempotencyTable();
    const client = stack.dynamoClient();
    await client.send(
      new PutItemCommand({
        TableName: tableName,
        Item: {
          pk: { S: "test-key" },
          status: { S: "in-flight" },
        },
      }),
    );
    const got = await client.send(
      new GetItemCommand({
        TableName: tableName,
        Key: { pk: { S: "test-key" } },
        ConsistentRead: true,
      }),
    );
    expect(got.Item).toBeDefined();
    expect(got.Item?.["status"]?.S).toBe("in-flight");
  });

  it("creates an SQS queue with a usable QueueUrl + QueueArn", async () => {
    const { queueUrl, queueArn } = await stack.createQueue();
    expect(queueUrl).toMatch(/^http:\/\/.+\//);
    expect(queueArn).toMatch(/^arn:aws:sqs:/);
  });

  it("creates an S3 bucket you can put/get objects in", async () => {
    const bucket = await stack.createBucket();
    await stack.putObject(bucket, "hello.txt", "world", "text/plain");
    const client = stack.s3Client();
    const got = await client.send(new GetObjectCommand({ Bucket: bucket, Key: "hello.txt" }));
    const body = await got.Body?.transformToString();
    expect(body).toBe("world");
  });

  it("creates an SSM SecureString parameter you can fetch back", async () => {
    const name = `/leanish/test/${stack.id}/hmac-key`;
    const returned = await stack.createSecureStringParameter(name, "hmac-bytes-here");
    expect(returned).toBe(name);
    const client = stack.ssmClient();
    const got = await client.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
    expect(got.Parameter?.Value).toBe("hmac-bytes-here");
  });

  it("creates an EventBridge bus", async () => {
    const busName = await stack.createEventBus();
    expect(busName).toContain("-bus-");
  });

  it("sets AWS_ENDPOINT_URL so SDK clients route to LocalStack by default", () => {
    // Production code that constructs SDK clients without explicit endpoint
    // overrides will pick up this env var and route to LocalStack.
    expect(process.env["AWS_ENDPOINT_URL"]).toBe(stack.endpoint);
    expect(process.env["AWS_REGION"]).toBe(stack.region);
  });
});

describe("LocalStackHarness offline behaviour", () => {
  it("isLocalStackReachable returns false when pointed at a dead endpoint", async () => {
    const reachable = await isLocalStackReachable("http://127.0.0.1:1");
    expect(reachable).toBe(false);
  });

  it("start() throws LocalStackUnavailableError when LocalStack isn't there", async () => {
    const stack = new LocalStackHarness({ endpoint: "http://127.0.0.1:1" });
    await expect(stack.start()).rejects.toThrow(/LocalStack not reachable/);
  });
});
