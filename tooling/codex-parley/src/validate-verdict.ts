import type { Verdict, VerdictStatus } from "./types.js";

const VERDICT_STATUSES: ReadonlySet<string> = new Set(["agree", "disagree", "needs-user", "error"]);

export function parseVerdict(value: unknown): Verdict {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("verdict is not an object");
  }

  const record = value as Record<string, unknown>;
  const status = readString(record, "status");
  if (!VERDICT_STATUSES.has(status)) {
    throw new Error(`verdict.status is not allowed: ${status}`);
  }

  return {
    status: status as VerdictStatus,
    summary: readNonEmptyString(record, "summary"),
    reason: readNonEmptyString(record, "reason"),
    body: readNonEmptyString(record, "body"),
  };
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") {
    throw new Error(`verdict.${key} must be a string`);
  }
  return value;
}

function readNonEmptyString(record: Record<string, unknown>, key: string): string {
  const value = readString(record, key);
  if (value.length === 0) {
    throw new Error(`verdict.${key} must not be empty`);
  }
  return value;
}
