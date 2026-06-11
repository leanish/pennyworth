import * as iam from "aws-cdk-lib/aws-iam";
import { getNeedSpec } from "@leanish/runtime";

export interface NeedPolicyContext {
  readonly need: string;
  /** The agent's descriptor `identifier` (scopes per-agent resource names). */
  readonly agentId: string;
  readonly region: string;
  readonly account: string;
  /** ARN of the suite EventBridge bus (for the `eventbridge` need). */
  readonly eventBusArn: string;
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

    default:
      // A registered need with IAM actions but no bespoke scoping rule yet —
      // grant account-wide and revisit when the need is actually wired.
      return [new iam.PolicyStatement({ actions, resources: ["*"] })];
  }
}
