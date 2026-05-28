import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import type { Runtime } from "@leanish/agent-runtime";

import type { AtcRequest, AtcRequestAttachment, AtcRequestTurn } from "./request-schema.js";

/**
 * Materialised attachment as the skill input expects it: same metadata as
 * the request, with `path` set to the local file the runtime fetched.
 */
export interface MaterializedAttachment {
  readonly name: string;
  readonly mediaType: string;
  readonly sizeBytes: number;
  readonly path: string;
}

export interface MaterializedTurn {
  readonly role: AtcRequestTurn["role"];
  readonly text: string;
  readonly attachments?: ReadonlyArray<MaterializedAttachment>;
}

export interface MaterializeResult {
  readonly attachments?: ReadonlyArray<MaterializedAttachment>;
  readonly transcript?: ReadonlyArray<MaterializedTurn>;
  readonly cleanup: () => Promise<void>;
}

/**
 * Materialise every unique `blobUri` to local disk via `runtime.clients.s3`.
 * Deduplicated by `blobUri` — the same file referenced from multiple turns
 * is fetched once and shared.
 *
 * Returns a parallel structure (current-turn + transcript) with `path`
 * filled in, plus a `cleanup()` the handler must call after `runSkill`
 * returns or throws.
 */
export async function materializeAttachments(
  request: AtcRequest,
  runtime: Runtime,
  envelopeRequestId: string,
): Promise<MaterializeResult> {
  const allRefs = collectRefs(request);
  if (allRefs.length === 0) {
    return { cleanup: noopCleanup };
  }

  const baseDir = join(workspaceTmpDir(), `atc-${envelopeRequestId}-${Date.now()}`);
  await mkdir(baseDir, { recursive: true });

  const pathByUri = new Map<string, string>();
  try {
    for (const ref of dedupe(allRefs)) {
      const { bucket, key } = parseS3Uri(ref.blobUri);
      const result = await runtime.clients.s3!.getObject({ bucket, key });
      const fileName = `${hashUri(ref.blobUri)}-${safeBasename(ref.name)}`;
      const path = join(baseDir, fileName);
      await writeFile(path, result.body);
      pathByUri.set(ref.blobUri, path);
    }
  } catch (err) {
    await cleanupDir(baseDir).catch(() => undefined);
    throw err;
  }

  const cleanup = (): Promise<void> => cleanupDir(baseDir);

  const currentAttachments = request.attachments?.map((att) =>
    withPath(att, pathByUri.get(att.blobUri)!),
  );
  const transcript = request.transcript?.map((turn) => ({
    role: turn.role,
    text: turn.text,
    ...(turn.attachments !== undefined
      ? {
          attachments: turn.attachments.map((att) =>
            withPath(att, pathByUri.get(att.blobUri)!),
          ),
        }
      : {}),
  } satisfies MaterializedTurn));

  const result: MaterializeResult = {
    cleanup,
    ...(currentAttachments !== undefined ? { attachments: currentAttachments } : {}),
    ...(transcript !== undefined ? { transcript } : {}),
  };
  return result;
}

function withPath(att: AtcRequestAttachment, path: string): MaterializedAttachment {
  return {
    name: att.name,
    mediaType: att.mediaType,
    sizeBytes: att.sizeBytes,
    path,
  };
}

function collectRefs(request: AtcRequest): ReadonlyArray<AtcRequestAttachment> {
  const out: AtcRequestAttachment[] = [];
  for (const att of request.attachments ?? []) out.push(att);
  for (const turn of request.transcript ?? []) {
    for (const att of turn.attachments ?? []) out.push(att);
  }
  return out;
}

function dedupe(refs: ReadonlyArray<AtcRequestAttachment>): ReadonlyArray<AtcRequestAttachment> {
  const seen = new Map<string, AtcRequestAttachment>();
  for (const ref of refs) {
    if (!seen.has(ref.blobUri)) seen.set(ref.blobUri, ref);
  }
  return [...seen.values()];
}

function parseS3Uri(uri: string): { bucket: string; key: string } {
  if (!uri.startsWith("s3://")) {
    throw new Error(`attachment blobUri must be an s3:// URI, got '${uri}'`);
  }
  const rest = uri.slice("s3://".length);
  const slash = rest.indexOf("/");
  if (slash === -1) {
    throw new Error(`attachment blobUri missing key portion: '${uri}'`);
  }
  return { bucket: rest.slice(0, slash), key: rest.slice(slash + 1) };
}

function hashUri(uri: string): string {
  return createHash("sha256").update(uri).digest("hex").slice(0, 12);
}

function safeBasename(name: string): string {
  return basename(name).replace(/[^A-Za-z0-9._-]/g, "_");
}

function workspaceTmpDir(): string {
  // `os.tmpdir()` resolves to `/tmp` on Lambda (the writable mount) and to
  // the platform's natural temp dir elsewhere (`/var/folders/...` on macOS,
  // `%TEMP%` on Windows), so the default works in every environment. The
  // env override exists for ops scenarios (mounted EFS, scratch directory
  // on a different volume, etc.) where the operator wants explicit control.
  return process.env["ATC_TMP_DIR"] ?? tmpdir();
}

async function cleanupDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

async function noopCleanup(): Promise<void> {
  /* no attachments → nothing to clean up */
}
