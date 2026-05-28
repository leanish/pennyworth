import { eventbridgeNeed } from "./eventbridge.js";
import { githubNeed } from "./github.js";
import { s3Need } from "./s3.js";
import type { NeedSpec } from "./spec.js";
import { sqsNeed } from "./sqs.js";

/**
 * The closed registry of supported `needs:` values. Per ADR-0010, both the
 * runtime and `agent-infra` read this table — runtime to construct typed
 * clients (and to resolve secret-backed env vars at cold start from SSM
 * Parameter Store SecureString parameters), `agent-infra` to provision IAM
 * (including the `ssm:GetParameter` + KMS decrypt grants).
 *
 * Adding a new need: write the spec module, add it here, and any agent's
 * descriptor can now declare it.
 */
export const needSpecs: ReadonlyMap<string, NeedSpec> = new Map<string, NeedSpec>([
  [eventbridgeNeed.name, eventbridgeNeed as NeedSpec],
  [sqsNeed.name, sqsNeed as NeedSpec],
  [s3Need.name, s3Need as NeedSpec],
  [githubNeed.name, githubNeed as NeedSpec],
]);

export function getNeedSpec(name: string): NeedSpec | undefined {
  return needSpecs.get(name);
}
