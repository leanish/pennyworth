import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DynamoIdempotencyStore } from "../src/idempotency/dynamo.js";
import { LocalStackHarness } from "../src/testing/localstack-harness.js";

/**
 * End-to-end tests for `DynamoIdempotencyStore` and ADR-0006's three-state
 * claim against real DynamoDB. Unit tests verify the `PutItem` command
 * shape with a fake client; these tests verify that real DDB returns the
 * outcomes the runtime expects under real conditional-write behavior —
 * the only path that can validate behaviour that depends on
 * DDB-internal serialisation of concurrent puts.
 *
 * `stack.start()` below throws `LocalStackUnavailableError` if LocalStack
 * isn't reachable — the integration gate fails loudly rather than
 * silently skipping.
 */
describe("DynamoIdempotencyStore against LocalStack", () => {
  const stack = new LocalStackHarness();

  beforeAll(async () => {
    await stack.start();
  });

  afterAll(async () => {
    await stack.stop();
  });

  function fixedTimes(startedAtMs: number, claimMs: number = 16 * 60 * 1000): {
    now: string;
    claimUntil: string;
  } {
    return {
      now: new Date(startedAtMs).toISOString(),
      claimUntil: new Date(startedAtMs + claimMs).toISOString(),
    };
  }

  it("first claim → 'claimed' with the requested in-flight window", async () => {
    const tableName = await stack.createIdempotencyTable();
    const store = new DynamoIdempotencyStore({ tableName, client: stack.dynamoClient() });
    const times = fixedTimes(Date.now());

    const outcome = await store.claim("req-001", {
      agent: "atc",
      now: times.now,
      claimUntil: times.claimUntil,
    });

    expect(outcome.status).toBe("claimed");
    expect(outcome.status === "claimed" && outcome.record.status).toBe("in-flight");
    expect(outcome.status === "claimed" && outcome.record.claimUntil).toBe(times.claimUntil);
  });

  it("second claim with same requestId returns 'duplicate-in-flight' while the first is still live", async () => {
    const tableName = await stack.createIdempotencyTable();
    const store = new DynamoIdempotencyStore({ tableName, client: stack.dynamoClient() });
    const t1 = fixedTimes(Date.now());

    const first = await store.claim("req-002", {
      agent: "atc",
      now: t1.now,
      claimUntil: t1.claimUntil,
    });
    expect(first.status).toBe("claimed");

    // Same requestId, still inside the claim window — SQS redeliveries
    // simulating the original handler still running.
    const second = await store.claim("req-002", {
      agent: "atc",
      now: new Date(Date.now() + 1_000).toISOString(),
      claimUntil: new Date(Date.now() + 1_000 + 16 * 60 * 1000).toISOString(),
    });
    expect(second.status).toBe("duplicate-in-flight");
  });

  it("after complete(), a subsequent claim returns 'duplicate-completed'", async () => {
    const tableName = await stack.createIdempotencyTable();
    const store = new DynamoIdempotencyStore({ tableName, client: stack.dynamoClient() });
    const t1 = fixedTimes(Date.now());

    const first = await store.claim("req-003", {
      agent: "atc",
      now: t1.now,
      claimUntil: t1.claimUntil,
    });
    expect(first.status).toBe("claimed");
    if (first.status !== "claimed") throw new Error("unreachable");

    const completedAt = new Date(Date.now() + 10_000).toISOString();
    const fin = await store.complete("req-003", first.record.claimUntil, completedAt);
    expect(fin.status).toBe("ok");

    const second = await store.claim("req-003", {
      agent: "atc",
      now: new Date(Date.now() + 60_000).toISOString(),
      claimUntil: new Date(Date.now() + 60_000 + 16 * 60 * 1000).toISOString(),
    });
    expect(second.status).toBe("duplicate-completed");
  });

  it("an expired in-flight claim is reclaimed by the next claim()", async () => {
    const tableName = await stack.createIdempotencyTable();
    const store = new DynamoIdempotencyStore({ tableName, client: stack.dynamoClient() });

    // Claim window already in the past — simulates a previous handler
    // that took the claim and never returned (crash before complete).
    const t1 = fixedTimes(Date.now() - 30 * 60 * 1000); // 30 minutes ago
    const first = await store.claim("req-004", {
      agent: "atc",
      now: t1.now,
      claimUntil: t1.claimUntil, // 14 minutes ago
    });
    expect(first.status).toBe("claimed");

    // Fresh delivery arrives now — claimUntil is in the past, so the
    // conditional should reclaim rather than report 'duplicate-in-flight'.
    const t2 = fixedTimes(Date.now());
    const second = await store.claim("req-004", {
      agent: "atc",
      now: t2.now,
      claimUntil: t2.claimUntil,
    });
    expect(second.status).toBe("claimed");
    expect(second.status === "claimed" && second.record.claimUntil).toBe(t2.claimUntil);
  });

  it("complete() returns 'stale' when another worker has reclaimed the row", async () => {
    // Concurrent-handler safety: worker A claims, then crashes silently.
    // Worker B (later delivery) sees expired claim, reclaims. Worker A
    // (somehow still alive) finally calls complete() — must NOT overwrite
    // B's fresh in-flight claim.
    const tableName = await stack.createIdempotencyTable();
    const store = new DynamoIdempotencyStore({ tableName, client: stack.dynamoClient() });

    // Worker A: claim a window in the (relative) past so worker B can reclaim.
    const tA = fixedTimes(Date.now() - 20 * 60 * 1000);
    const aClaim = await store.claim("req-005", {
      agent: "atc",
      now: tA.now,
      claimUntil: tA.claimUntil,
    });
    expect(aClaim.status).toBe("claimed");
    if (aClaim.status !== "claimed") throw new Error("unreachable");

    // Worker B: reclaim (since A's window is now expired).
    const tB = fixedTimes(Date.now());
    const bClaim = await store.claim("req-005", {
      agent: "atc",
      now: tB.now,
      claimUntil: tB.claimUntil,
    });
    expect(bClaim.status).toBe("claimed");

    // Worker A finally calls complete() with its own (stale) ownedUntil.
    const aCompleteOutcome = await store.complete(
      "req-005",
      aClaim.record.claimUntil,
      new Date().toISOString(),
    );
    expect(aCompleteOutcome.status).toBe("stale");
  });

  it("expire() returns 'stale' when another worker has reclaimed the row", async () => {
    // Same shape as the complete() stale-guard, but for the caught-throw path.
    const tableName = await stack.createIdempotencyTable();
    const store = new DynamoIdempotencyStore({ tableName, client: stack.dynamoClient() });

    const tA = fixedTimes(Date.now() - 20 * 60 * 1000);
    const aClaim = await store.claim("req-006", {
      agent: "atc",
      now: tA.now,
      claimUntil: tA.claimUntil,
    });
    if (aClaim.status !== "claimed") throw new Error("unreachable");

    const tB = fixedTimes(Date.now());
    const bClaim = await store.claim("req-006", {
      agent: "atc",
      now: tB.now,
      claimUntil: tB.claimUntil,
    });
    expect(bClaim.status).toBe("claimed");

    const aExpireOutcome = await store.expire(
      "req-006",
      aClaim.record.claimUntil,
      new Date().toISOString(),
    );
    expect(aExpireOutcome.status).toBe("stale");
  });

  it("expire() on a fresh claim sets claimUntil=now so the next claim reclaims immediately", async () => {
    const tableName = await stack.createIdempotencyTable();
    const store = new DynamoIdempotencyStore({ tableName, client: stack.dynamoClient() });

    const t1 = fixedTimes(Date.now());
    const first = await store.claim("req-007", {
      agent: "atc",
      now: t1.now,
      claimUntil: t1.claimUntil,
    });
    if (first.status !== "claimed") throw new Error("unreachable");

    // Handler caught throw → expire().
    const expireOutcome = await store.expire(
      "req-007",
      first.record.claimUntil,
      new Date().toISOString(),
    );
    expect(expireOutcome.status).toBe("ok");

    // Next delivery arrives: should reclaim immediately even though the
    // wall clock is still inside the original window.
    const t2 = fixedTimes(Date.now() + 100);
    const second = await store.claim("req-007", {
      agent: "atc",
      now: t2.now,
      claimUntil: t2.claimUntil,
    });
    expect(second.status).toBe("claimed");
  });
});
