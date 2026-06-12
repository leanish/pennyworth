import * as iam from "aws-cdk-lib/aws-iam";
import { getNeedSpec } from "@leanish/runtime";

import {
  NO_TARGET_CREDENTIALS_CONFIG,
  type TargetCredentialsInfraConfig,
} from "./target-credentials-config.js";

export interface NeedPolicyContext {
  readonly need: string;
  /** The agent's descriptor `identifier` (scopes per-agent resource names). */
  readonly agentId: string;
  readonly region: string;
  readonly account: string;
  /** ARN of the suite EventBridge bus (for the `eventbridge` need). */
  readonly eventBusArn: string;
  /** CodeArtifact grant scope (for the `target-credentials` need); empty default = SSM-only. */
  readonly targetCredentials?: TargetCredentialsInfraConfig;
}

/**
 * Translate a declared `need` into the IAM statements its registry entry
 * requires (ADR-0010 `iamActions`), with need-specific resource scoping
 * (contract §3.2 / §3.3). Unknown needs throw — defence-in-depth; the
 * descriptor parser already rejects them.
 */
export function needPolicyStatements(ctx: NeedPolicyContext): iam.PolicyStatement[] {
  const spec = getNeedSpec(ctx.need);
  if (spec === undefined) {
    throw new Error(
      `agent-infra: unknown need '${ctx.need}' (not in the runtime needs registry)`,
    );
  }
  const actions = [...spec.iamActions];
  // e.g. `github` — auth is not IAM (the token is fetched from SSM, granted
  // separately at the agent stack); no IAM statement here.
  if (actions.length === 0) return [];

  switch (ctx.need) {
    case "eventbridge":
      // events:PutEvents → the suite bus only.
      return [new iam.PolicyStatement({ actions, resources: [ctx.eventBusArn] })];

    case "sqs":
      // D7: terminal replies go to consumer-owned `replyTo` queues that can't
      // be enumerated at deploy time. Scope to the reply-queue naming
      // convention rather than `*`.
      return [
        new iam.PolicyStatement({
          actions, // sqs:SendMessage
          resources: [`arn:aws:sqs:${ctx.region}:${ctx.account}:*-${ctx.agentId}-replies`],
        }),
      ];

    case "s3":
      // Attachment fetches: the bucket comes from the per-message `blobUri`.
      // Scope to object reads; tighten to a known attachments-bucket ARN once
      // the consumer-side contract pins one.
      return [new iam.PolicyStatement({ actions, resources: ["arn:aws:s3:::*/*"] })];

    case "target-credentials":
      // The registry's `iamActions` are distributed across scoped statements
      // here rather than granted as one block (the need spans two providers
      // with different resources). KMS decrypt for the SecureStrings is
      // granted at the agent stack (the key construct lives there).
      return targetCredentialsStatements(ctx);

    default:
      // A registered need with IAM actions but no bespoke scoping rule yet —
      // grant account-wide and revisit when the need is actually wired.
      return [new iam.PolicyStatement({ actions, resources: ["*"] })];
  }
}

/**
 * `target-credentials` grants (per the target-credentials design):
 *
 *   - SSM stored secrets: one static wildcard over the convention path
 *     `/leanish/projects/<project-id>/credentials/<NAME>`. The runtime's
 *     schema validation pins every catalog entry to its own project's
 *     prefix, which is what makes the static wildcard safe — adding a
 *     project never touches IAM.
 *   - CodeArtifact derived tokens: only for deploy-configured domain /
 *     repository ARNs (`TargetCredentialsInfraConfig`); read-only by
 *     construction — no publish actions anywhere. `sts:GetServiceBearerToken`
 *     supports no resource scoping, so it is conditioned to the
 *     CodeArtifact service instead.
 */
function targetCredentialsStatements(ctx: NeedPolicyContext): iam.PolicyStatement[] {
  const config = ctx.targetCredentials ?? NO_TARGET_CREDENTIALS_CONFIG;
  const statements = [
    new iam.PolicyStatement({
      actions: ["ssm:GetParameter"],
      resources: [
        `arn:aws:ssm:${ctx.region}:${ctx.account}:parameter/leanish/projects/*/credentials/*`,
      ],
    }),
  ];
  if (config.codeartifactDomainArns.length > 0) {
    statements.push(
      new iam.PolicyStatement({
        actions: ["codeartifact:GetAuthorizationToken"],
        resources: [...config.codeartifactDomainArns],
      }),
      new iam.PolicyStatement({
        actions: ["sts:GetServiceBearerToken"],
        resources: ["*"],
        conditions: { StringEquals: { "sts:AWSServiceName": "codeartifact.amazonaws.com" } },
      }),
    );
  }
  if (config.codeartifactRepositoryArns.length > 0) {
    statements.push(
      new iam.PolicyStatement({
        actions: ["codeartifact:GetRepositoryEndpoint", "codeartifact:ReadFromRepository"],
        resources: [...config.codeartifactRepositoryArns],
      }),
    );
  }
  return statements;
}
