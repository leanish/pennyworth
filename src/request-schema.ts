import type { ExecutionOverride } from "@leanish/agent-runtime";

/**
 * ATC consumer-request shape — the inner `payload` of the signed envelope.
 * Per `../../../specs/agentic-development/agent-atc/specs/queue-api.md` §kind: "ask".
 *
 * Validated by `parseAtcRequest` at the handler boundary (not by the runtime
 * — there are no per-stage payload schemas in v1 per ADR-0012).
 */
export interface AtcRequest {
  readonly question: string;
  readonly transcript?: ReadonlyArray<AtcTranscriptTurn>;
  readonly projectIds?: ReadonlyArray<string>;
  readonly includeAll?: boolean;
  readonly audience?: "general" | "codebase";
  readonly execution?: ExecutionOverride;
  readonly noSync?: boolean;
  readonly scopeOnly?: boolean;
  readonly attachments?: ReadonlyArray<AtcAttachment>;
}

export interface AtcTranscriptTurn {
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly attachments?: ReadonlyArray<AtcAttachment>;
}

export interface AtcAttachment {
  readonly name: string;
  readonly mediaType: string;
  readonly sizeBytes: number;
  readonly blobUri: string;
}

// Legacy type aliases — the internal call sites referenced these names
// (`AtcRequestTurn`, `AtcRequestAttachment`). Kept as aliases so the
// rename is a no-op for in-tree callers; remove in a follow-up if you
// want only the canonical names exported.
export type AtcRequestTurn = AtcTranscriptTurn;
export type AtcRequestAttachment = AtcAttachment;

/**
 * Constants pulled out of the spec so they live in one place.
 */
export const ATC_LIMITS = {
  questionBytes: 8 * 1024,
  transcriptSerializedBytes: 128 * 1024,
  uniqueAttachmentsMax: 200,
  perAttachmentBytes: 100 * 1024 * 1024,
  totalAttachmentBytes: 200 * 1024 * 1024,
} as const;

export class AtcValidationError extends Error {
  readonly kind = "validation-error" as const;
  constructor(message: string) {
    super(message);
    this.name = "AtcValidationError";
  }
}

/**
 * Validate the consumer-request shape + enforce the documented limits.
 * Throws `AtcValidationError` (mapped by the handler to terminal-reply
 * `error.kind: "validation-error"` per queue-api.md).
 */
export function parseAtcRequest(raw: unknown): AtcRequest {
  if (!isObject(raw)) throw new AtcValidationError("payload.request must be an object");
  const r = raw as Record<string, unknown>;

  const question = requireString(r, "question");
  if (Buffer.byteLength(question, "utf8") > ATC_LIMITS.questionBytes) {
    throw new AtcValidationError(`question exceeds ${ATC_LIMITS.questionBytes / 1024} KB`);
  }

  const transcript = optionalArray(r, "transcript", parseTurn);
  if (transcript !== undefined) {
    const serializedBytes = Buffer.byteLength(JSON.stringify(transcript), "utf8");
    if (serializedBytes > ATC_LIMITS.transcriptSerializedBytes) {
      throw new AtcValidationError(
        `transcript exceeds ${ATC_LIMITS.transcriptSerializedBytes / 1024} KB serialized`,
      );
    }
  }

  const projectIds = optionalStringArray(r, "projectIds");
  const includeAll = optionalBoolean(r, "includeAll");
  const audience = optionalEnum(r, "audience", ["general", "codebase"] as const);
  const noSync = optionalBoolean(r, "noSync");
  const scopeOnly = optionalBoolean(r, "scopeOnly");
  const execution = optionalExecution(r["execution"]);
  const attachments = optionalArray(r, "attachments", parseAttachment);

  validateAttachmentLimits(attachments, transcript);

  return {
    question,
    ...(transcript !== undefined ? { transcript } : {}),
    ...(projectIds !== undefined ? { projectIds } : {}),
    ...(includeAll !== undefined ? { includeAll } : {}),
    ...(audience !== undefined ? { audience } : {}),
    ...(execution !== undefined ? { execution } : {}),
    ...(noSync !== undefined ? { noSync } : {}),
    ...(scopeOnly !== undefined ? { scopeOnly } : {}),
    ...(attachments !== undefined ? { attachments } : {}),
  };
}

function parseTurn(raw: unknown, path: string): AtcRequestTurn {
  if (!isObject(raw)) throw new AtcValidationError(`${path} must be an object`);
  const r = raw as Record<string, unknown>;
  const role = r["role"];
  if (role !== "user" && role !== "assistant") {
    throw new AtcValidationError(`${path}.role must be 'user' or 'assistant'`);
  }
  const text = r["text"];
  if (typeof text !== "string") {
    throw new AtcValidationError(`${path}.text must be a string`);
  }
  const attachments = optionalArray(r, "attachments", parseAttachment);
  return {
    role,
    text,
    ...(attachments !== undefined ? { attachments } : {}),
  };
}

