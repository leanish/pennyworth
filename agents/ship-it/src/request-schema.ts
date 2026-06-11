/**
 * ship-it consumer-request shape — the inner `payload` of the signed
 * `ship-it-event` envelope produced by the webhook normalizer.
 *
 * The normalizer flattens the ticket event into this shape so the handler
 * never has to fetch the ticket itself in v1 (see ASSUMPTIONS.md §1).
 * Validated by `parseShipItRequest` at the handler boundary (no per-stage
 * payload schemas in the runtime, per ADR-0012).
 */
export interface ShipItRequest {
  /** Ticket key, e.g. "ABC-123". */
  readonly ticketKey: string;
  /** catalogit project id, e.g. "acme/widgets". */
  readonly projectId: string;
  /** Ticket workflow status at event time; selects the skill via statusSkillMap. */
  readonly ticketStatus: string;
  /** Ticket labels at event time; must include "ship-it" (per-ticket opt-in). */
  readonly labels: ReadonlyArray<string>;
  readonly ticketSummary: string;
  readonly ticketDescription?: string;
  readonly acceptanceCriteria?: ReadonlyArray<string>;
  /**
   * Pull-request number, present when the triggering event is PR-shaped
   * (the review-it path). Jira-driven events omit it.
   */
  readonly prNumber?: number;
  /**
   * How the normalizer admitted the event (owner-approved alternative
   * triggers). Absent = legacy label-mode message. `mention` = a ticket
   * comment mentioned @ship-it (the label may be absent); `pull-request` =
   * a GitHub PR event (PRs carry no ticket labels; repo opt-in is the gate).
   */
  readonly trigger?: ShipItTrigger;
}

export interface ShipItTrigger {
  readonly source: "jira" | "github";
  readonly mode: "label" | "mention" | "pull-request";
}

export class ShipItValidationError extends Error {
  readonly kind = "validation-error" as const;
  constructor(message: string) {
    super(message);
    this.name = "ShipItValidationError";
  }
}

/**
 * Validate the consumer-request shape. Throws `ShipItValidationError` —
 * the handler lets it propagate, so a malformed message fails loudly and
 * lands on the DLQ after SQS retries (retrying cannot fix a bad shape,
 * but the DLQ is where operators triage normalizer bugs).
 */
export function parseShipItRequest(raw: unknown): ShipItRequest {
  if (!isObject(raw)) {
    throw new ShipItValidationError("payload.request must be an object");
  }
  const ticketKey = requireNonEmptyString(raw, "ticketKey");
  const projectId = requireNonEmptyString(raw, "projectId");
  const ticketStatus = requireNonEmptyString(raw, "ticketStatus");
  const ticketSummary = requireNonEmptyString(raw, "ticketSummary");
  const labels = requireStringArray(raw, "labels");
  const ticketDescription = optionalString(raw, "ticketDescription");
  const acceptanceCriteria =
    raw["acceptanceCriteria"] === undefined
      ? undefined
      : requireStringArray(raw, "acceptanceCriteria");
  const prNumber = optionalPositiveInteger(raw, "prNumber");
  const trigger = optionalTrigger(raw);

  return {
    ticketKey,
    projectId,
    ticketStatus,
    labels,
    ticketSummary,
    ...(ticketDescription !== undefined ? { ticketDescription } : {}),
    ...(acceptanceCriteria !== undefined ? { acceptanceCriteria } : {}),
    ...(prNumber !== undefined ? { prNumber } : {}),
    ...(trigger !== undefined ? { trigger } : {}),
  };
}

const TRIGGER_SOURCES = ["jira", "github"] as const;
const TRIGGER_MODES = ["label", "mention", "pull-request"] as const;

function optionalTrigger(obj: Record<string, unknown>): ShipItTrigger | undefined {
  const v = obj["trigger"];
  if (v === undefined) return undefined;
  if (!isObject(v)) {
    throw new ShipItValidationError("request.trigger must be an object when present");
  }
  const source = v["source"];
  const mode = v["mode"];
  if (!TRIGGER_SOURCES.includes(source as never) || !TRIGGER_MODES.includes(mode as never)) {
    throw new ShipItValidationError(
      "request.trigger must be {source: jira|github, mode: label|mention|pull-request}",
    );
  }
  return { source, mode } as ShipItTrigger;
}

function optionalPositiveInteger(obj: Record<string, unknown>, field: string): number | undefined {
  const v = obj[field];
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) {
    throw new ShipItValidationError(`request.${field} must be a positive integer when present`);
  }
  return v;
}

function requireNonEmptyString(obj: Record<string, unknown>, field: string): string {
  const v = obj[field];
  if (typeof v !== "string" || v.length === 0) {
    throw new ShipItValidationError(`request.${field} must be a non-empty string`);
  }
  return v;
}

function optionalString(obj: Record<string, unknown>, field: string): string | undefined {
  const v = obj[field];
  if (v === undefined) return undefined;
  if (typeof v !== "string") {
    throw new ShipItValidationError(`request.${field} must be a string when present`);
  }
  return v;
}

function requireStringArray(obj: Record<string, unknown>, field: string): ReadonlyArray<string> {
  const v = obj[field];
  if (!Array.isArray(v) || v.some((item) => typeof item !== "string")) {
    throw new ShipItValidationError(`request.${field} must be an array of strings`);
  }
  return v as ReadonlyArray<string>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
