import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const suiteRoot = join(here, "..", ".."); // .../agentic-development

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
}

export const AGENTS: ReadonlyArray<AgentRegistration> = [
  {
    id: "atc",
    descriptorPath: join(suiteRoot, "agent-atc", "agent.yaml"),
    ecrRepositoryName: "leanish/agent-atc",
    imageTag: process.env["ATC_IMAGE_TAG"] ?? "latest",
  },
];
