import { createHash, randomUUID } from "node:crypto";

import type { Stage } from "../types/stage.js";

/**
 * The wire shape a self-published message travels as (SQS body / Scheduler
 * target input). Mirrors `RuntimeMessage` but `metadata` carries only the
 * fields the publisher can truthfully assert: the receiving shim re-stamps
 * `requestId` (with the SQS MessageId — the idempotency key) and
 * `receivedAt` at delivery; `publishedAt` here is provenance, not the
 * receipt time.
 */
export interface SelfMessageBody {
  readonly stage: Stage;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly metadata: {
    readonly sourceTrigger: "self";
    /** Publish-time provenance id; NOT the delivery idempotency key. */
    readonly requestId: string;
    readonly publishedAt: string;
  };
}

export function buildSelfMessageBody(args: {
  readonly stage: Stage;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly clock?: () => string;
}): SelfMessageBody {
  return {
    stage: args.stage,
    payload: args.payload,
    metadata: {
      sourceTrigger: "self",
      requestId: randomUUID(),
      publishedAt: (args.clock ?? (() => new Date().toISOString()))(),
    },
  };
}

/**
 * Canonical JSON per ADR-0011 §Mechanism: object keys recursively sorted,
 * arrays in declared order. Structurally-equal payloads with different key
 * orders serialise identically, so the derived schedule name collides and
 * `CreateSchedule` dedupes.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
  return `{${entries.join(",")}}`;
}

/**
 * Stable EventBridge Scheduler name per ADR-0011: SHA-256 over the
 * canonical `{ agentId, stage, payload }`, truncated to 32 hex chars,
 * prefixed with the agent id. Repeated `publishDelayed` calls with the
 * same logical payload derive the same name and dedupe at CreateSchedule.
 */
export function deriveScheduleName(args: {
  readonly agentId: string;
  readonly stage: Stage;
  readonly payload: Readonly<Record<string, unknown>>;
}): string {
  const canonical = canonicalJson({
    agentId: args.agentId,
    stage: args.stage,
    payload: args.payload,
  });
  const hex = createHash("sha256").update(canonical, "utf8").digest("hex").slice(0, 32);
  return `${args.agentId}-${hex}`;
}
