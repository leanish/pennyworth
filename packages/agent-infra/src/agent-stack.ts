import { CfnOutput, Duration, RemovalPolicy, Size, Stack, type StackProps } from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { SqsEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import * as logs from "aws-cdk-lib/aws-logs";
import * as sqs from "aws-cdk-lib/aws-sqs";
import type { AgentDescriptor, ConsumerTrigger } from "@leanish/agent-runtime";
import type { Construct } from "constructs";

import { needPolicyStatements } from "./needs-policy.js";
import type { AgentRegistration } from "./registry.js";
import type { SharedStack } from "./shared-stack.js";

export interface AgentStackProps extends StackProps {
  readonly registration: AgentRegistration;
  readonly descriptor: AgentDescriptor;
  readonly shared: SharedStack;
  /** Phase-1 reserved-concurrency default (D5); raise per agent as needed. */
  readonly reservedConcurrency?: number;
}

// The ADR-0006 timeout interlock — these three are load-bearing and MUST hold.
const LAMBDA_TIMEOUT = Duration.minutes(15); // platform ceiling
const QUEUE_VISIBILITY = Duration.minutes(17); // 2 min above Lambda
const DLQ_MAX_RECEIVE = 5;

/**
 * Per-agent stack: the idempotency + consumer-registry tables, the input
 * queue + DLQ, the container Lambda, its least-privilege IAM role (runtime-
 * internal grants + needs-derived grants), and the SQS event-source mapping.
 * Provisioned from the agent's descriptor + the runtime needs registry
 * (contract §2–§3).
 */
export class AgentStack extends Stack {
  constructor(scope: Construct, id: string, props: AgentStackProps) {
    super(scope, id, props);
    const { registration, descriptor, shared } = props;

    // --- Idempotency table (ADR-0006/0007): PK=requestId, 30-day TTL on `ttl`.
    const idempotency = new dynamodb.Table(this, "Idempotency", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: "ttl",
      pointInTimeRecovery: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // --- Consumer registry (only for signed-envelope agents): PK=consumerId.
    const usesSignedEnvelope = descriptor.triggers.some(
      (t): t is ConsumerTrigger => t.type === "consumer" && t.signedEnvelope === true,
    );
    const consumerRegistry = usesSignedEnvelope
      ? new dynamodb.Table(this, "ConsumerRegistry", {
          partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
          billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
          pointInTimeRecovery: true,
          removalPolicy: RemovalPolicy.RETAIN,
        })
      : undefined;

    // --- Input queue + DLQ. Visibility (17m) > Lambda timeout (15m) per §5.
    const dlq = new sqs.Queue(this, "Dlq", { retentionPeriod: Duration.days(14) });
    const inputQueue = new sqs.Queue(this, "Input", {
      visibilityTimeout: QUEUE_VISIBILITY,
      deadLetterQueue: { queue: dlq, maxReceiveCount: DLQ_MAX_RECEIVE },
    });

    // --- Lambda (container image from ECR; the handler is the image CMD).
    const repo = ecr.Repository.fromRepositoryName(this, "Repo", registration.ecrRepositoryName);
    const fn = new lambda.DockerImageFunction(this, "Fn", {
      functionName: `leanish-${descriptor.identifier}`,
      code: lambda.DockerImageCode.fromEcr(repo, { tagOrDigest: registration.imageTag }),
      timeout: LAMBDA_TIMEOUT,
      memorySize: 2048,
      // Working copies clone into /tmp (git, D6) — give it room beyond the 512 MB default.
      ephemeralStorageSize: Size.gibibytes(2),
      logRetention: logs.RetentionDays.ONE_MONTH,
      ...(props.reservedConcurrency !== undefined
        ? { reservedConcurrentExecutions: props.reservedConcurrency }
        : {}),
      environment: {
        IDEMPOTENCY_TABLE_NAME: idempotency.tableName,
        ...(consumerRegistry !== undefined
          ? { CONSUMER_REGISTRY_TABLE_NAME: consumerRegistry.tableName }
          : {}),
        CATALOG_BUCKET: shared.catalogBucket.bucketName,
        EVENT_BUS_NAME: shared.eventBus.eventBusName,
        WORKSPACE_ROOT: "/tmp/atc-workspaces",
      },
    });

    // --- Runtime-internal grants (contract §3.1).
    // Idempotency: single conditional PutItem claim + UpdateItem finalize, no read (ADR-0006).
    idempotency.grant(fn, "dynamodb:PutItem", "dynamodb:UpdateItem");
    consumerRegistry?.grantReadData(fn); // GetItem only (read-only at request time)
    shared.catalogBucket.grantRead(fn); // S3Catalog read of catalog.json
    if (consumerRegistry !== undefined) {
      // Signing-key resolve: SSM SecureString + KMS decrypt (§3.1, D8 path).
      fn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ["ssm:GetParameter"],
          resources: [
            `arn:aws:ssm:${this.region}:${this.account}:parameter/leanish/agents/${descriptor.identifier}/signing-keys/*`,
          ],
        }),
      );
      shared.secretsKey.grantDecrypt(fn);
    }

    // --- Needs-derived grants (registry-driven; contract §3.2).
    for (const need of descriptor.needs) {
      for (const statement of needPolicyStatements({
        need,
        region: this.region,
        account: this.account,
        eventBusArn: shared.eventBus.eventBusArn,
      })) {
        fn.addToRolePolicy(statement);
      }
    }

    // --- Trigger: consumer → SQS event-source mapping (partial-batch reporting).
    fn.addEventSource(new SqsEventSource(inputQueue, { reportBatchItemFailures: true, batchSize: 10 }));

    new CfnOutput(this, "InputQueueArn", { value: inputQueue.queueArn });
    new CfnOutput(this, "DlqArn", { value: dlq.queueArn });
    new CfnOutput(this, "FunctionName", { value: fn.functionName });
  }
}
