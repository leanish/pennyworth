import {
  type DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
} from "@aws-sdk/client-dynamodb";

import type {
  ConsumerRecord,
  ConsumerRegistry,
  ConsumerSigningKey,
} from "./store.js";

/**
 * DynamoDB-backed `ConsumerRegistry`. One table per agent that has a
 * `signedEnvelope` trigger. Schema:
 *
 *   pk             (string, partition key) — `consumerId`
 *   signingKey     (map)                   — `{ kind: "ssm-parameter" | "literal", value }`
 *   allowedKinds   (string set)            — envelope `kind` values
 *   description    (string)                — optional
 *
 * Operator tooling populates rows. The runtime is read-only at request time.
 */
export interface DynamoConsumerRegistryOptions {
  readonly tableName: string;
  readonly client: DynamoDBClient;
}

export class DynamoConsumerRegistry implements ConsumerRegistry {
  readonly #tableName: string;
  readonly #client: DynamoDBClient;

  constructor(options: DynamoConsumerRegistryOptions) {
    this.#tableName = options.tableName;
    this.#client = options.client;
  }

  async get(consumerId: string): Promise<ConsumerRecord | undefined> {
    const result = await this.#client.send(
      new GetItemCommand({
        TableName: this.#tableName,
        Key: { pk: { S: consumerId } },
      }),
    );
    if (result.Item === undefined) return undefined;
    return parseRecord(result.Item);
  }

  async put(record: ConsumerRecord): Promise<void> {
    const signingKey = encodeSigningKey(record.signingKey);
    await this.#client.send(
      new PutItemCommand({
        TableName: this.#tableName,
        Item: {
          pk: { S: record.consumerId },
          signingKey: { M: signingKey },
          allowedKinds: { SS: [...record.allowedKinds] },
          ...(record.description !== undefined
            ? { description: { S: record.description } }
            : {}),
        },
      }),
    );
  }
}

function encodeSigningKey(sk: ConsumerSigningKey): Record<string, { S: string }> {
  if (sk.kind === "literal") {
    return { kind: { S: "literal" }, base64: { S: sk.base64 } };
  }
  return { kind: { S: "ssm-parameter" }, name: { S: sk.name } };
}

function parseRecord(
  item: Record<string, { S?: string; SS?: string[]; M?: Record<string, { S?: string }> }>,
): ConsumerRecord | undefined {
  const consumerId = item["pk"]?.S;
  const allowedKinds = item["allowedKinds"]?.SS;
  const signingMap = item["signingKey"]?.M;
  if (consumerId === undefined || allowedKinds === undefined || signingMap === undefined) {
    return undefined;
  }
  const kind = signingMap["kind"]?.S;
  let signingKey: ConsumerSigningKey;
  if (kind === "literal") {
    const base64 = signingMap["base64"]?.S;
    if (base64 === undefined) return undefined;
    signingKey = { kind: "literal", base64 };
  } else if (kind === "ssm-parameter") {
    const name = signingMap["name"]?.S;
    if (name === undefined) return undefined;
    signingKey = { kind: "ssm-parameter", name };
  } else {
    return undefined;
  }
  const description = item["description"]?.S;
  return {
    consumerId,
    signingKey,
    allowedKinds,
    ...(description !== undefined ? { description } : {}),
  };
}
