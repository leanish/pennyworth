import {
  ConditionalCheckFailedException,
  type DynamoDBClient,
  PutItemCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";

import type {
  ClaimAttempt,
  ClaimOutcome,
  CompletedRecord,
  FinalizeOutcome,
  IdempotencyRecord,
  IdempotencyStore,
  InFlightRecord,
} from "./store.js";

/**
 * DynamoDB-backed `IdempotencyStore`. One table per agent, fixed schema:
 *
 *   pk          (string, partition key) — `requestId` (= SQS MessageId)
 *   status      (string)                — "in-flight" | "completed"
 *   startedAt   (string)                — ISO 8601
 *   claimUntil  (string)                — ISO 8601 (in-flight only)
 *   completedAt (string)                — ISO 8601 (completed only)
 *   agent       (string)                — identifier
 *   ttl         (number)                — UNIX epoch seconds, set on completed records (30-day TTL)
 *
 * The three-state claim from ADR-0006 is implemented as a single
 * `PutItem` with `ConditionExpression`:
 *
 *   attribute_not_exists(pk) OR (status = "in-flight" AND claimUntil < :now)
 *
 * When the condition fails we use `ReturnValuesOnConditionCheckFailure:
 * ALL_OLD` to learn whether the conflicting record is `completed` (skip +
 * ACK the SQS message) or live `in-flight` (skip + report as
 * `batchItemFailures`).
 *
 * `complete()` and `expire()` carry the original `claimUntil` from the
 * caller's own `claim()` outcome. Both writes are conditional on the row
 * still being `in-flight` AND `claimUntil = :originalClaim`. If the row
 * has since been reclaimed (different `claimUntil`) or moved to
 * `completed`, the call returns `stale` and writes nothing — preventing
 * the corruption path described in ADR-0006's "live watchdog" anomaly.
 */
export interface DynamoIdempotencyStoreOptions {
  readonly tableName: string;
  readonly client: DynamoDBClient;
  /** TTL applied to completed records (seconds). Defaults to 30 days. */
  readonly completedTtlSeconds?: number;
}

const THIRTY_DAYS_SECONDS = 30 * 24 * 60 * 60;

export class DynamoIdempotencyStore implements IdempotencyStore {
  readonly #tableName: string;
  readonly #client: DynamoDBClient;
  readonly #completedTtl: number;

  constructor(options: DynamoIdempotencyStoreOptions) {
    this.#tableName = options.tableName;
    this.#client = options.client;
    this.#completedTtl = options.completedTtlSeconds ?? THIRTY_DAYS_SECONDS;
  }

  async claim(requestId: string, attempt: ClaimAttempt): Promise<ClaimOutcome> {
    const newRecord: InFlightRecord = {
      status: "in-flight",
      startedAt: attempt.now,
      claimUntil: attempt.claimUntil,
      agent: attempt.agent,
    };
    try {
      await this.#client.send(
        new PutItemCommand({
          TableName: this.#tableName,
          Item: {
            pk: { S: requestId },
            status: { S: newRecord.status },
            startedAt: { S: newRecord.startedAt },
            claimUntil: { S: newRecord.claimUntil },
            agent: { S: newRecord.agent },
          },
          ConditionExpression:
            "attribute_not_exists(pk) OR (#status = :inFlight AND claimUntil < :now)",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: {
            ":inFlight": { S: "in-flight" },
            ":now": { S: attempt.now },
          },
          ReturnValuesOnConditionCheckFailure: "ALL_OLD",
        }),
      );
      return { status: "claimed", record: newRecord };
    } catch (err) {
      if (!(err instanceof ConditionalCheckFailedException)) {
        throw err;
      }
      const existing = parseRecord(err.Item);
      if (existing === undefined) {
        // Defensive — condition failed but we didn't get the item back.
        throw new Error(
          `Idempotency claim failed for ${requestId} but no existing record was returned`,
        );
      }
      if (existing.status === "completed") {
        return { status: "duplicate-completed", record: existing };
      }
      return { status: "duplicate-in-flight", record: existing };
    }
  }

  async complete(
    requestId: string,
    ownedUntil: string,
    completedAt: string,
  ): Promise<FinalizeOutcome> {
    try {
      await this.#client.send(
        new UpdateItemCommand({
          TableName: this.#tableName,
          Key: { pk: { S: requestId } },
          UpdateExpression:
            "SET #status = :completed, completedAt = :completedAt, #ttl = :ttl REMOVE claimUntil",
          ConditionExpression: "#status = :inFlight AND claimUntil = :ownedUntil",
          ExpressionAttributeNames: { "#status": "status", "#ttl": "ttl" },
          ExpressionAttributeValues: {
            ":completed": { S: "completed" },
            ":inFlight": { S: "in-flight" },
            ":ownedUntil": { S: ownedUntil },
            ":completedAt": { S: completedAt },
            ":ttl": { N: String(Math.floor(Date.parse(completedAt) / 1000) + this.#completedTtl) },
          },
        }),
      );
      return { status: "ok" };
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) {
        return { status: "stale" };
      }
      throw err;
    }
  }

  async expire(
    requestId: string,
    ownedUntil: string,
    now: string,
  ): Promise<FinalizeOutcome> {
    try {
      await this.#client.send(
        new UpdateItemCommand({
          TableName: this.#tableName,
          Key: { pk: { S: requestId } },
          UpdateExpression: "SET claimUntil = :now",
          ConditionExpression: "#status = :inFlight AND claimUntil = :ownedUntil",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: {
            ":inFlight": { S: "in-flight" },
            ":ownedUntil": { S: ownedUntil },
            ":now": { S: now },
          },
        }),
      );
      return { status: "ok" };
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) {
        return { status: "stale" };
      }
      throw err;
    }
  }
}

function parseRecord(
  item: Record<string, { S?: string; N?: string }> | undefined,
): IdempotencyRecord | undefined {
  if (item === undefined) return undefined;
  const status = item["status"]?.S;
  const startedAt = item["startedAt"]?.S;
  const agent = item["agent"]?.S;
  if (status === "in-flight") {
    const claimUntil = item["claimUntil"]?.S;
    if (startedAt === undefined || claimUntil === undefined || agent === undefined) return undefined;
    return { status: "in-flight", startedAt, claimUntil, agent } satisfies InFlightRecord;
  }
  if (status === "completed") {
    const completedAt = item["completedAt"]?.S;
    if (startedAt === undefined || completedAt === undefined || agent === undefined) return undefined;
    return { status: "completed", startedAt, completedAt, agent } satisfies CompletedRecord;
  }
  return undefined;
}
