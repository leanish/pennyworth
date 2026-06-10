import { describe, expect, it } from "vitest";

import { MemoryIdempotencyStore } from "../../src/idempotency/memory.js";

describe("MemoryIdempotencyStore — three-state on-receive claim (ADR-0006)", () => {
  const claim = (mins: number) => ({
    agent: "atc",
    now: isoMinutes(mins),
    claimUntil: isoMinutes(mins + 16),
  });

  it("absent → claimed on first delivery", async () => {
    const store = new MemoryIdempotencyStore();
    const outcome = await store.claim("msg-1", claim(0));
    expect(outcome.status).toBe("claimed");
    expect(store.inspect("msg-1")).toMatchObject({ status: "in-flight" });
  });

  it("completed → duplicate-completed; SQS ACKs", async () => {
    const store = new MemoryIdempotencyStore();
    const first = await store.claim("msg-1", claim(0));
    expect(first.status).toBe("claimed");
    if (first.status !== "claimed") return;
    await store.complete("msg-1", first.record.claimUntil, isoMinutes(2));
    const outcome = await store.claim("msg-1", claim(20));
    expect(outcome.status).toBe("duplicate-completed");
  });

  it("live in-flight → duplicate-in-flight; SQS keeps the message", async () => {
    const store = new MemoryIdempotencyStore();
    await store.claim("msg-1", claim(0));
    const outcome = await store.claim("msg-1", claim(5)); // still inside the 16-min window
    expect(outcome.status).toBe("duplicate-in-flight");
  });

  it("expired in-flight → reclaim; handler runs again", async () => {
    const store = new MemoryIdempotencyStore();
    await store.claim("msg-1", claim(0)); // claimUntil = 16min
    const outcome = await store.claim("msg-1", claim(17)); // past the claim window
    expect(outcome.status).toBe("claimed");
  });

  it("caught throw flow → claimUntil moves to now; next delivery reclaims immediately", async () => {
    const store = new MemoryIdempotencyStore();
    const first = await store.claim("msg-1", claim(0));
    if (first.status !== "claimed") throw new Error("expected initial claim");
    await store.expire("msg-1", first.record.claimUntil, isoMinutes(2)); // handler threw at 2min
    const outcome = await store.claim("msg-1", claim(3));
    expect(outcome.status).toBe("claimed");
  });

  it("complete() returns stale when another worker reclaimed in the meantime", async () => {
    const store = new MemoryIdempotencyStore();
    const aClaim = await store.claim("msg-1", claim(0)); // A wins at t=0, claimUntil=16
    if (aClaim.status !== "claimed") throw new Error("expected initial claim");
    // A is slow; at t=17 worker B reclaims (claim window expired).
    const bClaim = await store.claim("msg-1", claim(17));
    expect(bClaim.status).toBe("claimed");
    // A's late complete must not clobber B's live claim.
    const stale = await store.complete("msg-1", aClaim.record.claimUntil, isoMinutes(20));
    expect(stale.status).toBe("stale");
    expect(store.inspect("msg-1")).toMatchObject({ status: "in-flight" });
  });

  it("expire() returns stale when another worker reclaimed in the meantime", async () => {
    const store = new MemoryIdempotencyStore();
    const aClaim = await store.claim("msg-1", claim(0));
    if (aClaim.status !== "claimed") throw new Error("expected initial claim");
    const bClaim = await store.claim("msg-1", claim(17));
    expect(bClaim.status).toBe("claimed");
    const stale = await store.expire("msg-1", aClaim.record.claimUntil, isoMinutes(20));
    expect(stale.status).toBe("stale");
    // B's window survives intact.
    if (bClaim.status === "claimed") {
      expect(store.inspect("msg-1")).toMatchObject({
        status: "in-flight",
        claimUntil: bClaim.record.claimUntil,
      });
    }
  });
});

function isoMinutes(m: number): string {
  return new Date(2026, 0, 1, 0, m, 0).toISOString();
}
