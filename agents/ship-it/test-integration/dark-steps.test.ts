import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

// Scheduler SDK resolves from the workspace root (a dependency of
// @leanish/runtime); integration-test-only, never imported by src/.
import { ListSchedulesCommand } from "@aws-sdk/client-scheduler";

import { FakeCodingAgentRunner, LocalStackHarness } from "@leanish/runtime/testing";

import { createShipItLambdaHandler } from "../src/lambda.js";
import {
  fenced,
  makeSignedEnvelope,
  provisionShipItStack,
  SHIP_IT_ENV_NAMES,
  shipItRequest,
  type CatalogProjectRecord,
} from "./helpers.js";

/**
 * Dark-step gating on the REAL production step registry (no test override
 * of `src/steps.ts` — contrast with pipeline.test.ts): a status mapped to
 * an unreleased step is an advisory skip on the full Lambda path. The
 * message is ACKed (handled, NOT a batch failure → no DLQ), the
 * coding-agent runner never executes, and no revisit is scheduled — while
 * the one released step (groom-it) does run through the very same wiring.
 */
describe("ship-it dark-step gating against LocalStack (production registry)", () => {
  const stack = new LocalStackHarness();
  const originalEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    await stack.start();
    for (const name of SHIP_IT_ENV_NAMES) {
      originalEnv[name] = process.env[name];
    }
  });

  afterAll(async () => {
    for (const [name, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await stack.stop();
  });

  beforeEach(() => {
    for (const name of SHIP_IT_ENV_NAMES) {
      delete process.env[name];
    }
  });

  function project(extensions: Record<string, unknown>): CatalogProjectRecord {
    return {
      id: "acme/widgets",
      // Never cloned in this suite: dark steps skip before any sync, and
      // groom-it is ticket-only. A failure to honor either contract would
      // surface as a loud git-clone error against this URL.
      source: { url: "https://git.invalid/acme/widgets.git", branch: "main" },
      extensions: { "ship-it": extensions },
    };
  }

  async function buildHandler(): Promise<{
    runner: FakeCodingAgentRunner;
    handler: Awaited<ReturnType<typeof createShipItLambdaHandler>>;
  }> {
    const runner = new FakeCodingAgentRunner("claude-code");
    const handler = await createShipItLambdaHandler({
      runners: new Map([["claude-code", runner]]),
    });
    return { runner, handler };
  }

  it("a status mapped to the dark code-it step is ACKed without executing anything", async () => {
    const ctx = await provisionShipItStack(stack, [project({ enabled: true })]);
    const { runner, handler } = await buildHandler();

    // "Ready for Implementation" → code-it via the DEFAULT status map;
    // code-it ships `released: false` today.
    const envelope = makeSignedEnvelope({
      payload: shipItRequest("acme/widgets"),
      secret: ctx.consumerSecret,
    });
    const result = await handler({
      Records: [{ messageId: "dark-code-it-1", body: JSON.stringify(envelope) }],
    });

    // Advisory skip: the message is done (no DLQ), nothing executed.
    expect(result.results[0]?.status).toBe("handled");
    expect(result.batchItemFailures).toHaveLength(0);
    expect(runner.invocations).toHaveLength(0);
    const schedules = await stack
      .schedulerClient()
      .send(new ListSchedulesCommand({ GroupName: ctx.scheduleGroupName }));
    expect(schedules.Schedules ?? []).toHaveLength(0);
  });

  it("a statusSkillMap override routing to dark validate-it is gated the same way", async () => {
    const ctx = await provisionShipItStack(stack, [
      project({
        enabled: true,
        statusSkillMap: { "Ready to Close": "validate-it" },
        validation: { environment: "staging", baseUrl: "https://staging.example.test" },
      }),
    ]);
    const { runner, handler } = await buildHandler();

    const envelope = makeSignedEnvelope({
      payload: shipItRequest("acme/widgets", { ticketStatus: "Ready to Close" }),
      secret: ctx.consumerSecret,
    });
    const result = await handler({
      Records: [{ messageId: "dark-validate-it-1", body: JSON.stringify(envelope) }],
    });

    expect(result.results[0]?.status).toBe("handled");
    expect(result.batchItemFailures).toHaveLength(0);
    expect(runner.invocations).toHaveLength(0);
  });

  it("the released groom-it step DOES run through the same wiring (the gate is the registry, not the pipeline)", async () => {
    const ctx = await provisionShipItStack(stack, [project({ enabled: true })]);
    const { runner, handler } = await buildHandler();
    runner.register("groom-it", () =>
      fenced({ outcome: "ready", findings: [], notes: "ticket already meets the bar" }),
    );

    // "To Groom" → groom-it via the DEFAULT status map; groom-it is the
    // one step released in production today (test/steps.test.ts pins it).
    const envelope = makeSignedEnvelope({
      payload: shipItRequest("acme/widgets", { ticketStatus: "To Groom" }),
      secret: ctx.consumerSecret,
    });
    const result = await handler({
      Records: [{ messageId: "released-groom-it-1", body: JSON.stringify(envelope) }],
    });

    expect(result.results[0]?.status).toBe("handled");
    expect(result.batchItemFailures).toHaveLength(0);
    expect(runner.invocations).toHaveLength(1);
    expect(runner.invocations[0]?.entrypoint.name).toBe("groom-it");
    // Ticket-only step: no working copy was mounted (and none could be —
    // the fixture's source URL is uncloneable by construction).
    expect(runner.invocations[0]?.workingCopies).toEqual([]);
  });
});
