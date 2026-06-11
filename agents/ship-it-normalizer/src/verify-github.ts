import { createHmac, timingSafeEqual } from "node:crypto";

/** Header GitHub sends with every webhook delivery (lowercased by Lambda). */
export const GITHUB_SIGNATURE_HEADER = "x-hub-signature-256";

const SIGNATURE_PREFIX = "sha256=";
const HEX_DIGEST_PATTERN = /^[0-9a-f]{64}$/i;

/**
 * Verify GitHub's `X-Hub-Signature-256: sha256=<hex>` header: HMAC-SHA256
 * over the EXACT raw request bytes with the shared webhook secret.
 *
 * Missing or malformed headers are rejected outright. The hex digests are
 * length-checked, then compared with `crypto.timingSafeEqual` so the
 * comparison does not leak how many leading bytes matched.
 */
export function verifyGitHubSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  secret: string,
): boolean {
  if (signatureHeader === undefined || !signatureHeader.startsWith(SIGNATURE_PREFIX)) {
    return false;
  }
  const providedHex = signatureHeader.slice(SIGNATURE_PREFIX.length);
  if (!HEX_DIGEST_PATTERN.test(providedHex)) {
    return false;
  }
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  const provided = Buffer.from(providedHex, "hex");
  if (expected.length !== provided.length) {
    return false;
  }
  return timingSafeEqual(expected, provided);
}
