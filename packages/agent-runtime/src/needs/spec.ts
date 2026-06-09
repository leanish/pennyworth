import type { Logger } from "../types/logger.js";

/**
 * One `NeedSpec` per `needs:` value. Per ADR-0010, each entry describes
 * deploy-time metadata (env vars, IAM grants) and runtime client construction
 * for both AWS mode and local mode.
 *
 * `agent-infra` reads `envVars` / `iamActions` to provision the Lambda. The
 * runtime reads `awsFactory` / `localFactory` to construct the typed client
 * exposed at `runtime.clients.<name>`.
 */
export interface NeedSpec<TClient = unknown> {
  /** Stable property name on `runtime.clients`. Matches the `needs:` entry. */
  readonly name: string;
  /** Env vars the agent's runtime expects to be set. `agent-infra` provisions them. */
  readonly envVars: ReadonlyArray<NeedEnvVar>;
  /** IAM actions the agent's role needs. */
  readonly iamActions: ReadonlyArray<string>;
  /** Factory used in AWS deployment. */
  awsFactory(ctx: NeedFactoryContext): TClient;
  /** Factory used in local mode. May be a no-op / logging stub. */
  localFactory(ctx: NeedFactoryContext): TClient;
}

export interface NeedEnvVar {
  readonly name: string;
  readonly description: string;
  /**
   * When `true`, the runtime resolves this env var at cold start by fetching
   * an SSM Parameter Store `SecureString` parameter (NOT baked in at deploy
   * time via a CloudFormation `{{resolve:secretsmanager}}` reference). See
   * ADR-0010. `agent-infra` grants the `ssm:GetParameter` + KMS decrypt
   * permissions; the parameter name is wired via this env var's value.
   */
  readonly secretBacked?: boolean;
}

export interface NeedFactoryContext {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly region: string;
  readonly logger: Logger;
}
