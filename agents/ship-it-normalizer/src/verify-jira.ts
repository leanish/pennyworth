import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Header the Jira webhook is configured to send (lowercased by Lambda).
 * v1 trust seam: a static shared secret. Jira Connect-style JWT
 * verification is the recorded follow-up (see ASSUMPTIONS.md §3).
 */
export const JIRA_SECRET_HEADER = "x-leanish-webhook-secret";

/**
 * Timing-safe comparison of the static shared-secret header. Both sides
 * are hashed with SHA-256 first so the buffers always have equal length —
 * `crypto.timingSafeEqual` throws on length mismatch, and a plain
 * length check would leak the secret's length.
 */
export function verifyJiraSecret(
  providedSecret: string | undefined,
  expectedSecret: string,
): boolean {
  if (providedSecret === undefined) {
    return false;
  }
  const providedDigest = createHash("sha256").update(providedSecret).digest();
  const expectedDigest = createHash("sha256").update(expectedSecret).digest();
  return timingSafeEqual(providedDigest, expectedDigest);
}
