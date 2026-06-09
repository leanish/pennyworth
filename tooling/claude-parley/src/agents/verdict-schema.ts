import type { Verdict, VerdictStatus } from "../types.js";

const STATUSES: readonly VerdictStatus[] = ["continue", "done", "needs-user", "error"];

/**
 * The JSON Schema every turn's verdict must conform to. Both CLIs enforce it natively — Codex via
 * `--output-schema <file>`, Claude via `--json-schema <contents>` — so there is no prose parsing.
 */
export const VERDICT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["status", "summary", "reason", "body"],
  properties: {
    status: {
      type: "string",
      enum: [...STATUSES],
      description:
        "Whether the deliberation should keep going: 'continue' = you have something material to add, correct, or do; 'done' = nothing material remains from your side; 'needs-user' = a human decision is required to proceed; 'error' = you could not complete this turn.",
    },
    summary: { type: "string", description: "one-line summary of this turn" },
    reason: { type: "string", description: "one-line reason for the status" },
    body: { type: "string", description: "your full answer / critique / report prose" },
  },
} as const;

export const VERDICT_SCHEMA_JSON = JSON.stringify(VERDICT_SCHEMA);

/** Find the last balanced `{...}` object in text (best-effort; used as a fallback to fenced blocks). */
function lastBalancedObject(text: string): string | undefined {
  const end = text.lastIndexOf("}");
  if (end === -1) {
    return undefined;
  }
  let depth = 0;
  for (let i = end; i >= 0; i -= 1) {
    const ch = text[i];
    if (ch === "}") {
      depth += 1;
    } else if (ch === "{") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(i, end + 1);
      }
    }
  }
  return undefined;
}

/**
 * Recover a verdict from prose output. Needed because Claude drops native `structured_output` on a
 * `--resume` turn that uses tools (edits) — the build prompt asks the builder to emit the verdict as
 * a fenced ```json block, and this parses it. Prefers fenced blocks, falls back to the last balanced
 * object, and returns the last candidate that validates.
 */
export function extractVerdictFromText(text: string): Verdict {
  const candidates: string[] = [];
  const fence = /```(?:json)?\s*([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = fence.exec(text)) !== null) {
    if (match[1] !== undefined) {
      candidates.push(match[1].trim());
    }
  }
  const balanced = lastBalancedObject(text);
  if (balanced !== undefined) {
    candidates.push(balanced);
  }
  let found: Verdict | undefined;
  for (const candidate of candidates) {
    try {
      found = parseVerdict(JSON.parse(candidate));
    } catch {
      // not a valid verdict — try the next candidate
    }
  }
  if (found === undefined) {
    throw new Error("no parseable JSON verdict found in output");
  }
  return found;
}

/** Validate a parsed structured-output value into a {@link Verdict}, throwing on any mismatch. */
export function parseVerdict(value: unknown): Verdict {
  if (typeof value !== "object" || value === null) {
    throw new Error("verdict is not an object");
  }
  const v = value as Record<string, unknown>;
  if (typeof v.status !== "string" || !STATUSES.includes(v.status as VerdictStatus)) {
    throw new Error(`verdict.status invalid: ${String(v.status)}`);
  }
  const field = (key: "summary" | "reason" | "body"): string => {
    const raw = v[key];
    if (typeof raw !== "string") {
      throw new Error(`verdict.${key} must be a string`);
    }
    return raw;
  };
  return {
    status: v.status as VerdictStatus,
    summary: field("summary"),
    reason: field("reason"),
    body: field("body"),
  };
}
