import { randomUUID } from "node:crypto";

import {
  CreateTableCommand,
  DeleteTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
  type DynamoDBClientConfig,
} from "@aws-sdk/client-dynamodb";
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import {
  DeleteParameterCommand,
  PutParameterCommand,
  SSMClient,
  type SSMClientConfig,
} from "@aws-sdk/client-ssm";
import {
  CreateQueueCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SQSClient,
  type SQSClientConfig,
} from "@aws-sdk/client-sqs";
import {
  CreateEventBusCommand,
  DeleteEventBusCommand,
  EventBridgeClient,
  type EventBridgeClientConfig,
} from "@aws-sdk/client-eventbridge";

/**
 * Configuration + lifecycle for a LocalStack-backed integration test.
 *
 * Pattern:
 *
 *   describe("…", () => {
 *     const stack = new LocalStackHarness();
 *     beforeAll(async () => { await stack.start(); });
 *     afterAll(async () => { await stack.stop(); });
 *
 *     it("does the thing", async () => {
 *       const table = await stack.createIdempotencyTable();
 *       const queue = await stack.createQueue();
 *       …
 *     });
 *   });
 *
 * The harness sets `process.env["AWS_ENDPOINT_URL"]` so any AWS SDK v3
 * client constructed by production code (without an explicit `endpoint:`
 * override) routes to LocalStack automatically. Production code therefore
 * does NOT need a LocalStack-aware code path — the AWS SDK reads the
 * env var natively.
 *
 * Per-test isolation is by resource name: every `createX(...)` returns a
 * unique resource keyed on the harness's UUID. Multiple test files
 * running in parallel against the same LocalStack therefore don't
 * collide. `stop()` deletes every resource the harness created.
 *
 * Tests are skipped (the harness `start()` throws a `LocalStackUnavailableError`)
 * when LocalStack isn't reachable. Tests should treat that as a clean
 * skip via Vitest's `it.skipIf(...)` / `beforeAll` failure handling.
 */
export interface LocalStackHarnessOptions {
  /**
   * Override the LocalStack gateway. Defaults to `$LOCALSTACK_HOST` if set,
   * otherwise `http://localhost:4566` (the docker-compose published port).
   */
  readonly endpoint?: string;
  /** Override the AWS region. Defaults to `us-east-1`. */
  readonly region?: string;
}

export class LocalStackUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalStackUnavailableError";
  }
}

export class LocalStackHarness {
  readonly endpoint: string;
  readonly region: string;
  readonly id: string;

  readonly #originalEnv: Record<string, string | undefined> = {};
  readonly #cleanups: Array<() => Promise<void>> = [];
  #started = false;

  constructor(options: LocalStackHarnessOptions = {}) {
    const envHost = process.env["LOCALSTACK_HOST"];
    this.endpoint = options.endpoint ?? (envHost !== undefined ? `http://${envHost}` : "http://localhost:4566");
    this.region = options.region ?? "us-east-1";
    // Short UUID prefix keeps DynamoDB table names (max 255) and SQS queue
    // names (max 80) well under their limits even with descriptive suffixes.
    this.id = randomUUID().slice(0, 8);
  }

