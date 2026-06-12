import { describe, expect, it } from "vitest";

import { parseDescriptor } from "../../src/descriptor/parse.js";
import { DescriptorValidationError } from "../../src/errors.js";

const ATC_PHASE_1_YAML = `
identifier: atc
compute: lambda

triggers:
  - type: consumer
    queueArnRef: atc-requests
    dlqArnRef: atc-requests-dlq
    signedEnvelope: true

stages: [init]

codingAgent: claude-code
model: claude-sonnet-4-6

skills:
  entrypoints:
    - ask
  support:
    - karpathy-guidelines
    - diagnose

needs:
  - eventbridge
  - sqs
`;

describe("parseDescriptor", () => {
  it("accepts a well-formed phase-1 ATC descriptor", () => {
    const descriptor = parseDescriptor(ATC_PHASE_1_YAML);
    expect(descriptor.identifier).toBe("atc");
    expect(descriptor.compute).toBe("lambda");
    expect(descriptor.stages).toEqual(["init"]);
    expect(descriptor.skills.entrypoints).toEqual(["ask"]);
    expect(descriptor.skills.support).toEqual(["karpathy-guidelines", "diagnose"]);
    expect(descriptor.needs).toEqual(["eventbridge", "sqs"]);
    expect(descriptor.triggers).toHaveLength(1);
    expect(descriptor.triggers[0]).toMatchObject({
      type: "consumer",
      queueArnRef: "atc-requests",
      dlqArnRef: "atc-requests-dlq",
      signedEnvelope: true,
    });
  });

  it("defaults signedEnvelope to false when omitted", () => {
    const yaml = `
identifier: foo
compute: lambda
triggers:
  - type: consumer
    queueArnRef: foo
    dlqArnRef: foo-dlq
stages: [init]
codingAgent: claude-code
model: m
skills:
  entrypoints: [bar]
`;
    const descriptor = parseDescriptor(yaml);
    expect(descriptor.triggers[0]).toMatchObject({ signedEnvelope: false });
  });

  it("rejects scheduler trigger in phase-1", () => {
    const yaml = `
identifier: bumpit
compute: lambda
triggers:
  - type: scheduler
    queueArnRef: q
    dlqArnRef: dlq
stages: [init]
codingAgent: claude-code
model: m
skills:
  entrypoints: [bumpit]
`;
    expect(() => parseDescriptor(yaml, { phase: "phase-1" })).toThrowError(
      DescriptorValidationError,
    );
  });

  it("accepts scheduler trigger when running in phase-2", () => {
    const yaml = `
identifier: bumpit
compute: lambda
triggers:
  - type: scheduler
    queueArnRef: q
    dlqArnRef: dlq
stages: [init, breakdown, revisit]
codingAgent: claude-code
model: m
skills:
  entrypoints: [bumpit, bumpit-revisit]
`;
    const descriptor = parseDescriptor(yaml, { phase: "phase-2" });
    expect(descriptor.triggers[0]).toMatchObject({ type: "scheduler" });
    expect(descriptor.stages).toEqual(["init", "breakdown", "revisit"]);
  });

  it("rejects fargate compute in phase-1", () => {
    const yaml = `
identifier: foo
compute: fargate
triggers:
  - type: consumer
    queueArnRef: q
    dlqArnRef: dlq
stages: [init]
codingAgent: claude-code
model: m
skills:
  entrypoints: [bar]
`;
    try {
      parseDescriptor(yaml);
      expect.unreachable("expected DescriptorValidationError");
    } catch (err) {
      expect(err).toBeInstanceOf(DescriptorValidationError);
      const issues = (err as DescriptorValidationError).issues;
      expect(issues.some((i) => i.category === "compute-phase-mismatch")).toBe(true);
    }
  });

  it("rejects unknown top-level fields", () => {
    const yaml = `
identifier: foo
compute: lambda
nonsense: 42
triggers:
  - type: consumer
    queueArnRef: q
    dlqArnRef: dlq
stages: [init]
codingAgent: claude-code
model: m
skills:
  entrypoints: [bar]
`;
    try {
      parseDescriptor(yaml);
      expect.unreachable();
    } catch (err) {
      const issues = (err as DescriptorValidationError).issues;
      expect(issues.some((i) => i.path === "nonsense" && i.category === "unknown-field")).toBe(true);
    }
  });

  it("rejects empty stages", () => {
    const yaml = `
identifier: foo
compute: lambda
triggers:
  - type: consumer
    queueArnRef: q
    dlqArnRef: dlq
stages: []
codingAgent: claude-code
model: m
skills:
  entrypoints: [bar]
`;
    try {
      parseDescriptor(yaml);
      expect.unreachable();
    } catch (err) {
      const issues = (err as DescriptorValidationError).issues;
      expect(issues.some((i) => i.category === "empty-stages")).toBe(true);
    }
  });

  it("rejects unknown stage values", () => {
    const yaml = `
identifier: foo
compute: lambda
triggers:
  - type: consumer
    queueArnRef: q
    dlqArnRef: dlq
stages: [init, finalize]
codingAgent: claude-code
model: m
skills:
  entrypoints: [bar]
`;
    try {
      parseDescriptor(yaml);
      expect.unreachable();
    } catch (err) {
      const issues = (err as DescriptorValidationError).issues;
      expect(issues.some((i) => i.category === "unknown-stage" && i.path === "stages.1")).toBe(true);
    }
  });

  it("rejects empty entrypoints", () => {
    const yaml = `
identifier: foo
compute: lambda
triggers:
  - type: consumer
    queueArnRef: q
    dlqArnRef: dlq
stages: [init]
codingAgent: claude-code
model: m
skills:
  entrypoints: []
`;
    try {
      parseDescriptor(yaml);
      expect.unreachable();
    } catch (err) {
      const issues = (err as DescriptorValidationError).issues;
      expect(issues.some((i) => i.category === "empty-entrypoints")).toBe(true);
    }
  });

  it("rejects duplicate needs entries", () => {
    const yaml = `
identifier: foo
compute: lambda
triggers:
  - type: consumer
    queueArnRef: q
    dlqArnRef: dlq
stages: [init]
codingAgent: claude-code
model: m
skills:
  entrypoints: [ask]
needs:
  - eventbridge
  - eventbridge
`;
    try {
      parseDescriptor(yaml);
      expect.unreachable();
    } catch (err) {
      const issues = (err as DescriptorValidationError).issues;
      expect(issues.some((i) => i.category === "duplicate-need")).toBe(true);
    }
  });
});