function parseAttachment(raw: unknown, path: string): AtcRequestAttachment {
  if (!isObject(raw)) throw new AtcValidationError(`${path} must be an object`);
  const r = raw as Record<string, unknown>;
  return {
    name: requireString(r, "name", path),
    mediaType: requireString(r, "mediaType", path),
    sizeBytes: requireNumber(r, "sizeBytes", path),
    blobUri: requireString(r, "blobUri", path),
  };
}

function validateAttachmentLimits(
  current: ReadonlyArray<AtcRequestAttachment> | undefined,
  transcript: ReadonlyArray<AtcRequestTurn> | undefined,
): void {
  const all: AtcRequestAttachment[] = [];
  for (const att of current ?? []) all.push(att);
  for (const turn of transcript ?? []) {
    for (const att of turn.attachments ?? []) all.push(att);
  }
  const unique = new Map<string, AtcRequestAttachment>();
  for (const att of all) {
    if (!unique.has(att.blobUri)) unique.set(att.blobUri, att);
  }
  if (unique.size > ATC_LIMITS.uniqueAttachmentsMax) {
    throw new AtcValidationError(
      `attachments exceed ${ATC_LIMITS.uniqueAttachmentsMax} unique files`,
    );
  }
  let total = 0;
  for (const att of unique.values()) {
    if (att.sizeBytes > ATC_LIMITS.perAttachmentBytes) {
      throw new AtcValidationError(
        `attachment ${att.name} exceeds ${ATC_LIMITS.perAttachmentBytes / (1024 * 1024)} MB`,
      );
    }
    total += att.sizeBytes;
  }
  if (total > ATC_LIMITS.totalAttachmentBytes) {
    throw new AtcValidationError(
      `total attachment size exceeds ${ATC_LIMITS.totalAttachmentBytes / (1024 * 1024)} MB`,
    );
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(r: Record<string, unknown>, field: string, prefix = ""): string {
  const raw = r[field];
  const path = prefix.length > 0 ? `${prefix}.${field}` : field;
  if (typeof raw !== "string") throw new AtcValidationError(`${path} must be a string`);
  return raw;
}

function requireNumber(r: Record<string, unknown>, field: string, prefix = ""): number {
  const raw = r[field];
  const path = prefix.length > 0 ? `${prefix}.${field}` : field;
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    throw new AtcValidationError(`${path} must be a number`);
  }
  return raw;
}

function optionalBoolean(r: Record<string, unknown>, field: string): boolean | undefined {
  const raw = r[field];
  if (raw === undefined) return undefined;
  if (typeof raw !== "boolean") throw new AtcValidationError(`${field} must be a boolean when present`);
  return raw;
}

function optionalStringArray(r: Record<string, unknown>, field: string): ReadonlyArray<string> | undefined {
  const raw = r[field];
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || !raw.every((v) => typeof v === "string")) {
    throw new AtcValidationError(`${field} must be an array of strings when present`);
  }
  return raw as ReadonlyArray<string>;
}

function optionalEnum<T extends string>(
  r: Record<string, unknown>,
  field: string,
  allowed: ReadonlyArray<T>,
): T | undefined {
  const raw = r[field];
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || !(allowed as readonly string[]).includes(raw)) {
    throw new AtcValidationError(`${field} must be one of [${allowed.join(", ")}]`);
  }
  return raw as T;
}

function optionalArray<T>(
  r: Record<string, unknown>,
  field: string,
  parseItem: (raw: unknown, path: string) => T,
): ReadonlyArray<T> | undefined {
  const raw = r[field];
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) throw new AtcValidationError(`${field} must be an array when present`);
  return raw.map((item, i) => parseItem(item, `${field}[${i}]`));
}

function optionalExecution(raw: unknown): ExecutionOverride | undefined {
  if (raw === undefined) return undefined;
  if (!isObject(raw)) throw new AtcValidationError("execution must be an object when present");
  const r = raw as Record<string, unknown>;
  let codingAgent: string | undefined;
  let model: string | undefined;
  let effort: NonNullable<ExecutionOverride["effort"]> | undefined;
  if (r["codingAgent"] !== undefined) {
    if (typeof r["codingAgent"] !== "string") {
      throw new AtcValidationError("execution.codingAgent must be a string");
    }
    codingAgent = r["codingAgent"];
  }
  if (r["model"] !== undefined) {
    if (typeof r["model"] !== "string") {
      throw new AtcValidationError("execution.model must be a string");
    }
    model = r["model"];
  }
  if (r["effort"] !== undefined) {
    if (typeof r["effort"] !== "string") {
      throw new AtcValidationError("execution.effort must be a string");
    }
    const e = r["effort"];
    if (!["minimal", "low", "medium", "high", "xhigh"].includes(e)) {
      throw new AtcValidationError(
        `execution.effort must be one of [minimal, low, medium, high, xhigh]`,
      );
    }
    effort = e as NonNullable<ExecutionOverride["effort"]>;
  }
  return {
    ...(codingAgent !== undefined ? { codingAgent } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(effort !== undefined ? { effort } : {}),
  };
}
