import type { Effort } from "./execution-override.js";
import type { Stage } from "./stage.js";

/**
 * The validated, parsed shape of an agent's `agent.yaml`. Canonical reference:
 * `agent-runtime/specs/descriptor.md`.
 *
 * Phase 1 only ships `consumer` triggers; the parser rejects others. The
 * union below is kept open so phase-2+ additions are additive.
 */
export interface AgentDescriptor {
  readonly identifier: string;
  readonly compute: ComputeTarget;
  readonly triggers: ReadonlyArray<Trigger>; // non-empty
  readonly stages: ReadonlyArray<Stage>; // non-empty
  readonly codingAgent: string;
  readonly model: string;
  readonly effort?: Effort;
  readonly skills: DescriptorSkills;
  readonly needs: ReadonlyArray<string>;
  readonly extensions: Readonly<Record<string, unknown>>;
}

export type ComputeTarget = "lambda" | "fargate";

export interface DescriptorSkills {
  readonly entrypoints: ReadonlyArray<string>; // non-empty
  readonly support: ReadonlyArray<string>;
}

export type Trigger =
  | ConsumerTrigger
  | SchedulerTrigger
  | GhWebhookTrigger
  | JiraWebhookTrigger
  | AlertTrigger;

export interface ConsumerTrigger {
  readonly type: "consumer";
  readonly queueArnRef: string;
  readonly dlqArnRef: string;
  readonly signedEnvelope: boolean;
}

/** Phase 2 — declared here for forward-compat, parser rejects in phase 1. */
export interface SchedulerTrigger {
  readonly type: "scheduler";
  readonly queueArnRef: string;
  readonly dlqArnRef: string;
}

/** Phase 3+ — declared here for forward-compat, parser rejects in phase 1. */
export interface GhWebhookTrigger {
  readonly type: "gh-webhook";
  readonly events: ReadonlyArray<string>;
  readonly signingSecret: SigningSecretRef;
}

export interface JiraWebhookTrigger {
  readonly type: "jira-webhook";
  readonly events: ReadonlyArray<string>;
  readonly signingSecret: SigningSecretRef;
}

export interface AlertTrigger {
  readonly type: "alert";
  readonly source: string;
}

export interface SigningSecretRef {
  /** SSM Parameter Store SecureString is the suite's only secret store (ADR-0010). */
  readonly kind: "ssm";
  readonly ref: string;
}
