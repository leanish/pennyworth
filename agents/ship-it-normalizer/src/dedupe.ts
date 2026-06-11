import { createHash } from "node:crypto";

/**
 * Delivery dedupe store with claim/release semantics, so a FAILED send
 * never poisons the provider's retry of the same delivery:
 *
 *   - `claim(key)` → `"claimed"` (first sight; the key is now marked) or
 *     `"duplicate"` (already claimed within the TTL). Check and mark are a
 *     single operation so callers can't forget the marking step.
 *   - `release(key)` → un-marks a claim after a downstream failure, so the
 *     provider's redelivery of the same id is admitted and re-sent.
 *
 * The claim-before-send / release-on-failure ordering trades a small
 * concurrency window (two simultaneous deliveries of the same id in
 * flight before either claims) for never suppressing a legitimate retry —
 * webhook providers serialize redeliveries, so the window is theoretical.
 *
 * Key format: `<route>:<deliveryId>:<action>` (see `dedupeKey`), where
 * `route` is the webhook route (`github` / `jira`), `deliveryId` is the
 * provider's delivery id (`githubDeliveryId` / `jiraDeliveryId`), and
 * `action` is the provider's event action (e.g. GitHub `synchronize`,
 * Jira `issue_updated`).
 */
export interface DedupeStore {
  claim(key: string): Promise<"claimed" | "duplicate">;
  release(key: string): Promise<void>;
}

export function dedupeKey(route: string, deliveryId: string, action: string): string {
  return `${route}:${deliveryId}:${action}`;
}

/**
 * GitHub delivery id = the `x-github-delivery` header (a UUID per
 * delivery; redeliveries reuse it). Falls back to a SHA-256 of the raw
 * body if the header is somehow absent — never expected from GitHub, but
 * a missing header must not collapse every delivery onto one key.
 */
export function githubDeliveryId(
  deliveryHeader: string | undefined,
  rawBody: Buffer,
): string {
  if (deliveryHeader !== undefined && deliveryHeader.length > 0) {
    return deliveryHeader;
  }
  return sha256Hex(rawBody);
}

/**
 * Jira sends no delivery-id header; use the webhook body's event id field
 * when present, else a SHA-256 of the raw body bytes.
 */
export function jiraDeliveryId(body: unknown, rawBody: Buffer): string {
  if (typeof body === "object" && body !== null && !Array.isArray(body)) {
    const id = (body as Record<string, unknown>)["id"];
    if (typeof id === "string" && id.length > 0) return id;
    if (typeof id === "number" && Number.isFinite(id)) return String(id);
  }
  return sha256Hex(rawBody);
}

export interface InMemoryTtlDedupeStoreOptions {
  /** How long a key stays marked. Default 15 minutes. */
  readonly ttlMs?: number;
  /** Clock override for tests; defaults to `Date.now`. */
  readonly now?: () => number;
}

const DEFAULT_TTL_MS = 15 * 60 * 1000;

/**
 * In-memory TTL dedupe store (Map keyed by dedupe key, lazily evicting
 * expired entries on each `seen` call).
 *
 * IMPORTANT — PRODUCTION BLOCKER (deliberate for the zero-deploy v1):
 * this only covers a WARM Lambda container. A cold start, concurrent
 * container, or redeploy gets an empty map, so provider redeliveries
 * across containers are NOT deduped. The production deploy MUST replace
 * this with a DynamoDB-backed `DedupeStore` (conditional put on the key
 * with a TTL attribute; delete on release) before ship-it goes live on
 * real webhook traffic. Recorded in ASSUMPTIONS.md §1. NOTE: there is no
 * downstream redelivery guard — the runtime shim's idempotency claim keys
 * on the SQS MessageId, and a redelivered webhook becomes a NEW SQS
 * message, so this store is the only line of defense.
 */
export class InMemoryTtlDedupeStore implements DedupeStore {
  readonly #expiryByKey = new Map<string, number>();
  readonly #ttlMs: number;
  readonly #now: () => number;

  constructor(options: InMemoryTtlDedupeStoreOptions = {}) {
    this.#ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.#now = options.now ?? Date.now;
  }

  async claim(key: string): Promise<"claimed" | "duplicate"> {
    const nowMs = this.#now();
    this.#evictExpired(nowMs);
    if (this.#expiryByKey.has(key)) {
      return "duplicate";
    }
    this.#expiryByKey.set(key, nowMs + this.#ttlMs);
    return "claimed";
  }

  async release(key: string): Promise<void> {
    this.#expiryByKey.delete(key);
  }

  // Full sweep per call: entry counts are bounded by deliveries-per-TTL
  // on a single warm container, so O(n) here is noise.
  #evictExpired(nowMs: number): void {
    for (const [key, expiresAt] of this.#expiryByKey) {
      if (expiresAt <= nowMs) {
        this.#expiryByKey.delete(key);
      }
    }
  }
}

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
