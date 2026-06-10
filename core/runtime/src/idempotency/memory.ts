import type {
  ClaimAttempt,
  ClaimOutcome,
  FinalizeOutcome,
  IdempotencyRecord,
  IdempotencyStore,
  InFlightRecord,
} from "./store.js";

/**
 * In-memory `IdempotencyStore` for tests + integration-test scaffolding.
 *
 * NOT a local-mode store — local mode is exempt from runtime idempotency
 * per ADR-0006. This exists so the AWS-mode Lambda shim can be unit-tested
 * against the three-state behaviour without LocalStack.
 */
export class MemoryIdempotencyStore implements IdempotencyStore {
  readonly #records = new Map<string, IdempotencyRecord>();

  async claim(requestId: string, attempt: ClaimAttempt): Promise<ClaimOutcome> {
    const existing = this.#records.get(requestId);
    if (existing === undefined) {
      const record = this.#newClaim(attempt);
      this.#records.set(requestId, record);
      return { status: "claimed", record };
    }
    if (existing.status === "completed") {
      return { status: "duplicate-completed", record: existing };
    }
    // existing is in-flight.
    if (Date.parse(existing.claimUntil) < Date.parse(attempt.now)) {
      // Expired — reclaim.
      const record = this.#newClaim(attempt);
      this.#records.set(requestId, record);
      return { status: "claimed", record };
    }
    return { status: "duplicate-in-flight", record: existing };
  }

  async complete(
    requestId: string,
    ownedUntil: string,
    completedAt: string,
  ): Promise<FinalizeOutcome> {
    const existing = this.#records.get(requestId);
    if (
      existing === undefined ||
      existing.status !== "in-flight" ||
      existing.claimUntil !== ownedUntil
    ) {
      // Another worker reclaimed (or there's no row) — refuse to clobber.
      return { status: "stale" };
    }
    this.#records.set(requestId, {
      status: "completed",
      startedAt: existing.startedAt,
      completedAt,
      agent: existing.agent,
    });
    return { status: "ok" };
  }

  async expire(
    requestId: string,
    ownedUntil: string,
    now: string,
  ): Promise<FinalizeOutcome> {
    const existing = this.#records.get(requestId);
    if (
      existing === undefined ||
      existing.status !== "in-flight" ||
      existing.claimUntil !== ownedUntil
    ) {
      return { status: "stale" };
    }
    this.#records.set(requestId, {
      ...existing,
      claimUntil: now,
    });
    return { status: "ok" };
  }

  /** Test-only: peek at the stored shape. */
  inspect(requestId: string): IdempotencyRecord | undefined {
    return this.#records.get(requestId);
  }

  #newClaim(attempt: ClaimAttempt): InFlightRecord {
    return {
      status: "in-flight",
      startedAt: attempt.now,
      claimUntil: attempt.claimUntil,
      agent: attempt.agent,
    };
  }
}
