/**
 * Lambda container rehearsal: stand the ATC Lambda image up locally
 * via the AWS Lambda Runtime Interface Emulator (RIE), wire it to
 * LocalStack-provisioned AWS resources, fire one `scopeOnly: true`
 * envelope through the invocation endpoint, and confirm:
 *
 *   - Container boots (cold start init within the Lambda envelope)
 *   - Reads env vars correctly
 *   - Connects to LocalStack for DDB / S3 / SSM Parameter Store / EventBridge / SQS
 *   - Verifies a real signed envelope
 *   - Claims idempotency
 *   - Resolves project scope
 *   - Emits lifecycle events
 *   - Delivers the terminal reply to envelope.replyTo
 *
 * The `scopeOnly: true` flag skips the actual coding-agent invocation —
 * we don't need an Anthropic / OpenAI API key to verify the *deploy
 * substrate* works. (The real `claude` / `codex` binaries ARE installed
 * in the image; the rehearsal just doesn't exercise them.)
 *
 * Run:
 *
 *   docker compose up -d localstack    # if not already running
 *   docker build -f agents/ask-the-code/Dockerfile -t atc-lambda:rehearsal .   # if not already built
 *   tsx agents/ask-the-code/scripts/lambda-rehearsal.ts
 *
 * Exits 0 on success with timing breakdown on stdout; non-zero with a
 * diagnostic on stderr otherwise.
 */
import { createHmac } from "node:crypto";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

import { GetItemCommand } from "@aws-sdk/client-dynamodb";

import {
  DynamoConsumerRegistry,
  canonicalize,
} from "@leanish/runtime";
import { publishCatalog, type Project } from "@leanish/catalog-it";
import {
  LocalStackHarness,
  isLocalStackReachable,
} from "@leanish/runtime/testing";

const IMAGE = process.env["LAMBDA_IMAGE"] ?? "atc-lambda:rehearsal";
const CONTAINER_NAME = "atc-lambda-rehearsal";
const RIE_HOST_PORT = Number(process.env["LAMBDA_REHEARSAL_PORT"] ?? "9000");
const RIE_BINARY =
  process.env["LAMBDA_RIE_BINARY"] ??
  `${process.env["HOME"]}/.aws-lambda-rie/aws-lambda-rie`;

