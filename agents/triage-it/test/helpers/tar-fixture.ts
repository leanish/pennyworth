import { gzipSync } from "node:zlib";

/**
 * Hand-crafted tar.gz fixtures for the safe-extraction tests. Building the
 * ustar headers byte-by-byte (rather than via the `tar` package's create
 * API) lets tests express entries a well-behaved archiver refuses to
 * produce: absolute paths, `..` traversal, symlinks, hardlinks.
 */
export interface TarFixtureEntry {
  readonly path: string;
  /**
   * ustar typeflag: `"0"` regular file (default), `"1"` hardlink,
   * `"2"` symlink, `"5"` directory.
   */
  readonly type?: "0" | "1" | "2" | "5";
  readonly content?: string;
  /** Target for link entries (typeflag 1 / 2). */
  readonly linkpath?: string;
}

export function makeTarGz(entries: ReadonlyArray<TarFixtureEntry>): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    const content = Buffer.from(entry.content ?? "", "utf8");
    parts.push(ustarHeader(entry.path, content.length, entry.type ?? "0", entry.linkpath ?? ""));
    if (content.length > 0) {
      const padded = Buffer.alloc(Math.ceil(content.length / 512) * 512);
      content.copy(padded);
      parts.push(padded);
    }
  }
  // End-of-archive marker: two zero-filled 512-byte blocks.
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts));
}

function ustarHeader(
  path: string,
  size: number,
  typeflag: string,
  linkpath: string,
): Buffer {
  const buf = Buffer.alloc(512);
  buf.write(path, 0, 100, "utf8");
  buf.write("0000644\0", 100, 8); // mode
  buf.write("0000000\0", 108, 8); // uid
  buf.write("0000000\0", 116, 8); // gid
  buf.write(size.toString(8).padStart(11, "0") + "\0", 124, 12);
  buf.write("00000000000\0", 136, 12); // mtime
  buf.write("        ", 148, 8); // checksum placeholder (spaces while summing)
  buf.write(typeflag, 156, 1);
  buf.write(linkpath, 157, 100);
  buf.write("ustar\0", 257, 6);
  buf.write("00", 263, 2);
  let sum = 0;
  for (const byte of buf) sum += byte;
  buf.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8);
  return buf;
}
