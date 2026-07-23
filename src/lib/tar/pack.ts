/**
 * Minimal ustar (POSIX tar) packer — dependency-free.
 *
 * Why hand-rolled: the vault sync ships the knowledge-graph projection
 * (dozens of small markdown notes + graph.jsonl) to each tenant box over
 * ONE SSH command. Base64-ing each file into its own shell line (the
 * existing vault-file pattern) doesn't scale past a handful of files, and
 * pulling in a tar dependency for ~80 lines of stable, 40-year-old format
 * isn't worth the supply-chain surface. The box side is just
 * `base64 -d | tar -x -C <dir>`.
 *
 * Scope: regular files only, paths ≤ 100 bytes (enforced), UTF-8 contents.
 * That is exactly the projection's shape — entity note names are capped
 * well below the limit upstream.
 */

const BLOCK = 512;

function octal(value: number, length: number): string {
  return `${value.toString(8).padStart(length - 1, "0")}\0`;
}

/** Serialize one ustar header block for a regular file. */
function header(path: string, size: number): Buffer {
  const buf = Buffer.alloc(BLOCK);
  const nameBytes = Buffer.byteLength(path, "utf8");
  if (nameBytes === 0 || nameBytes > 100) {
    throw new Error(`tar path must be 1-100 bytes, got ${nameBytes}: ${path}`);
  }
  buf.write(path, 0, "utf8"); // name
  buf.write(octal(0o644, 8), 100); // mode
  buf.write(octal(0, 8), 108); // uid
  buf.write(octal(0, 8), 116); // gid
  buf.write(octal(size, 12), 124); // size
  buf.write(octal(0, 12), 136); // mtime (epoch — deterministic output)
  buf.write("        ", 148); // checksum placeholder (8 spaces)
  buf.write("0", 156); // typeflag: regular file
  buf.write("ustar\0", 257); // magic
  buf.write("00", 263); // version
  let checksum = 0;
  for (const byte of buf) checksum += byte;
  buf.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148);
  return buf;
}

export type TarFile = { path: string; content: string };

/** Pack files into a ustar archive (two trailing zero blocks included). */
export function packTar(files: TarFile[]): Buffer {
  const parts: Buffer[] = [];
  for (const file of files) {
    const body = Buffer.from(file.content, "utf8");
    parts.push(header(file.path, body.length));
    parts.push(body);
    const remainder = body.length % BLOCK;
    if (remainder !== 0) parts.push(Buffer.alloc(BLOCK - remainder));
  }
  parts.push(Buffer.alloc(BLOCK * 2)); // end-of-archive marker
  return Buffer.concat(parts);
}
