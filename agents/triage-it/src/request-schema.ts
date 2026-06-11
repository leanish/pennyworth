/**
 * triage-it consumer-request shape — the inner `payload` of the signed
 * envelope. Produced by the evidence-collector pipeline (a separate
 * component): the collector gathers a customer-scoped, PII-filtered
 * evidence archive, uploads it to S3, and enqueues this request carrying
 * the archive's `evidenceBlobUri` plus the ticket key.
 *
 * Validated by `parseTriageRequest` at the handler boundary (the runtime
 * has no per-stage payload schemas in v1).
 */
export interface TriageRequest {
  /** Ticket identifier the diagnosis is for (e.g. "SUP-1234"). Correlation only — the agent does not call the ticket system in v1. */
  readonly ticketKey: string;
  /** Customer identifier the evidence was scoped to. */
  readonly customer: string;
  /** `s3://bucket/key` URI of the evidence archive (tar.gz) the collector uploaded. */
  readonly evidenceBlobUri: string;
  /** Optional free-form problem statement (ticket summary, alert text, …). */
  readonly problem?: string;
  /** Optional explicit code scope. Absent → evidence-only triage (no working copies). */
  readonly projectIds?: ReadonlyArray<string>;
}

export class TriageValidationError extends Error {
  readonly kind = "validation-error" as const;
  constructor(message: string) {
    super(message);
    this.name = "TriageValidationError";
  }
}

/**
 * Validate the consumer-request shape. Throws `TriageValidationError`
 * (mapped by the handler to a terminal reply with
 * `error.kind: "validation-error"`).
 */
export function parseTriageRequest(raw: unknown): TriageRequest {
  if (!isObject(raw)) throw new TriageValidationError("payload.request must be an object");
  const r = raw;

  const ticketKey = requireNonEmptyString(r, "ticketKey");
  const customer = requireNonEmptyString(r, "customer");
  const evidenceBlobUri = requireNonEmptyString(r, "evidenceBlobUri");
  parseS3Uri(evidenceBlobUri); // shape check at the boundary; throws on a malformed URI
  const problem = optionalString(r, "problem");
  const projectIds = optionalStringArray(r, "projectIds");

  return {
    ticketKey,
    customer,
    evidenceBlobUri,
    ...(problem !== undefined ? { problem } : {}),
    ...(projectIds !== undefined ? { projectIds } : {}),
  };
}

/**
 * Split an `s3://bucket/key` URI into its parts. Throws
 * `TriageValidationError` on anything else — the evidence archive is only
 * ever addressed by S3 URI.
 */
export function parseS3Uri(uri: string): { bucket: string; key: string } {
  if (!uri.startsWith("s3://")) {
    throw new TriageValidationError(`evidenceBlobUri must be an s3:// URI, got '${uri}'`);
  }
  const rest = uri.slice("s3://".length);
  const slash = rest.indexOf("/");
  if (slash <= 0 || slash === rest.length - 1) {
    throw new TriageValidationError(
      `evidenceBlobUri must be 's3://<bucket>/<key>', got '${uri}'`,
    );
  }
  return { bucket: rest.slice(0, slash), key: rest.slice(slash + 1) };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireNonEmptyString(r: Record<string, unknown>, field: string): string {
  const raw = r[field];
  if (typeof raw !== "string" || raw.length === 0) {
    throw new TriageValidationError(`${field} must be a non-empty string`);
  }
  return raw;
}

function optionalString(r: Record<string, unknown>, field: string): string | undefined {
  const raw = r[field];
  if (raw === undefined) return undefined;
  if (typeof raw !== "string") {
    throw new TriageValidationError(`${field} must be a string when present`);
  }
  return raw;
}

function optionalStringArray(
  r: Record<string, unknown>,
  field: string,
): ReadonlyArray<string> | undefined {
  const raw = r[field];
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || !raw.every((v) => typeof v === "string" && v.length > 0)) {
    throw new TriageValidationError(
      `${field} must be an array of non-empty strings when present`,
    );
  }
  return raw as ReadonlyArray<string>;
}