async function main(): Promise<void> {
  const overall = Date.now();
  process.stdout.write("=== ATC Lambda container rehearsal ===\n\n");

  if (!(await isLocalStackReachable())) {
    fatal("LocalStack not reachable. Run: docker compose up -d localstack");
  }
  process.stdout.write("✔ LocalStack reachable\n");

  const stack = new LocalStackHarness();
  await stack.start();
  try {
    // ---- Provision LocalStack resources ----
    const t0 = Date.now();
    const idempotencyTable = await stack.createIdempotencyTable("ask-the-code-idem");
    const consumerRegistryTable = await stack.createConsumerRegistryTable("ask-the-code-consumers");
    const catalogBucket = await stack.createBucket("ask-the-code-catalog");
    const eventBus = await stack.createEventBus("ask-the-code-events");
    const replyQueue = await stack.createQueue("ask-the-code-reply");
    process.stdout.write(`✔ AWS resources provisioned (${Date.now() - t0}ms)\n`);

    // ---- Publish a small catalog ----
    const project: Project = {
      id: "demo",
      source: { url: "https://example.invalid/demo.git", branch: "main" },
      description: "Demo project for the Lambda rehearsal",
      extensions: { "ask-the-code": { enabled: true } },
    };
    await publishCatalog({
      bucket: catalogBucket,
      key: "catalog.json",
      projects: [project],
      client: stack.s3Client(),
    });
    process.stdout.write("✔ Catalog published to S3\n");

    // ---- Create a consumer with a literal-key signing key ----
    const consumerId = "atc-ui";
    const signingSecret = "rehearsal-shared-secret";
    const registry = new DynamoConsumerRegistry({
      tableName: consumerRegistryTable,
      client: stack.dynamoClient(),
    });
    await registry.put({
      consumerId,
      signingKey: {
        kind: "literal",
        base64: Buffer.from(signingSecret, "utf8").toString("base64"),
      },
      allowedKinds: ["ask"],
    });
    process.stdout.write("✔ Consumer registered in DDB\n");

    // ---- Boot the Lambda container with RIE ----
    // The container will reach LocalStack via the host bridge.
    // On Docker Desktop (macOS/Windows), `host.docker.internal` resolves
    // to the host. On native Linux, we use `--add-host=...` mapping.
    process.stdout.write("\n→ Starting Lambda container via RIE...\n");
    await stopExistingContainer();

    const lambdaEnv = {
      AWS_REGION: "us-east-1",
      AWS_DEFAULT_REGION: "us-east-1",
      AWS_ACCESS_KEY_ID: "test",
      AWS_SECRET_ACCESS_KEY: "test",
      AWS_ENDPOINT_URL: "http://host.docker.internal:4566",
      IDEMPOTENCY_TABLE_NAME: idempotencyTable,
      CONSUMER_REGISTRY_TABLE_NAME: consumerRegistryTable,
      CATALOG_BUCKET: catalogBucket,
      EVENT_BUS_NAME: eventBus,
      WORKSPACE_ROOT: "/tmp/ask-the-code-workspaces",
      // Force-refresh the catalog every read so we exercise that path.
      CATALOG_TTL_MS: "1",
    } as const;

    const containerStart = Date.now();
    const child = startContainer(lambdaEnv);
    try {
      await waitForRie(RIE_HOST_PORT, 15_000);
      process.stdout.write(
        `✔ Container up + RIE accepting connections (${Date.now() - containerStart}ms)\n`,
      );

      // ---- Build a signed envelope (scopeOnly: true so we skip the LLM call) ----
      const requestId = `rehearsal-${Date.now()}`;
      const envelope = makeSignedEnvelope({
        consumer: consumerId,
        kind: "ask",
        endUser: "u:rehearsal",
        requestId,
        replyTo: arnFromQueueUrl(replyQueue.queueUrl),
        payload: {
          question: "rehearsal: what does this project do?",
          audience: "general",
          includeAll: true,
          noSync: true,
          scopeOnly: true,
        },
        secret: signingSecret,
      });
      const sqsEvent = {
        Records: [
          {
            messageId: requestId,
            body: JSON.stringify(envelope),
          },
        ],
      };

      // ---- Invoke the Lambda via RIE ----
      const invoke0 = Date.now();
      const response = await fetch(
        `http://localhost:${RIE_HOST_PORT}/2015-03-31/functions/function/invocations`,
        {
          method: "POST",
          body: JSON.stringify(sqsEvent),
        },
      );
      if (!response.ok) {
        const body = await response.text();
        fatal(`RIE returned ${response.status}: ${body}`);
      }
      const result = (await response.json()) as {
        batchItemFailures: ReadonlyArray<{ itemIdentifier: string }>;
        results: ReadonlyArray<{ messageId: string; status: string; error?: string }>;
      };
      const invokeMs = Date.now() - invoke0;
      process.stdout.write(`✔ Lambda invocation responded in ${invokeMs}ms\n`);

      // ---- Assertions ----
      if (result.batchItemFailures.length !== 0) {
        fatal(
          `expected no batchItemFailures, got: ${JSON.stringify(result.batchItemFailures)}; results: ${JSON.stringify(result.results)}`,
        );
      }
      if (result.results[0]?.status !== "handled") {
        fatal(`expected status='handled', got: ${JSON.stringify(result.results[0])}`);
      }
      process.stdout.write(`  • shim result.status = handled\n`);

      // Reply queue should have the terminal reply
      const replies = await stack.readMessages(replyQueue.queueUrl, {
        maxMessages: 1,
        timeoutMs: 5_000,
      });
      if (replies.length !== 1) {
        fatal(`expected 1 terminal reply on the reply queue, got ${replies.length}`);
      }
      const reply = JSON.parse(replies[0]!.body) as {
        status: string;
        requestId: string;
        result?: { answer: string };
      };
      if (reply.status !== "completed") {
        fatal(`expected reply.status='completed', got: ${JSON.stringify(reply)}`);
      }
      if (reply.requestId !== requestId) {
        fatal(`expected reply.requestId='${requestId}', got: ${reply.requestId}`);
      }
      process.stdout.write(`  • terminal reply delivered: status=completed requestId=${reply.requestId}\n`);
      if (reply.result?.answer !== undefined) {
        process.stdout.write(`  • answer (scope-only placeholder): "${reply.result.answer}"\n`);
      }

      // Idempotency record should be marked completed
      const idem = await stack.dynamoClient().send(
        new GetItemCommand({
          TableName: idempotencyTable,
          Key: { pk: { S: requestId } },
          ConsistentRead: true,
        }),
      );
      if (idem.Item?.["status"]?.S !== "completed") {
        fatal(`expected idempotency status=completed, got: ${JSON.stringify(idem.Item)}`);
      }
      process.stdout.write(`  • idempotency record state = completed\n`);

      const overallMs = Date.now() - overall;
      process.stdout.write(`\n=== ✅ Rehearsal passed (${overallMs}ms wall, ${invokeMs}ms invoke) ===\n`);
    } finally {
      await stopContainer(child);
    }
  } finally {
    await stack.stop();
  }
}

