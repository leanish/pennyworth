import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { loadDescriptorFromFile } from "@leanish/runtime";
import { describe, expect, it } from "vitest";

import { AgentStack } from "../src/agent-stack.js";
import { NormalizerStack } from "../src/normalizer-stack.js";
import { AGENTS, SHIP_IT_NORMALIZER, type AgentRegistration } from "../src/registry.js";
import { SharedStack } from "../src/shared-stack.js";

// Synth-level assertions on the highest-risk wiring, driven by the real
// registry + descriptors (no fixtures to drift). One app synthesizes the
// whole roster, mirroring `bin/agent-infra.ts`.
const app = new App();
const shared = new SharedStack(app, "leanish-shared");
const agentStacks = new Map<string, AgentStack>();
for (const registration of AGENTS) {
  const descriptor = await loadDescriptorFromFile(registration.descriptorPath, {
    phase: "phase-3",
  });
  const stack = new AgentStack(app, `leanish-agent-${registration.id}`, {
    registration,
    descriptor,
    shared,
    reservedConcurrency: 10,
  });
  agentStacks.set(registration.id, stack);
}
const shipItStack = agentStacks.get("ship-it");
if (shipItStack === undefined) throw new Error("ship-it missing from the registry");
const normalizerStack = new NormalizerStack(app, `leanish-${SHIP_IT_NORMALIZER.id}`, {
  registration: SHIP_IT_NORMALIZER,
  shared,
  shipItInputQueue: shipItStack.inputQueue,
});

// Templates are built after the whole tree exists, so synth sees the final app.
const agentTemplates = new Map<string, Template>(
  [...agentStacks].map(([id, stack]) => [id, Template.fromStack(stack)]),
);
const normalizerTemplate = Template.fromStack(normalizerStack);

function template(id: string): Template {
  const t = agentTemplates.get(id);
  if (t === undefined) throw new Error(`agent '${id}' missing from the registry`);
  return t;
}

describe("agent stacks", () => {
  it("provisions an input queue + DLQ pair with the ADR-0006 timeout interlock for every agent", () => {
    for (const registration of AGENTS) {
      const t = template(registration.id);
      t.resourceCountIs("AWS::SQS::Queue", 2);
      t.hasResourceProperties("AWS::SQS::Queue", {
        VisibilityTimeout: 17 * 60,
        RedrivePolicy: Match.objectLike({ maxReceiveCount: 5 }),
      });
      t.hasResourceProperties("AWS::Lambda::EventSourceMapping", {
        FunctionResponseTypes: ["ReportBatchItemFailures"],
      });
    }
  });

  it("materializes the recurring stage=init tick for the scheduler-trigger agents", () => {
    for (const id of ["secure-it", "document-it"]) {
      const t = template(id);
      t.hasResourceProperties("AWS::Scheduler::ScheduleGroup", {
        Name: `leanish-agent-${id}`,
      });
      t.hasResourceProperties("AWS::Scheduler::Schedule", {
        Name: `leanish-agent-${id}-tick`,
        GroupName: `leanish-agent-${id}`,
        ScheduleExpression: "rate(1 day)",
        FlexibleTimeWindow: { Mode: "OFF" },
        Target: Match.objectLike({
          Input: JSON.stringify({
            stage: "init",
            payload: {},
            metadata: { sourceTrigger: "scheduler" },
          }),
        }),
      });
    }
  });

  it("wires the self-publish env + grants for every multi-stage agent", () => {
    for (const id of ["ship-it", "secure-it", "document-it"]) {
      const t = template(id);
      t.hasResourceProperties("AWS::Lambda::Function", {
        FunctionName: `leanish-${id}`,
        Environment: {
          Variables: Match.objectLike({
            SELF_QUEUE_URL: Match.anyValue(),
            SELF_QUEUE_ARN: Match.anyValue(),
            SCHEDULE_GROUP_NAME: `leanish-agent-${id}`,
            SCHEDULER_ROLE_ARN: Match.anyValue(),
          }),
        },
      });
      // publish → SendMessage on its own queue; publishDelayed →
      // CreateSchedule in its group + PassRole on the Scheduler role.
      t.hasResourceProperties("AWS::IAM::Policy", {
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({ Action: "scheduler:CreateSchedule" }),
            Match.objectLike({
              Action: "iam:PassRole",
              Condition: {
                StringEquals: { "iam:PassedToService": "scheduler.amazonaws.com" },
              },
            }),
          ]),
        }),
      });
    }
  });

  it("keeps single-stage consumer agents free of scheduler wiring", () => {
    for (const id of ["ask-the-code", "triage-it"]) {
      const t = template(id);
      t.resourceCountIs("AWS::Scheduler::Schedule", 0);
      t.resourceCountIs("AWS::Scheduler::ScheduleGroup", 0);
      t.hasResourceProperties("AWS::Lambda::Function", {
        FunctionName: `leanish-${id}`,
        Environment: {
          Variables: Match.not(Match.objectLike({ SELF_QUEUE_URL: Match.anyValue() })),
        },
      });
    }
  });

  it("gives ship-it a schedule group for one-shot revisits but no recurring tick", () => {
    const t = template("ship-it");
    t.resourceCountIs("AWS::Scheduler::ScheduleGroup", 1);
    t.resourceCountIs("AWS::Scheduler::Schedule", 0);
  });
});

describe("normalizer stack", () => {
  it("exposes the webhook gate via an unauthenticated Function URL (auth is in-code HMAC)", () => {
    normalizerTemplate.hasResourceProperties("AWS::Lambda::Url", {
      AuthType: "NONE",
    });
  });

  it("targets ship-it's input queue and reads the catalog bucket", () => {
    normalizerTemplate.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: `leanish-${SHIP_IT_NORMALIZER.id}`,
      Environment: {
        Variables: Match.objectLike({
          SHIP_IT_QUEUE_URL: Match.anyValue(),
          CATALOG_BUCKET: Match.anyValue(),
        }),
      },
    });
    normalizerTemplate.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith(["sqs:SendMessage"]),
          }),
        ]),
      }),
    });
  });

  it("provisions no queue, DLQ, or tables of its own", () => {
    normalizerTemplate.resourceCountIs("AWS::SQS::Queue", 0);
    normalizerTemplate.resourceCountIs("AWS::DynamoDB::Table", 0);
  });
});

describe("app wiring", () => {
  it("synthesizes one stack per registered agent plus shared + normalizer", () => {
    const assembly = app.synth();
    const stackNames = assembly.stacks.map((s) => s.stackName).sort();
    expect(stackNames).toEqual(
      [
        "leanish-shared",
        `leanish-${SHIP_IT_NORMALIZER.id}`,
        ...AGENTS.map((a: AgentRegistration) => `leanish-agent-${a.id}`),
      ].sort(),
    );
  });
});
