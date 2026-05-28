import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Conflict-detection state for the `pull` / `publish` round-trip.
 *
 * `pull` records the bundle's S3 ETag here; `publish` reads it back and
 * sends it as `If-Match` so a concurrent remote edit is rejected (412)
 * instead of silently clobbered. Single source of truth for the file
 * name + on-disk shape, shared by `cli.ts` (publish read/write) and
 * `pull.ts` (write).
 */
const STATE_FILENAME = ".catalogit-state.json";

/**
 * Result of reading the state file. The three outcomes are distinct so the
 * CLI can give the operator an honest message — the previous inlined code
 * reported "no state file" for all three, which lied on two of them.
 */
export type PublishStateRead =
  | { readonly kind: "ok"; readonly etag: string }
  | { readonly kind: "missing" }
  | { readonly kind: "malformed"; readonly reason: string };

export async function readPublishState(catalogRoot: string): Promise<PublishStateRead> {
  let raw: string;
  try {
    raw = await readFile(join(catalogRoot, STATE_FILENAME), "utf8");
  } catch (err) {
    // Only a genuinely-absent file is "missing"; anything else (permissions,
    // a directory in its place, I/O error) is present-but-unusable — reporting
    // it as missing would send the operator to `pull`, which won't help.
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { kind: "missing" };
    return { kind: "malformed", reason: code ?? (err instanceof Error ? err.message : "read error") };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "malformed", reason: "not valid JSON" };
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as Record<string, unknown>)["etag"] !== "string"
  ) {
    return { kind: "malformed", reason: "missing string `etag` field" };
  }
  return { kind: "ok", etag: (parsed as { etag: string }).etag };
}

export async function writePublishState(catalogRoot: string, etag: string): Promise<void> {
  await writeFile(join(catalogRoot, STATE_FILENAME), JSON.stringify({ etag }) + "\n", "utf8");
}