  /**
   * Probe LocalStack. Throws `LocalStackUnavailableError` if unreachable,
   * which Vitest tests convert into a clean skip. Sets `AWS_ENDPOINT_URL`
   * + dummy credentials so production code's SDK clients route here.
   *
   * Also defeats the developer's local AWS profile config: `AWS_PROFILE`
   * / `AWS_DEFAULT_PROFILE` are unset, `AWS_SDK_LOAD_CONFIG=0` is set,
   * and EC2 metadata is disabled. Without this, the credential provider
   * chain may try the developer's SSO profile (`~/.aws/config`) and fail
   * with `Token is expired` even though `AWS_ACCESS_KEY_ID` is set.
   */
  async start(): Promise<void> {
    if (this.#started) return;
    await this.#probe();
    this.#captureAndSetEnv("AWS_ENDPOINT_URL", this.endpoint);
    this.#captureAndSetEnv("AWS_ACCESS_KEY_ID", "test");
    this.#captureAndSetEnv("AWS_SECRET_ACCESS_KEY", "test");
    this.#captureAndSetEnv("AWS_REGION", this.region);
    this.#captureAndSetEnv("AWS_DEFAULT_REGION", this.region);
    // Defeat developer-side SSO / shared-credentials picks.
    this.#captureAndDeleteEnv("AWS_PROFILE");
    this.#captureAndDeleteEnv("AWS_DEFAULT_PROFILE");
    this.#captureAndDeleteEnv("AWS_SESSION_TOKEN");
    this.#captureAndSetEnv("AWS_SDK_LOAD_CONFIG", "0");
    this.#captureAndSetEnv("AWS_EC2_METADATA_DISABLED", "true");
    this.#started = true;
  }

  /**
   * Reverse every resource creation in LIFO order, restore the env vars
   * the harness captured at `start()`. Safe to call multiple times.
   */
  async stop(): Promise<void> {
    if (!this.#started) return;
    while (this.#cleanups.length > 0) {
      const cleanup = this.#cleanups.pop();
      if (cleanup === undefined) continue;
      try {
        await cleanup();
      } catch {
        // Best-effort: a stuck DeleteTableCommand shouldn't fail teardown.
      }
    }
    for (const [name, value] of Object.entries(this.#originalEnv)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    this.#started = false;
  }

  // ---------- DynamoDB ----------

  dynamoClient(extra: DynamoDBClientConfig = {}): DynamoDBClient {
    return new DynamoDBClient({ ...this.#commonConfig(), ...extra });
  }

  /**
   * Create a DynamoDB table with the canonical `IdempotencyStore` schema
   * (PK = `pk` String, no GSIs). Returns the unique table name.
   */
  async createIdempotencyTable(suffix = "idem"): Promise<string> {
    const tableName = `${this.id}-${suffix}-${randomUUID().slice(0, 6)}`;
    const client = this.dynamoClient();
    await client.send(
      new CreateTableCommand({
        TableName: tableName,
        AttributeDefinitions: [{ AttributeName: "pk", AttributeType: "S" }],
        KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }],
        BillingMode: "PAY_PER_REQUEST",
      }),
    );
    await waitForTableActive(client, tableName);
    this.#cleanups.push(async () => {
      await client.send(new DeleteTableCommand({ TableName: tableName })).catch(() => undefined);
    });
    return tableName;
  }

  /**
   * Create a DynamoDB table with the `ConsumerRegistry` schema (PK = `pk`
   * String holding the consumerId — both runtime-internal stores share
   * the canonical `pk` attribute name; see `DynamoConsumerRegistry` +
   * `DynamoIdempotencyStore`). Returns the unique table name.
   */
  async createConsumerRegistryTable(suffix = "consumers"): Promise<string> {
    const tableName = `${this.id}-${suffix}-${randomUUID().slice(0, 6)}`;
    const client = this.dynamoClient();
    await client.send(
      new CreateTableCommand({
        TableName: tableName,
        AttributeDefinitions: [{ AttributeName: "pk", AttributeType: "S" }],
        KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }],
        BillingMode: "PAY_PER_REQUEST",
      }),
    );
    await waitForTableActive(client, tableName);
    this.#cleanups.push(async () => {
      await client.send(new DeleteTableCommand({ TableName: tableName })).catch(() => undefined);
    });
    return tableName;
  }

  // ---------- SQS ----------

  sqsClient(extra: SQSClientConfig = {}): SQSClient {
    return new SQSClient({ ...this.#commonConfig(), ...extra });
  }

  /**
   * Create an SQS queue. Returns `{queueUrl, queueArn}`. Visibility
   * timeout defaults to 30s (LocalStack default) — tests that exercise
   * the three-state idempotency path may override.
   */
  async createQueue(suffix = "q"): Promise<{ queueUrl: string; queueArn: string }> {
    const queueName = `${this.id}-${suffix}-${randomUUID().slice(0, 6)}`;
    const client = this.sqsClient();
    const created = await client.send(
      new CreateQueueCommand({
        QueueName: queueName,
      }),
    );
    const queueUrl = created.QueueUrl;
    if (queueUrl === undefined) {
      throw new Error(`LocalStack CreateQueue returned no QueueUrl for '${queueName}'`);
    }
    const attrs = await client.send(
      new GetQueueAttributesCommand({
        QueueUrl: queueUrl,
        AttributeNames: ["QueueArn"],
      }),
    );
    const queueArn = attrs.Attributes?.["QueueArn"];
    if (queueArn === undefined) {
      throw new Error(`LocalStack GetQueueAttributes returned no QueueArn for '${queueName}'`);
    }
    this.#cleanups.push(async () => {
      await client.send(new DeleteQueueCommand({ QueueUrl: queueUrl })).catch(() => undefined);
    });
    return { queueUrl, queueArn };
  }

  /**
   * Drain the queue and return whatever's there. Useful for assertions on
   * terminal-reply delivery. Polls up to `timeoutMs` for any messages.
   */
  async readMessages(
    queueUrl: string,
    options: { maxMessages?: number; timeoutMs?: number } = {},
  ): Promise<Array<{ body: string; messageId: string }>> {
    const client = this.sqsClient();
    const deadline = Date.now() + (options.timeoutMs ?? 5_000);
    const collected: Array<{ body: string; messageId: string }> = [];
    while (collected.length < (options.maxMessages ?? 10) && Date.now() < deadline) {
      const response = await client.send(
        new ReceiveMessageCommand({
          QueueUrl: queueUrl,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: 1,
          // Long visibility so a duplicate poll within the test doesn't
          // re-deliver the same message during inspection.
          VisibilityTimeout: 60,
        }),
      );
      for (const msg of response.Messages ?? []) {
        if (msg.Body !== undefined && msg.MessageId !== undefined) {
          collected.push({ body: msg.Body, messageId: msg.MessageId });
        }
      }
      if ((response.Messages ?? []).length === 0) break;
    }
    return collected;
  }

  // ---------- S3 ----------

  s3Client(extra: S3ClientConfig = {}): S3Client {
    return new S3Client({ ...this.#commonConfig(), forcePathStyle: true, ...extra });
  }

  /** Create an S3 bucket. Returns the unique bucket name. */
  async createBucket(suffix = "bucket"): Promise<string> {
    // S3 bucket names: 3-63 chars, lowercase, no underscore, dot OK but
    // path-style avoids the cert / DNS issues that come with dots.
    const bucketName = `${this.id}-${suffix}-${randomUUID().slice(0, 6)}`;
    const client = this.s3Client();
    await client.send(new CreateBucketCommand({ Bucket: bucketName }));
    this.#cleanups.push(async () => {
      // Empty the bucket first; LocalStack S3 won't delete non-empty buckets.
      let isTruncated = true;
      while (isTruncated) {
        const list = await client
          .send(new ListObjectsV2Command({ Bucket: bucketName }))
          .catch(() => undefined);
        if (list === undefined) break;
        for (const obj of list.Contents ?? []) {
          if (obj.Key !== undefined) {
            await client
              .send(new DeleteObjectCommand({ Bucket: bucketName, Key: obj.Key }))
              .catch(() => undefined);
          }
        }
        isTruncated = list.IsTruncated === true;
      }
      await client.send(new DeleteBucketCommand({ Bucket: bucketName })).catch(() => undefined);
    });
    return bucketName;
  }

  /** Upload a string body to a bucket key. */
  async putObject(bucket: string, key: string, body: string | Uint8Array, contentType?: string): Promise<void> {
    const client = this.s3Client();
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ...(contentType !== undefined ? { ContentType: contentType } : {}),
      }),
    );
  }

  // ---------- SSM Parameter Store ----------

  ssmClient(extra: SSMClientConfig = {}): SSMClient {
    return new SSMClient({ ...this.#commonConfig(), ...extra });
  }

  /**
   * Create an SSM Parameter Store `SecureString` parameter with the given
   * string value. Returns the parameter name (the canonical identifier
   * other AWS callers reference).
   *
   * `Overwrite: true` keeps the helper idempotent across reruns that reuse
   * the same name; `Type: "SecureString"` exercises the KMS-decrypt path
   * that production reads via `GetParameter({ WithDecryption: true })`.
   */
  async createSecureStringParameter(name: string, value: string): Promise<string> {
    const client = this.ssmClient();
    await client.send(
      new PutParameterCommand({
        Name: name,
        Value: value,
        Type: "SecureString",
        Overwrite: true,
      }),
    );
    this.#cleanups.push(async () => {
      await client.send(new DeleteParameterCommand({ Name: name })).catch(() => undefined);
    });
    return name;
  }

  // ---------- EventBridge ----------

  eventBridgeClient(extra: EventBridgeClientConfig = {}): EventBridgeClient {
    return new EventBridgeClient({ ...this.#commonConfig(), ...extra });
  }

  /** Create an EventBridge custom event bus. Returns the bus name. */
  async createEventBus(suffix = "bus"): Promise<string> {
    const busName = `${this.id}-${suffix}-${randomUUID().slice(0, 6)}`;
    const client = this.eventBridgeClient();
    await client.send(new CreateEventBusCommand({ Name: busName }));
    this.#cleanups.push(async () => {
      await client.send(new DeleteEventBusCommand({ Name: busName })).catch(() => undefined);
    });
    return busName;
  }

  // ---------- internals ----------

  #commonConfig(): { region: string; endpoint: string; credentials: { accessKeyId: string; secretAccessKey: string } } {
    return {
      region: this.region,
      endpoint: this.endpoint,
      credentials: { accessKeyId: "test", secretAccessKey: "test" },
    };
  }

  #captureAndSetEnv(name: string, value: string): void {
    this.#originalEnv[name] = process.env[name];
    process.env[name] = value;
  }

  #captureAndDeleteEnv(name: string): void {
    this.#originalEnv[name] = process.env[name];
    delete process.env[name];
  }

  async #probe(): Promise<void> {
    const url = `${this.endpoint}/_localstack/health`;
    let response: Response;
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(3_000) });
    } catch (err) {
      throw new LocalStackUnavailableError(
        `LocalStack not reachable at ${this.endpoint} (${err instanceof Error ? err.message : String(err)}). ` +
          `Start it with: docker compose up -d localstack`,
      );
    }
    if (!response.ok) {
      throw new LocalStackUnavailableError(
        `LocalStack health check failed (${response.status} ${response.statusText}) at ${url}`,
      );
    }
  }
}

async function waitForTableActive(client: DynamoDBClient, tableName: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const response = await client.send(new DescribeTableCommand({ TableName: tableName })).catch(() => undefined);
    if (response?.Table?.TableStatus === "ACTIVE") return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`DynamoDB table '${tableName}' did not become ACTIVE within 10s`);
}

/**
 * Probe LocalStack's health endpoint. Returns `true` when it responds
 * within 1.5s. Test code shouldn't need this — `LocalStackHarness.start()`
 * already fails loudly with `LocalStackUnavailableError` when the
 * substrate is missing, and the integration suite expects that. The
 * helper stays exported for non-test callers that want to branch on
 * reachability (the `lambda-rehearsal` script's precheck).
 */
export async function isLocalStackReachable(endpoint?: string): Promise<boolean> {
  const envHost = process.env["LOCALSTACK_HOST"];
  const url = `${endpoint ?? (envHost !== undefined ? `http://${envHost}` : "http://localhost:4566")}/_localstack/health`;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1_500) });
    return response.ok;
  } catch {
    return false;
  }
}
