import { App } from "aws-cdk-lib";
import { loadDescriptorFromFile } from "@leanish/agent-runtime";

import { AgentStack } from "../src/agent-stack.js";
import { AGENTS } from "../src/registry.js";
import { SharedStack } from "../src/shared-stack.js";

const app = new App();

// Env-agnostic when CDK_DEFAULT_ACCOUNT is unset (e.g. `cdk synth` with no
// creds); pinned to account+region for `deploy`. Cross-stack refs require both
// stacks share the same env.
const region = process.env["CDK_DEFAULT_REGION"] ?? "us-east-1";
const account = process.env["CDK_DEFAULT_ACCOUNT"];
const env = account !== undefined ? { account, region } : { region };

const shared = new SharedStack(app, "leanish-shared", { env });

for (const registration of AGENTS) {
  // Read + validate the agent's descriptor via the canonical runtime parser
  // (suite-0006 / contract D2 — no descriptor copy, no codegen).
  const descriptor = await loadDescriptorFromFile(registration.descriptorPath);
  new AgentStack(app, `leanish-agent-${registration.id}`, {
    env,
    registration,
    descriptor,
    shared,
    reservedConcurrency: 10, // D5 phase-1 default; raise per agent as needed
  });
}

app.synth();
