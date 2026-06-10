import type { FunctionUrlEvent } from "./http.js";

/**
 * Extract the EXACT raw request bytes from a Function URL event.
 *
 * Signature verification MUST run on these bytes BEFORE any `JSON.parse`:
 * GitHub's `X-Hub-Signature-256` is an HMAC over the wire bytes, and any
 * re-serialisation (parse → stringify) silently changes whitespace/key
 * order and breaks verification.
 */
export function rawRequestBody(event: FunctionUrlEvent): Buffer {
  const body = event.body ?? "";
  return Buffer.from(body, event.isBase64Encoded ? "base64" : "utf8");
}
