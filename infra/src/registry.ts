import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", ".."); // monorepo root (infra/src → infra → pennyworth)

/**
 * Per-agent deploy registration. Adding an agent is: write its descriptor in
 * the agent repo, add an entry here, deploy — no IaC in the agent repo
 * (suite-0006). `descriptorPath` is read at synth time via the runtime's
 * `loadDescriptorFromFile` so IAM/env can't drift from the descriptor.
 */
export interface AgentRegistration {
  /** Stack id / resource-name suffix; matches the descriptor `identifier`. */
  readonly id: string;
  /** Absolute path to the agent's `agent.yaml` descriptor. */
  readonly descriptorPath: string;
  /** ECR repository name holding the agent's container image. */
  readonly ecrRepositoryName: string;
  /** Image tag (or digest) to deploy. */
  readonly imageTag: string;
  /**
   * EventBridge Scheduler expression for the recurring stage=init tick
   * (e.g. `rate(1 day)`). Required for — and only valid on — agents whose
   * descriptor declares a `scheduler` trigger; the descriptor declares the
   * trigger shape, the registration owns the deploy-time cadence.
   */
  readonly tickSchedule?: string;
}

export const AGENTS: ReadonlyArray<AgentRegistration> = [
  {
    id: "ask-the-code",
    descriptorPath: join(repoRoot, "agents", "ask-the-code", "agent.yaml"),
    ecrRepositoryName: "leanish/agent-ask-the-code",
    imageTag: process.env["ASK_THE_CODE_IMAGE_TAG"] ?? "latest",
  },
  {
    id: "ship-it",
    descriptorPath: join(repoRoot, "agents", "ship-it", "agent.yaml"),
    ecrRepositoryName: "leanish/agent-ship-it",
    imageTag: process.env["SHIP_IT_IMAGE_TAG"] ?? "latest",
  },
  {
    id: "bump-it",
    descriptorPath: join(repoRoot, "agents", "bump-it", "agent.yaml"),
    ecrRepositoryName: "leanish/agent-bump-it",
    imageTag: process.env["BUMP_IT_IMAGE_TAG"] ?? "latest",
    tickSchedule: "rate(1 day)",
  },
  {
    id: "document-it",
    descriptorPath: join(repoRoot, "agents", "document-it", "agent.yaml"),
    ecrRepositoryName: "leanish/agent-document-it",
    imageTag: process.env["DOCUMENT_IT_IMAGE_TAG"] ?? "latest",
    tickSchedule: "rate(1 day)",
  },
  {
    id: "triage-it",
    descriptorPath: join(repoRoot, "agents", "triage-it", "agent.yaml"),
    ecrRepositoryName: "leanish/agent-triage-it",
    imageTag: process.env["TRIAGE_IT_IMAGE_TAG"] ?? "latest",
  },
];

/**
 * The ship-it webhook normalizer (agents/ship-it-normalizer) is part of the
 * deploy roster but is NOT an `AgentRegistration`: it has no `agent.yaml`
 * (it is a webhook gate Lambda behind a Function URL, not a descriptor-driven
 * agent), so it deploys via its own `NormalizerStack` instead of `AgentStack`.
 */
export interface NormalizerRegistration {
  /** Stack id / resource-name suffix. */
  readonly id: string;
  /** ECR repository name holding the normalizer's container image. */
  readonly ecrRepositoryName: string;
  /** Image tag (or digest) to deploy. */
  readonly imageTag: string;
}

export const SHIP_IT_NORMALIZER: NormalizerRegistration = {
  id: "ship-it-normalizer",
  ecrRepositoryName: "leanish/agent-ship-it-normalizer",
  imageTag: process.env["SHIP_IT_NORMALIZER_IMAGE_TAG"] ?? "latest",
};
