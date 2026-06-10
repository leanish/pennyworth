import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  dedupeKey,
  githubDeliveryId,
  InMemoryTtlDedupeStore,
  jiraDeliveryId,
} from "../src/dedupe.js";

describe("InMemoryTtlDedupeStore", () => {
  it("claims on first sight and reports the second sight as duplicate", async () => {
    const store = new InMemoryTtlDedupeStore();
    expect(await store.claim("github:d1:synchronize")).toBe("claimed");
    expect(await store.claim("github:d1:synchronize")).toBe("duplicate");
  });

  it("keeps distinct keys independent", async () => {
    const store = new InMemoryTtlDedupeStore();
    expect(await store.claim("github:d1:synchronize")).toBe("claimed");
    expect(await store.claim("github:d1:ready_for_review")).toBe("claimed");
    expect(await store.claim("jira:d1:synchronize")).toBe("claimed");
  });

  it("release re-admits a claimed key (the failed-send retry path)", async () => {
    const store = new InMemoryTtlDedupeStore();
    expect(await store.claim("k")).toBe("claimed");
    await store.release("k");
    expect(await store.claim("k")).toBe("claimed");
  });

  it("re-admits a key after the TTL expires (lazy eviction)", async () => {
    let nowMs = 1_000;
    const store = new InMemoryTtlDedupeStore({ ttlMs: 60_000, now: () => nowMs });

    expect(await store.claim("k")).toBe("claimed");
    nowMs += 59_999;
    expect(await store.claim("k")).toBe("duplicate");
    nowMs += 2;
    expect(await store.claim("k")).toBe("claimed");
  });
});

describe("delivery ids", () => {
  const raw = Buffer.from('{"x":1}', "utf8");
  const rawHash = createHash("sha256").update(raw).digest("hex");

  it("builds the route:deliveryId:action key", () => {
    expect(dedupeKey("github", "d-1", "synchronize")).toBe("github:d-1:synchronize");
  });

  it("uses the x-github-delivery header when present, else hashes the body", () => {
    expect(githubDeliveryId("uuid-1", raw)).toBe("uuid-1");
    expect(githubDeliveryId(undefined, raw)).toBe(rawHash);
    expect(githubDeliveryId("", raw)).toBe(rawHash);
  });

  it("uses the jira body event id when present, else hashes the body", () => {
    expect(jiraDeliveryId({ id: "evt-1" }, raw)).toBe("evt-1");
    expect(jiraDeliveryId({ id: 42 }, raw)).toBe("42");
    expect(jiraDeliveryId({}, raw)).toBe(rawHash);
    expect(jiraDeliveryId("not-an-object", raw)).toBe(rawHash);
  });
});
