/**
 * Recursive sorted-keys JSON serialisation. The spec recommends consumers
 * canonicalise their envelope's `payload` before signing so the byte
 * representation is stable; the verifier applies the same canonicalisation
 * to the parsed value before recomputing the HMAC.
 *
 * Rules:
 *   - Objects → keys emitted in lexicographic order.
 *   - Arrays → preserved in order.
 *   - Primitives → `JSON.stringify` of the value (handles escaping).
 *   - `undefined` → dropped (matches `JSON.stringify` for object props).
 */
export function canonicalize(value: unknown): string {
  return encode(value);
}

function encode(value: unknown): string {
  if (value === undefined) return "null"; // safety; should not appear at top level
  if (value === null) return "null";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "null";
    return JSON.stringify(value);
  }
  if (typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(encode).join(",") + "]";
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return (
      "{" +
      entries
        .map(([k, v]) => JSON.stringify(k) + ":" + encode(v))
        .join(",") +
      "}"
    );
  }
  return "null";
}
