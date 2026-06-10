import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  EVIDENCE_LIMITS,
  extractEvidenceArchive,
  InvalidEvidenceArchiveError,
} from "../src/evidence.js";

import { makeTarGz } from "./helpers/tar-fixture.js";

/**
 * Every test pins `TRIAGE_IT_TMP_DIR` to a fresh directory so we can assert
 * the extractor's cleanup behaviour precisely: a rejected archive must
 * leave nothing behind, and `cleanup()` must remove the whole temp tree.
 */
let tmpBase: string;
let savedTmpDirEnv: string | undefined;

beforeEach(async () => {
  savedTmpDirEnv = process.env["TRIAGE_IT_TMP_DIR"];
  tmpBase = await mkdtemp(join(tmpdir(), "triage-it-evidence-test-"));
  process.env["TRIAGE_IT_TMP_DIR"] = tmpBase;
});

afterEach(async () => {
  if (savedTmpDirEnv === undefined) {
    delete process.env["TRIAGE_IT_TMP_DIR"];
  } else {
    process.env["TRIAGE_IT_TMP_DIR"] = savedTmpDirEnv;
  }
  await rm(tmpBase, { recursive: true, force: true });
});

const GOOD_ENTRIES = [
  { path: "manifest.md", content: "# evidence manifest\n" },
  { path: "config/", type: "5" as const },
  { path: "config/settings.json", content: '{"feature":{"enabled":false}}' },
  { path: "stats/summary.json", content: '{"impressions":0}' },
];

describe("extractEvidenceArchive", () => {
  it("extracts a valid archive and cleanup removes the whole temp tree", async () => {
    const { evidenceDir, cleanup } = await extractEvidenceArchive({
      archive: makeTarGz(GOOD_ENTRIES),
    });

    expect((await stat(join(evidenceDir, "manifest.md"))).isFile()).toBe(true);
    expect(await readFile(join(evidenceDir, "config", "settings.json"), "utf8")).toBe(
      '{"feature":{"enabled":false}}',
    );
    expect(await readFile(join(evidenceDir, "stats", "summary.json"), "utf8")).toBe(
      '{"impressions":0}',
    );

    await cleanup();
    // cleanup removes the base temp dir (evidenceDir's parent), archive included.
    expect(await readdir(tmpBase)).toEqual([]);
  });

  it("accepts a manifest entry with a leading './'", async () => {
    const { evidenceDir, cleanup } = await extractEvidenceArchive({
      archive: makeTarGz([{ path: "./manifest.md", content: "# manifest" }]),
    });
    expect((await stat(join(evidenceDir, "manifest.md"))).isFile()).toBe(true);
    await cleanup();
  });

  it("rejects a '..' traversal entry and leaves no temp files behind", async () => {
    await expect(
      extractEvidenceArchive({
        archive: makeTarGz([
          ...GOOD_ENTRIES,
          { path: "../escape.txt", content: "pwned" },
        ]),
      }),
    ).rejects.toThrow(/invalid evidence archive: .*'\.\.' path segment/);
    expect(await readdir(tmpBase)).toEqual([]);
  });

  it("rejects a nested '..' traversal entry", async () => {
    await expect(
      extractEvidenceArchive({
        archive: makeTarGz([
          ...GOOD_ENTRIES,
          { path: "config/../../escape.txt", content: "pwned" },
        ]),
      }),
    ).rejects.toThrow(InvalidEvidenceArchiveError);
  });

  it("rejects an absolute-path entry", async () => {
    await expect(
      extractEvidenceArchive({
        archive: makeTarGz([...GOOD_ENTRIES, { path: "/etc/cron.d/evil", content: "x" }]),
      }),
    ).rejects.toThrow(/absolute path/);
  });

  it("rejects a symlink entry", async () => {
    await expect(
      extractEvidenceArchive({
        archive: makeTarGz([
          ...GOOD_ENTRIES,
          { path: "link-out", type: "2", linkpath: "/etc/passwd" },
        ]),
      }),
    ).rejects.toThrow(/unsupported type 'SymbolicLink'/);
  });

  it("rejects a hardlink entry", async () => {
    await expect(
      extractEvidenceArchive({
        archive: makeTarGz([
          ...GOOD_ENTRIES,
          { path: "hard-link", type: "1", linkpath: "manifest.md" },
        ]),
      }),
    ).rejects.toThrow(/unsupported type/);
  });

  it("rejects an archive over the compressed-size cap before parsing", async () => {
    const archive = makeTarGz(GOOD_ENTRIES);
    await expect(
      extractEvidenceArchive({
        archive,
        limits: { ...EVIDENCE_LIMITS, maxArchiveBytes: archive.byteLength - 1 },
      }),
    ).rejects.toThrow(/archive is \d+ bytes; max/);
    expect(await readdir(tmpBase)).toEqual([]);
  });

  it("rejects a file entry over the per-file cap", async () => {
    await expect(
      extractEvidenceArchive({
        archive: makeTarGz([
          { path: "manifest.md", content: "# manifest" },
          { path: "big.json", content: "x".repeat(64) },
        ]),
        limits: { ...EVIDENCE_LIMITS, maxEntryBytes: 63 },
      }),
    ).rejects.toThrow(/max per file is 63/);
  });

  it("rejects an archive over the entry-count cap", async () => {
    await expect(
      extractEvidenceArchive({
        archive: makeTarGz([
          { path: "manifest.md", content: "# manifest" },
          { path: "a.json", content: "{}" },
          { path: "b.json", content: "{}" },
          { path: "c.json", content: "{}" },
        ]),
        limits: { ...EVIDENCE_LIMITS, maxEntryCount: 3 },
      }),
    ).rejects.toThrow(/more than 3 entries/);
  });

  it("rejects an archive without manifest.md at the root", async () => {
    await expect(
      extractEvidenceArchive({
        archive: makeTarGz([{ path: "config/settings.json", content: "{}" }]),
      }),
    ).rejects.toThrow(/invalid evidence archive: manifest\.md missing/);
    expect(await readdir(tmpBase)).toEqual([]);
  });

  it("a nested manifest.md does not satisfy the root-manifest requirement", async () => {
    await expect(
      extractEvidenceArchive({
        archive: makeTarGz([{ path: "docs/manifest.md", content: "# nested" }]),
      }),
    ).rejects.toThrow(/manifest\.md missing/);
  });

  it("rejects bytes that are not a gzip archive", async () => {
    await expect(
      extractEvidenceArchive({ archive: Buffer.from("definitely not a tarball") }),
    ).rejects.toThrow(/not a gzip archive/);
    expect(await readdir(tmpBase)).toEqual([]);
  });

  it("rejects a corrupt gzip body", async () => {
    const good = makeTarGz(GOOD_ENTRIES);
    const corrupt = Buffer.concat([
      good.subarray(0, 16),
      Buffer.from("corruption-in-the-middle"),
      good.subarray(48),
    ]);
    await expect(extractEvidenceArchive({ archive: corrupt })).rejects.toThrow(
      /archive could not be read/,
    );
    expect(await readdir(tmpBase)).toEqual([]);
  });

  it("ships the documented default caps", () => {
    expect(EVIDENCE_LIMITS).toEqual({
      maxArchiveBytes: 64 * 1024 * 1024,
      maxEntryCount: 2000,
      maxEntryBytes: 8 * 1024 * 1024,
    });
  });
});
