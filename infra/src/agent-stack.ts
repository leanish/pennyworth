import { CfnOutput, Duration, RemovalPolicy, Size, Stack, type StackProps } from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { SqsEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import * as logs from "aws-cdk-lib/aws-logs";
import * as scheduler from "aws-cdk-lib/aws-scheduler";
import * as schedulerTargets from "aws-cdk-lib/aws-scheduler-targets";
import * as sqs from "aws-cdk-lib/aws-sqs";
import type { AgentDescriptor, ConsumerTrigger } from "@leanish/runtime";
import type { Construct } from "constructs";

import { needPolicyStatements } from "./needs-policy.js";
import type { AgentRegistration } from "./registry.js";
import type { SharedStack } from "./shared-stack.js";
import type { TargetCredentialsInfraConfig } from "./target-credentials-config.js";

export interface AgentStackProps extends StackProps {
  readonly registration: AgentRegistration;
  readonly descriptor: AgentDescriptor;
  readonly shared: SharedStack;
  /** Phase-1 reserved-concurrency default (D5); raise per agent as needed. */
  readonly reservedConcurrency?: number;
  /**
   * CodeArtifact grant scope for the `target-credentials` need (from the
   * `targetCredentials` CDK context). Empty/absent = SSM-only grants.
   */
  readonly targetCredentials?: TargetCredentialsInfraConfig;
}

// The ADR-0006 timeout interlock — these three are load-bearing and MUST hold.
const LAMBDA_TIMEOUT = Duration.minutes(15); // platform ceiling
const QUEUE_VISIBILITY = Duration.minutes(17); // 2 min above Lambda
const DLQ_MAX_RECEIVE = 5;

/**
 * Per-agent stack: the idempotency + consumer-registry tables, the input
 * queue + DLQ, the container Lambda, its least-privilege IAM role (runtime-
 * internal grants + needs-derived grants), the SQS event-source mapping,
 * and — for multi-stage / scheduler-trigger agents — the EventBridge
 * Scheduler wiring (schedule group, delivery role, recurring tick).
 * Provisioned from the agent's descriptor + the runtime needs registry
 * (contract §2–§3, §8).
 */
export class AgentStack extends Stack {
  /** The agent's input queue — exposed for sibling stacks (e.g. the ship-it webhook normalizer). */
  readonly inputQueue: sqs.Queue;

  constructor(scope: Construct, id: string, props: AgentStackProps) {
    super(scope, id, props);
    const { registration, descriptor, shared } = props;

    const schedulerTrigger = descriptor.triggers.find((t) => t.type === "scheduler");
    if (schedulerTrigger !== undefined && registration.tickSchedule === undefined) {
      throw new Error(
        `agent-infra: agent '${registration.id}' declares a scheduler trigger but its registration has no tickSchedule`,
      );
    }
    if (schedulerTrigger === undefined && registration.tickSchedule !== undefined) {
      throw new Error(
        `agent-infra: agent '${registration.id}' has a tickSchedule but its descriptor declares no scheduler trigger`,
      );
    }
    if (schedulerTrigger !== undefined && !descriptor.stages.includes("init")) {
      throw new Error(
        `agent-infra: agent '${registration.id}' declares a scheduler trigger but no 'init' stage for the tick to fire`,
      );
    }

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
    this.inputQueue = inputQueue;

    // --- EventBridge Scheduler wiring (contract §8). Stages beyond the
    // externally-delivered first one arrive via runtime.publish /
    // publishDelayed (ADR-0011/0012), so multi-stage agents need the
    // schedule group + delivery role; scheduler-trigger agents need them
    // for the recurring tick as well.
    const selfPublishes = descriptor.stages.length > 1;
    const schedulerWiring =
      selfPublishes || schedulerTrigger !== undefined
        ? this.provisionSchedulerWiring(descriptor.identifier, inputQueue)
        : undefined;

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
        WORKSPACE_ROOT: `/tmp/${descriptor.identifier}-workspaces`,
        ...(schedulerWiring !== undefined
          ? selfPublishEnv(inputQueue, schedulerWiring)
          : {}),
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
        agentId: descriptor.identifier,
        region: this.region,
        account: this.account,
        eventBusArn: shared.eventBus.eventBusArn,
        ...(props.targetCredentials !== undefined
          ? { targetCredentials: props.targetCredentials }
          : {}),
      })) {
        fn.addToRolePolicy(statement);
      }
    }
    if (descriptor.needs.includes("target-credentials")) {
      // Stored project credentials are SecureStrings under the suite's
      // shared KMS key; the decrypt grant must not depend on the
      // consumer-registry branch above (scheduler-only agents like bump-it
      // have no consumer registry but still resolve project secrets).
      shared.secretsKey.grantDecrypt(fn);
    }

    // --- Self-publish grants (ADR-0011): runtime.publish sends to the
    // agent's own queue; publishDelayed creates one-shot schedules in the
    // agent's group, passing the Scheduler delivery role.
    if (schedulerWiring !== undefined) {
      inputQueue.grantSendMessages(fn);
      fn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ["scheduler:CreateSchedule"],
          resources: [
            `arn:aws:scheduler:${this.region}:${this.account}:schedule/${schedulerWiring.scheduleGroup.scheduleGroupName}/*`,
          ],
        }),
      );
      fn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ["iam:PassRole"],
          resources: [schedulerWiring.schedulerRole.roleArn],
          conditions: { StringEquals: { "iam:PassedToService": "scheduler.amazonaws.com" } },
        }),
      );
    }

    // --- Trigger: scheduler → the recurring stage=init tick (contract §8).
    // The body is the runtime-message wire shape the SQS shim admits for
    // `sourceTrigger: "scheduler"`; the shim re-stamps requestId/receivedAt
    // from the SQS delivery.
    if (schedulerTrigger !== undefined && registration.tickSchedule !== undefined) {
      if (schedulerWiring === undefined) {
        throw new Error(
          `agent-infra: agent '${registration.id}' has a scheduler trigger but no scheduler wiring (bug)`,
        );
      }
      new scheduler.Schedule(this, "Tick", {
        scheduleName: `leanish-agent-${descriptor.identifier}-tick`,
        scheduleGroup: schedulerWiring.scheduleGroup,
        description: `Recurring stage=init tick for ${descriptor.identifier}`,
        schedule: scheduler.ScheduleExpression.expression(registration.tickSchedule),
        target: new schedulerTargets.SqsSendMessage(inputQueue, {
          role: schedulerWiring.schedulerRole,
          input: scheduler.ScheduleTargetInput.fromObject({
            stage: "init",
            payload: {},
            metadata: { sourceTrigger: "scheduler" },
          }),
        }),
      });
    }

    // --- Trigger: consumer → SQS event-source mapping (partial-batch reporting).
    fn.addEventSource(new SqsEventSource(inputQueue, { reportBatchItemFailures: true, batchSize: 10 }));

    new CfnOutput(this, "InputQueueArn", { value: inputQueue.queueArn });
    new CfnOutput(this, "DlqArn", { value: dlq.queueArn });
    new CfnOutput(this, "FunctionName", { value: fn.functionName });
  }

  /**
   * The per-agent EventBridge Scheduler group (named so the runtime's
   * `SCHEDULE_GROUP_NAME` is stable) and the role Scheduler assumes to
   * deliver schedule payloads to the agent's input queue. Shared by the
   * recurring tick and the runtime's one-shot `publishDelayed` schedules.
   */
  private provisionSchedulerWiring(identifier: string, inputQueue: sqs.Queue): SchedulerWiring {
    const scheduleGroup = new scheduler.ScheduleGroup(this, "ScheduleGroup", {
      scheduleGroupName: `leanish-agent-${identifier}`,
    });
    const schedulerRole = new iam.Role(this, "SchedulerRole", {
      assumedBy: new iam.ServicePrincipal("scheduler.amazonaws.com", {
        conditions: { StringEquals: { "aws:SourceAccount": this.account } },
      }),
      description: `Assumed by EventBridge Scheduler to deliver ${identifier} schedule payloads to its input queue`,
    });
    inputQueue.grantSendMessages(schedulerRole);
    return { scheduleGroup, schedulerRole };
  }
}

interface SchedulerWiring {
  readonly scheduleGroup: scheduler.ScheduleGroup;
  readonly schedulerRole: iam.Role;
}

/**
 * Env vars backing the AWS self-publisher (`createAwsSelfPublisher`). The
 * whole fleet reads the generic `SELF_*`/`SCHEDULE_*` names (ship-it
 * converged from its identifier-prefixed set).
 */
function selfPublishEnv(
  inputQueue: sqs.Queue,
  wiring: SchedulerWiring,
): Record<string, string> {
  return {
    SELF_QUEUE_URL: inputQueue.queueUrl,
    SELF_QUEUE_ARN: inputQueue.queueArn,
    SCHEDULE_GROUP_NAME: wiring.scheduleGroup.scheduleGroupName,
    SCHEDULER_ROLE_ARN: wiring.schedulerRole.roleArn,
  };
}
