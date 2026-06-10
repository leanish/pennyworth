/**
 * Runtime-internal idempotency store. Backs the three-state on-receive
 * claim documented in ADR-0006. Agents never see this surface.
 *
 * Phase 1 ships the interface + an in-memory implementation usable by tests.
 * The AWS-mode DynamoDB implementation lands when the Lambda entry shim
 * is wired up; the local-mode runner is *exempt* per ADR-0006 and never
 * constructs a store at all.
 */
export type IdempotencyRecord =
  | InFlightRecord
  | CompletedRecord;

export interface InFlightRecord {
  readonly status: "in-flight";
  readonly startedAt: string; // ISO 8601
  readonly claimUntil: string; // ISO 8601
  readonly agent: string;
}

export interface CompletedRecord {
  readonly status: "completed";
  readonly startedAt: string;
  readonly completedAt: string;
  readonly agent: string;
}

export interface ClaimAttempt {
  readonly agent: string;
  readonly now: string; // ISO 8601
  readonly claimUntil: string; // ISO 8601
}

export type ClaimOutcome =
  | { readonly status: "claimed"; readonly record: InFlightRecord }
  | { readonly status: "duplicate-completed"; readonly record: CompletedRecord }
  | { readonly status: "duplicate-in-flight"; readonly record: InFlightRecord };

/**
 * Outcome of `complete()` / `expire()`. The store enforces a freshness
 * guard: a worker may only finalize the row whose `claimUntil` matches
 * the value its own `claim()` returned. If another worker has reclaimed
 * in the meantime, the call returns `stale` rather than clobbering the
 * fresh claim (which would corrupt the live-watchdog handoff documented
 * in ADR-0006).
 */
export type FinalizeOutcome =
  | { readonly status: "ok" }
  | { readonly status: "stale" };

export interface IdempotencyStore {
  /**
   * Atomically: set the record to `in-flight` iff (a) absent or (b) the
   * existing record is an expired in-flight claim. Returns the outcome
   * the runtime maps onto SQS partial-batch responses (ADR-0006).
   */
  claim(requestId: string, attempt: ClaimAttempt): Promise<ClaimOutcome>;
  /**
   * On handler success: flip `in-flight` to `completed` **only when**
   * the existing row still carries `claimUntil === ownedUntil`. The caller
   * passes the `claimUntil` value its own `claim()` produced; if the row
   * has been reclaimed since, returns `stale` and does not mutate.
   */
  complete(
    requestId: string,
    ownedUntil: string,
    completedAt: string,
  ): Promise<FinalizeOutcome>;
  /**
   * On handler caught throw: mark `claimUntil = now` so the next redelivery
   * reclaims. Guarded by the same `ownedUntil` freshness check as
   * `complete()` — a stale worker cannot collapse a fresh claim window.
   */
  expire(
    requestId: string,
    ownedUntil: string,
    now: string,
  ): Promise<FinalizeOutcome>;
}
