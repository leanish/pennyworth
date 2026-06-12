import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  loadDescriptorFromFile,
  type AgentDescriptor,
  type ConsumerTrigger,
  type SchedulerTrigger,
} from "@leanish/runtime";
import { describe, expect, it } from "vitest";

import { AGENTS, SHIP_IT_NORMALIZER } from "../src/registry.js";

const here = dirname(fileURLToPath(import.meta.url));
const agentsRoot = join(here, "..", "..", "agents"); // infra/test → infra → pennyworth

// Widest phase, mirroring `bin/agent-infra.ts`: the roster must parse
// regardless of each agent's rollout phase.
const loaded: ReadonlyArray<{
  readonly id: string;
  readonly tickSchedule: string | undefined;
  readonly descriptor: AgentDescriptor;
}> = await Promise.all(
  AGENTS.map(async (registration) => ({
    id: registration.id,
    tickSchedule: registration.tickSchedule,
    descriptor: await loadDescriptorFromFile(registration.descriptorPath, {
      phase: "phase-3",
    }),
  })),
);

// CDK-free: cross-checks the deploy roster against the agents' own
// `agent.yaml` descriptors (read-only), so union-merge artifacts — dropped
// or duplicated entries, refs no descriptor declares, naming drift — fail
// fast without a synth.
describe("registry ⇄ descriptor consistency", () => {
  it("registers every agents/<name>/agent.yaml exactly once", async () => {
    const onDisk = await readdir(agentsRoot, { withFileTypes: true });
    const descriptorDirs = (
      await Promise.all(
        onDisk
          .filter((entry) => entry.isDirectory())
          .map(async (entry) => {
            const files = await readdir(join(agentsRoot, entry.name));
            return files.includes("agent.yaml") ? [entry.name] : [];
          }),
      )
    ).flat();
    expect(descriptorDirs.sort()).toEqual(AGENTS.map((a) => a.id).slice().sort());
  });

  it("matches each descriptor identifier to its registry id", () => {
    for (const { id, descriptor } of loaded) {
      expect(descriptor.identifier).toBe(id);
    }
  });

  it("follows the leanish/agent-<id> ECR naming convention", () => {
    for (const registration of AGENTS) {
      expect(registration.ecrRepositoryName).toBe(`leanish/agent-${registration.id}`);
    }
  });

  it("uses the <id>-requests / <id>-requests-dlq queue refs in every queue-backed trigger", () => {
    for (const { id, descriptor } of loaded) {
      const queueTriggers = descriptor.triggers.filter(
        (t): t is ConsumerTrigger | SchedulerTrigger =>
          t.type === "consumer" || t.type === "scheduler",
      );
      expect(queueTriggers.length).toBeGreaterThan(0);
      for (const trigger of queueTriggers) {
        expect(trigger.queueArnRef).toBe(`${id}-requests`);
        expect(trigger.dlqArnRef).toBe(`${id}-requests-dlq`);
      }
    }
  });

  it("declares a tick schedule exactly for the scheduler-trigger agents", () => {
    for (const { id, tickSchedule, descriptor } of loaded) {
      const hasSchedulerTrigger = descriptor.triggers.some((t) => t.type === "scheduler");
      expect(
        tickSchedule !== undefined,
        `agent '${id}': tickSchedule must be set iff the descriptor declares a scheduler trigger`,
      ).toBe(hasSchedulerTrigger);
    }
  });

  it("keeps the webhook normalizer off the agent roster but on the fleet ECR convention", () => {
    // No agent.yaml exists for it — it must not appear in AGENTS.
    expect(AGENTS.some((a) => a.id === SHIP_IT_NORMALIZER.id)).toBe(false);
    expect(SHIP_IT_NORMALIZER.ecrRepositoryName).toBe(
      `leanish/agent-${SHIP_IT_NORMALIZER.id}`,
    );
    expect(SHIP_IT_NORMALIZER.imageTag.length).toBeGreaterThan(0);
  });
});
