import { App } from "aws-cdk-lib";
import { loadDescriptorFromFile } from "@leanish/runtime";

import { AgentStack } from "../src/agent-stack.js";
import { NormalizerStack } from "../src/normalizer-stack.js";
import { AGENTS, SHIP_IT_NORMALIZER } from "../src/registry.js";
import { SharedStack } from "../src/shared-stack.js";

const app = new App();

// Env-agnostic when CDK_DEFAULT_ACCOUNT is unset (e.g. `cdk synth` with no
// creds); pinned to account+region for `deploy`. Cross-stack refs require both
// stacks share the same env.
const region = process.env["CDK_DEFAULT_REGION"] ?? "us-east-1";
const account = process.env["CDK_DEFAULT_ACCOUNT"];
const env = account !== undefined ? { account, region } : { region };

const shared = new SharedStack(app, "leanish-shared", { env });

const agentStacks = new Map<string, AgentStack>();
for (const registration of AGENTS) {
  // Read + validate the agent's descriptor via the canonical runtime parser
  // (suite-0006 / contract D2 — no descriptor copy, no codegen). Synth parses
  // with the widest phase: infra needs the IAM/env shape of every registered
  // agent regardless of rollout phase — phase admissibility is enforced by
  // the runtime at agent startup, not at synth.
  const descriptor = await loadDescriptorFromFile(registration.descriptorPath, {
    phase: "phase-3",
  });
  const stack = new AgentStack(app, `leanish-agent-${registration.id}`, {
    env,
    registration,
    descriptor,
    shared,
    reservedConcurrency: 10, // D5 phase-1 default; raise per agent as needed
  });
  agentStacks.set(registration.id, stack);
}

// The ship-it webhook gate — feeds signed `ship-it-event` envelopes into
// ship-it's input queue, so it deploys alongside (and depends on) that stack.
const shipIt = agentStacks.get("ship-it");
if (shipIt === undefined) {
  throw new Error("agent-infra: ship-it must be registered — the webhook normalizer targets its input queue");
}
new NormalizerStack(app, `leanish-${SHIP_IT_NORMALIZER.id}`, {
  env,
  registration: SHIP_IT_NORMALIZER,
  shared,
  shipItInputQueue: shipIt.inputQueue,
});

app.synth();
