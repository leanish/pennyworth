import { CfnOutput, Duration, Stack, type StackProps } from "aws-cdk-lib";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import type * as sqs from "aws-cdk-lib/aws-sqs";
import type { Construct } from "constructs";

import type { NormalizerRegistration } from "./registry.js";
import type { SharedStack } from "./shared-stack.js";

export interface NormalizerStackProps extends StackProps {
  readonly registration: NormalizerRegistration;
  readonly shared: SharedStack;
  /** ship-it's input queue — the normalizer's signed-envelope SendMessage target. */
  readonly shipItInputQueue: sqs.IQueue;
}

/**
 * The ship-it webhook gate (`agents/ship-it-normalizer`): one container
 * Lambda behind a Function URL that verifies, dedupes, filters, and
 * normalizes Jira/GitHub webhook events into signed `ship-it-event`
 * envelopes on ship-it's input queue. Deliberately NOT an `AgentStack`:
 * it has no descriptor, and no queue/DLQ/idempotency table of its own —
 * provider retries plus ship-it's idempotency cover delivery semantics.
 *
 * The Function URL uses `AuthType: NONE` because webhook authentication is
 * in-code on the raw request bytes (GitHub `X-Hub-Signature-256` HMAC,
 * Jira shared secret) — IAM auth is not an option for provider webhooks.
 */
export class NormalizerStack extends Stack {
  constructor(scope: Construct, id: string, props: NormalizerStackProps) {
    super(scope, id, props);
    const { registration, shared } = props;

    const repo = ecr.Repository.fromRepositoryName(this, "Repo", registration.ecrRepositoryName);
    const fn = new lambda.DockerImageFunction(this, "Fn", {
      functionName: `leanish-${registration.id}`,
      code: lambda.DockerImageCode.fromEcr(repo, { tagOrDigest: registration.imageTag }),
      // Webhook gate, not an agent run: providers time out within seconds,
      // so the agents' 15-minute ceiling does not apply here.
      timeout: Duration.seconds(30),
      memorySize: 512,
      logRetention: logs.RetentionDays.ONE_MONTH,
      environment: {
        SHIP_IT_QUEUE_URL: props.shipItInputQueue.queueUrl,
        CATALOG_BUCKET: shared.catalogBucket.bucketName,
        ...operatorEnv(),
      },
    });

    props.shipItInputQueue.grantSendMessages(fn);
    shared.catalogBucket.grantRead(fn);

    const url = fn.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.NONE });

    new CfnOutput(this, "FunctionUrl", { value: url.url });
    new CfnOutput(this, "FunctionName", { value: fn.functionName });
  }
}

/**
 * Operator-supplied configuration, read from the synth environment as
 * `SHIP_IT_NORMALIZER_<NAME>` (same idiom as the registry image tags).
 * `JIRA_ACCEPTANCE_FIELD` is optional; the rest are required by the
 * Lambda at cold start. Unset values are omitted rather than defaulted so
 * a misconfigured deploy fails with the handler's precise `requireEnv`
 * message instead of running with an empty secret.
 *
 * Note: secrets provided this way land in the template/Lambda env. The
 * runtime-side SSM SecureString resolution (`NeedEnvVar.secretBacked`) is
 * not implemented in the normalizer yet; switch to it when it lands.
 */
function operatorEnv(): Record<string, string> {
  const names = [
    "GITHUB_WEBHOOK_SECRET",
    "JIRA_WEBHOOK_SECRET",
    "ENVELOPE_SIGNING_KEY",
    "JIRA_PROJECT_MAP",
    "JIRA_ACCEPTANCE_FIELD",
  ];
  const env: Record<string, string> = {};
  for (const name of names) {
    const value = process.env[`SHIP_IT_NORMALIZER_${name}`];
    if (value !== undefined && value.length > 0) {
      env[name] = value;
    }
  }
  return env;
}
