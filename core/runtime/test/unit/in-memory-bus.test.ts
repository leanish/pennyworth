import { describe, expect, it } from "vitest";

import { InMemoryEventBus, InMemorySqsBus } from "../../src/testing/in-memory-bus.js";

describe("InMemoryEventBus", () => {
  it("captures every entry across multiple putEvents calls in arrival order", async () => {
    const bus = new InMemoryEventBus();
    await bus.putEvents({
      entries: [
        { source: "atc", detailType: "atc.ask.received", detail: { id: "r-1" } },
        { source: "atc", detailType: "atc.ask.completed", detail: { id: "r-1" } },
      ],
    });
    await bus.putEvents({
      entries: [{ source: "bumpit", detailType: "bumpit.scan.started", detail: {} }],
    });
    expect(bus.entries).toHaveLength(3);
    expect(bus.entries[0]?.detailType).toBe("atc.ask.received");
    expect(bus.entries[2]?.source).toBe("bumpit");
  });

  it("returns failedCount=0 (no failure injection)", async () => {
    const bus = new InMemoryEventBus();
    const result = await bus.putEvents({
      entries: [{ source: "x", detailType: "y", detail: {} }],
    });
    expect(result.failedCount).toBe(0);
  });

  it("clear() drops captured entries", async () => {
    const bus = new InMemoryEventBus();
    await bus.putEvents({ entries: [{ source: "x", detailType: "y", detail: {} }] });
    bus.clear();
    expect(bus.entries).toHaveLength(0);
  });
});

describe("InMemorySqsBus", () => {
  it("captures every sendMessage with a monotonic synthesised messageId", async () => {
    const bus = new InMemorySqsBus();
    const a = await bus.sendMessage({ queueUrl: "https://q/1", body: "first" });
    const b = await bus.sendMessage({ queueUrl: "https://q/1", body: "second" });
    expect(a.messageId).toBe("in-memory-sqs-1");
    expect(b.messageId).toBe("in-memory-sqs-2");
    expect(bus.messages).toHaveLength(2);
    expect(bus.messages[0]?.request.body).toBe("first");
    expect(bus.messages[1]?.request.body).toBe("second");
  });

  it("clear() resets messages and the counter", async () => {
    const bus = new InMemorySqsBus();
    await bus.sendMessage({ queueUrl: "https://q/1", body: "first" });
    bus.clear();
    const after = await bus.sendMessage({ queueUrl: "https://q/1", body: "after" });
    expect(after.messageId).toBe("in-memory-sqs-1");
    expect(bus.messages).toHaveLength(1);
  });
});