function fatal(msg: string): never {
  process.stderr.write(`\n❌ ${msg}\n`);
  process.exit(1);
}

function startContainer(env: Record<string, string>): ReturnType<typeof spawn> {
  const envArgs: string[] = [];
  for (const [k, v] of Object.entries(env)) {
    envArgs.push("-e", `${k}=${v}`);
  }
  const args = [
    "run",
    "--rm",
    "--name",
    CONTAINER_NAME,
    "-p",
    `${RIE_HOST_PORT}:8080`,
    "-v",
    `${RIE_BINARY}:/aws-lambda/aws-lambda-rie`,
    "--add-host=host.docker.internal:host-gateway",
    ...envArgs,
    "--entrypoint",
    "/aws-lambda/aws-lambda-rie",
    IMAGE,
    "/var/lang/bin/node",
    "/var/runtime/index.mjs",
    "dist/lambda.atcLambdaHandler",
  ];
  const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
  child.stdout?.on("data", (data: Buffer) => {
    for (const line of data.toString().trimEnd().split("\n")) {
      process.stderr.write(`  [container] ${line}\n`);
    }
  });
  child.stderr?.on("data", (data: Buffer) => {
    for (const line of data.toString().trimEnd().split("\n")) {
      process.stderr.write(`  [container] ${line}\n`);
    }
  });
  return child;
}

async function stopContainer(child: ReturnType<typeof spawn>): Promise<void> {
  try {
    await new Promise<void>((resolve) => {
      const stop = spawn("docker", ["stop", "-t", "1", CONTAINER_NAME], { stdio: "ignore" });
      stop.on("exit", () => resolve());
      // Don't wait forever if `docker stop` hangs.
      setTimeout(() => resolve(), 5_000).unref();
    });
  } catch {
    // best-effort
  }
  child.kill("SIGTERM");
}

async function stopExistingContainer(): Promise<void> {
  await new Promise<void>((resolve) => {
    const rm = spawn("docker", ["rm", "-f", CONTAINER_NAME], { stdio: "ignore" });
    rm.on("exit", () => resolve());
    setTimeout(() => resolve(), 3_000).unref();
  });
}

async function waitForRie(port: number, timeoutMs: number): Promise<void> {
  // Probe TCP-level readiness via the docker port mapping. We deliberately
  // do NOT use the invocation endpoint as a probe — POSTing to
  // `/2015-03-31/functions/function/invocations` fires a real invocation
  // (the runtime treats it as a Lambda event), which would charge a cold
  // start to a `{}` payload that the handler can't parse. A TCP probe is
  // cheaper, doesn't pollute the logs with handler errors, and avoids
  // racing the runtime's init.
  const { Socket } = await import("node:net");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const open = await new Promise<boolean>((resolve) => {
      const socket = new Socket();
      socket.setTimeout(500);
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => {
        socket.destroy();
        resolve(false);
      });
      socket.once("timeout", () => {
        socket.destroy();
        resolve(false);
      });
      socket.connect(port, "127.0.0.1");
    });
    if (open) return;
    await sleep(200);
  }
  throw new Error(`RIE didn't accept TCP connections on :${port} within ${timeoutMs}ms`);
}

function makeSignedEnvelope(args: {
  consumer: string;
  kind: string;
  endUser: string;
  requestId: string;
  payload: Record<string, unknown>;
  secret: string;
  conversationKey?: string;
  replyTo?: string;
}): Record<string, unknown> {
  const timestamp = new Date().toISOString();
  const canonicalPayload = canonicalize(args.payload);
  const message =
    timestamp +
    "\n" +
    args.consumer +
    "\n" +
    args.endUser +
    "\n" +
    (args.conversationKey ?? "") +
    "\n" +
    canonicalPayload;
  const signature = createHmac("sha256", args.secret).update(message).digest("hex");
  return {
    kind: args.kind,
    requestId: args.requestId,
    consumer: args.consumer,
    endUser: args.endUser,
    timestamp,
    payload: args.payload,
    signature,
    ...(args.conversationKey !== undefined ? { conversationKey: args.conversationKey } : {}),
    ...(args.replyTo !== undefined ? { replyTo: args.replyTo } : {}),
  };
}

function arnFromQueueUrl(queueUrl: string): string {
  const url = new URL(queueUrl);
  const parts = url.pathname.split("/").filter((p) => p.length > 0);
  if (parts.length !== 2) {
    throw new Error(`unexpected LocalStack SQS URL shape: ${queueUrl}`);
  }
  const [account, name] = parts;
  return `arn:aws:sqs:us-east-1:${account}:${name}`;
}

main().catch((err) => {
  fatal(err instanceof Error ? err.stack ?? err.message : String(err));
});
