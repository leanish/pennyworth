import {
  ConditionalCheckFailedException,
  type DynamoDBClient,
  PutItemCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";

import { describe, expect, it, vi } from "vitest";

import { DynamoIdempotencyStore } from "../../src/idempotency/dynamo.js";

/**
 * Fake DDB client: records every send call and lets each test queue the
 * response shape (success, ConditionalCheckFailedException with the
 * conflicting item, etc.).
 */
function makeClient(responses: Array<unknown | (() => unknown)>): DynamoDBClient & {
  calls: Array<{ commandName: string; input: unknown }>;
} {
  const calls: Array<{ commandName: string; input: unknown }> = [];
  const queue = [...responses];
  const send = vi.fn(async (command: { constructor: { name: string }; input: unknown }) => {
    calls.push({ commandName: command.constructor.name, input: command.input });
    const next = queue.shift();
    if (typeof next === "function") {
      const fn = next as () => unknown;
      const value = fn();
      if (value instanceof Error) throw value;
      return value;
    }
    if (next instanceof Error) throw next;
    return next ?? {};
  });
  return Object.assign({ send } as unknown as DynamoDBClient, { calls });
}

describe("DynamoIdempotencyStore", () => {
  it("issues the canonical conditional PutItem on first claim", async () => {
    const client = makeClient([{}]); // empty response = success
    const store = new DynamoIdempotencyStore({ tableName: "atc-idempotency", client });
    const outcome = await store.claim("msg-1", {
      agent: "atc",
      now: "2026-05-23T00:00:00.000Z",
      claimUntil: "2026-05-23T00:16:00.000Z",
    });
    expect(outcome.status).toBe("claimed");
    expect(client.calls).toHaveLength(1);
    const call = client.calls[0]!;
    expect(call.commandName).toBe(PutItemCommand.name);
    const input = call.input as {
      ConditionExpression?: string;
      ExpressionAttributeValues?: Record<string, unknown>;
    };
    expect(input.ConditionExpression).toBe(
      "attribute_not_exists(pk) OR (#status = :inFlight AND claimUntil < :now)",
    );
    expect(input.ExpressionAttributeValues?.[":now"]).toEqual({ S: "2026-05-23T00:00:00.000Z" });
  });

  it("classifies a ConditionalCheckFailed with a completed record as duplicate-completed", async () => {
    const completed = new ConditionalCheckFailedException({
      message: "x",
      $metadata: {},
      Item: {
        pk: { S: "msg-1" },
        status: { S: "completed" },
        startedAt: { S: "2026-05-23T00:00:00.000Z" },
        completedAt: { S: "2026-05-23T00:02:00.000Z" },
        agent: { S: "atc" },
      },
    });
    const client = makeClient([completed]);
    const store = new DynamoIdempotencyStore({ tableName: "atc-idempotency", client });
    const outcome = await store.claim("msg-1", {
      agent: "atc",
      now: "2026-05-23T00:30:00.000Z",
      claimUntil: "2026-05-23T00:46:00.000Z",
    });
    expect(outcome.status).toBe("duplicate-completed");
  });

  it("classifies a live in-flight as duplicate-in-flight", async () => {
    const liveInFlight = new ConditionalCheckFailedException({
      message: "x",
      $metadata: {},
      Item: {
        pk: { S: "msg-1" },
        status: { S: "in-flight" },
        startedAt: { S: "2026-05-23T00:00:00.000Z" },
        claimUntil: { S: "2026-05-23T00:16:00.000Z" },
        agent: { S: "atc" },
      },
    });
    const client = makeClient([liveInFlight]);
    const store = new DynamoIdempotencyStore({ tableName: "atc-idempotency", client });
    const outcome = await store.claim("msg-1", {
      agent: "atc",
      now: "2026-05-23T00:01:00.000Z",
      claimUntil: "2026-05-23T00:17:00.000Z",
    });
    expect(outcome.status).toBe("duplicate-in-flight");
  });

  it("complete() guards on claimUntil and sets a TTL", async () => {
    const client = makeClient([{}]);
    const store = new DynamoIdempotencyStore({
      tableName: "atc-idempotency",
      client,
      completedTtlSeconds: 86_400,
    });
    const result = await store.complete(
      "msg-1",
      "2026-05-23T00:16:00.000Z",
      "2026-05-23T00:02:00.000Z",
    );
    expect(result.status).toBe("ok");
    expect(client.calls[0]!.commandName).toBe(UpdateItemCommand.name);
    const input = client.calls[0]!.input as {
      UpdateExpression?: string;
      ConditionExpression?: string;
      ExpressionAttributeValues?: Record<string, unknown>;
    };
    expect(input.UpdateExpression).toContain("SET #status = :completed");
    expect(input.ConditionExpression).toBe("#status = :inFlight AND claimUntil = :ownedUntil");
    expect(input.ExpressionAttributeValues?.[":ownedUntil"]).toEqual({
      S: "2026-05-23T00:16:00.000Z",
    });
    expect(input.ExpressionAttributeValues?.[":completed"]).toEqual({ S: "completed" });
    // TTL = Date.parse / 1000 + 86_400
    const expectedTtl = Math.floor(Date.parse("2026-05-23T00:02:00.000Z") / 1000) + 86_400;
    expect(input.ExpressionAttributeValues?.[":ttl"]).toEqual({ N: String(expectedTtl) });
  });

  it("complete() returns stale on ConditionalCheckFailedException", async () => {
    const conflict = new ConditionalCheckFailedException({ message: "x", $metadata: {} });
    const client = makeClient([conflict]);
    const store = new DynamoIdempotencyStore({ tableName: "atc-idempotency", client });
    const result = await store.complete(
      "msg-1",
      "2026-05-23T00:16:00.000Z",
      "2026-05-23T00:20:00.000Z",
    );
    expect(result.status).toBe("stale");
  });

  it("expire() guards on claimUntil and moves the window to 'now'", async () => {
    const client = makeClient([{}]);
    const store = new DynamoIdempotencyStore({ tableName: "atc-idempotency", client });
    const result = await store.expire(
      "msg-1",
      "2026-05-23T00:16:00.000Z",
      "2026-05-23T00:02:00.000Z",
    );
    expect(result.status).toBe("ok");
    const input = client.calls[0]!.input as {
      UpdateExpression?: string;
      ConditionExpression?: string;
      ExpressionAttributeValues?: Record<string, unknown>;
    };
    expect(input.UpdateExpression).toBe("SET claimUntil = :now");
    expect(input.ConditionExpression).toBe("#status = :inFlight AND claimUntil = :ownedUntil");
    expect(input.ExpressionAttributeValues?.[":ownedUntil"]).toEqual({
      S: "2026-05-23T00:16:00.000Z",
    });
    expect(input.ExpressionAttributeValues?.[":now"]).toEqual({ S: "2026-05-23T00:02:00.000Z" });
  });

  it("expire() returns stale on ConditionalCheckFailedException", async () => {
    const conflict = new ConditionalCheckFailedException({ message: "x", $metadata: {} });
    const client = makeClient([conflict]);
    const store = new DynamoIdempotencyStore({ tableName: "atc-idempotency", client });
    const result = await store.expire(
      "msg-1",
      "2026-05-23T00:16:00.000Z",
      "2026-05-23T00:20:00.000Z",
    );
    expect(result.status).toBe("stale");
  });
});
