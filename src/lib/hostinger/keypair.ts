/**
 * Ed25519 SSH keypair generation.
 *
 * Each VPS gets its own keypair so a single compromised private key never
 * widens the blast radius beyond one tenant. The public half is uploaded to
 * Hostinger and attached at setup time; the private half is persisted
 * encrypted-at-rest in `vps_ssh_keys` (see `../db/vps-ssh-keys.ts`).
 *
 * Why Ed25519 over RSA:
 *   - Smaller, faster, no weak parameter knobs (RSA ≥ 2048 requires vigilance)
 *   - Both OpenSSH and Hostinger's public-keys API accept the standard
 *     `ssh-ed25519 <base64> [comment]` format directly
 *
 * Why OpenSSH-format PEM (not PKCS#8) for the private half:
 *   The `ssh2` library that backs `sshExec` rejects unencrypted PKCS#8
 *   ed25519 PEMs with `Cannot parse privateKey: Unsupported key format`
 *   (verified against ssh2 1.17.0). PKCS#8 round-trips cleanly through
 *   `node:crypto` and OpenSSL CLI, but ssh2 only accepts ed25519 in the
 *   OpenSSH "openssh-key-v1" framing. We hand-build that framing here per
 *   the spec at https://github.com/openssh/openssh-portable/blob/master/PROTOCOL.key
 *   so the keys we mint are usable by every consumer (ssh2 client,
 *   `ssh -i`, `ssh-keygen -y`, hPanel "Add SSH key" → re-attach, etc.).
 */

import { createPrivateKey, createPublicKey, generateKeyPair as nodeGenKeyPair, randomBytes } from "node:crypto";
import { promisify } from "node:util";

const generateKeyPair = promisify(nodeGenKeyPair);

export type SshKeypair = {
  /** OpenSSH-format public key: `ssh-ed25519 AAAA… <comment>` (newline-terminated). */
  publicKey: string;
  /** OpenSSH-format ("openssh-key-v1") private key PEM. Loadable by ssh2, OpenSSH CLI, and `crypto.createPrivateKey`. */
  privateKeyPem: string;
  /** SHA-256 fingerprint of the public key (for display / auditing). */
  fingerprintSha256: string;
};

/**
 * Generate a fresh ed25519 keypair. `comment` is appended to the public-key
 * line so operators can identify which VPS a key belongs to later (e.g.
 * `newcoworker-vps-a505...`).
 */
export async function generateSshKeypair(comment: string): Promise<SshKeypair> {
  const { publicKey, privateKey } = await generateKeyPair("ed25519");

  // Pull the raw 32-byte public + private halves out of the JWK form. ed25519
  // public keys are always 32 bytes (`x`); the private scalar is also 32
  // bytes (`d`). We need both for the OpenSSH-format private key.
  const jwkPub = publicKey.export({ format: "jwk" }) as { crv?: string; x?: string };
  const jwkPriv = privateKey.export({ format: "jwk" }) as { crv?: string; d?: string };
  /* c8 ignore start -- defensive guards against a hypothetical node:crypto
     regression: ed25519 keyGen is contractually shape-stable per RFC 8032 +
     RFC 8037, so neither branch is reachable from unmodified Node. We keep
     the throws so the failure mode would be loud rather than silently
     emitting a broken OpenSSH PEM downstream. */
  if (jwkPub.crv !== "Ed25519" || typeof jwkPub.x !== "string") {
    throw new Error("Unexpected JWK shape from ed25519 keyGen (public)");
  }
  if (jwkPriv.crv !== "Ed25519" || typeof jwkPriv.d !== "string") {
    throw new Error("Unexpected JWK shape from ed25519 keyGen (private)");
  }
  /* c8 ignore stop */
  const rawPub = base64UrlToBuffer(jwkPub.x);
  const rawPriv = base64UrlToBuffer(jwkPriv.d);
  /* c8 ignore start -- ed25519 halves are always 32 bytes per RFC 8032 */
  if (rawPub.length !== 32 || rawPriv.length !== 32) {
    throw new Error(
      `ed25519 keypair must be 32B/32B; got pub=${rawPub.length}B priv=${rawPriv.length}B`
    );
  }
  /* c8 ignore stop */

  const sshBlob = encodeSshEd25519PublicBlob(rawPub);
  const safeComment = sanitizeComment(comment);
  const publicKeyLine = `ssh-ed25519 ${sshBlob.toString("base64")} ${safeComment}\n`;

  const privateKeyPem = encodeOpensshEd25519PrivateKey(rawPriv, rawPub, safeComment);

  const fingerprintSha256 = await sha256Fingerprint(sshBlob);

  return {
    publicKey: publicKeyLine,
    privateKeyPem,
    fingerprintSha256
  };
}

/**
 * Derive a SHA-256 fingerprint for an OpenSSH public key line.
 * Exposed so the admin endpoint + CLI can show the same fingerprint the user
 * would see from `ssh-keygen -lf`.
 */
export async function fingerprintOpenSshPublicKey(publicKeyLine: string): Promise<string> {
  const parts = publicKeyLine.trim().split(/\s+/);
  if (parts.length < 2 || parts[0] !== "ssh-ed25519") {
    throw new Error("fingerprintOpenSshPublicKey only supports ssh-ed25519");
  }
  const blob = Buffer.from(parts[1], "base64");
  return sha256Fingerprint(blob);
}

/**
 * Convert an unencrypted PKCS#8 PEM ed25519 private key into the
 * OpenSSH-format ("openssh-key-v1") PEM that ssh2 + OpenSSH CLI accept.
 *
 * Used to migrate `vps_ssh_keys` rows persisted before
 * {@link generateSshKeypair} switched its PEM emission to OpenSSH format.
 * The keypair material is unchanged — only the wire encoding — so the
 * matching public key on the VPS's `~/.ssh/authorized_keys` continues to
 * authenticate the converted private half without any VPS-side change.
 */
export function convertPkcs8Ed25519PemToOpenssh(pkcs8Pem: string, comment = "newcoworker"): string {
  if (pkcs8Pem.includes("BEGIN OPENSSH PRIVATE KEY")) {
    /* Already in the target format. Idempotent so callers can retry safely. */
    return pkcs8Pem;
  }
  const ko = createPrivateKey(pkcs8Pem);
  const jwkPriv = ko.export({ format: "jwk" }) as { crv?: string; d?: string; x?: string };
  if (jwkPriv.crv !== "Ed25519" || typeof jwkPriv.d !== "string" || typeof jwkPriv.x !== "string") {
    throw new Error(`convertPkcs8Ed25519PemToOpenssh: input is not an ed25519 PKCS#8 PEM`);
  }
  const rawPriv = base64UrlToBuffer(jwkPriv.d);
  const rawPub = base64UrlToBuffer(jwkPriv.x);
  /* c8 ignore next 5 -- defensive guard: node:crypto's PKCS#8 ed25519 PEM
     export is contractually 32B/32B per RFC 8032. Hitting this branch
     would mean node:crypto regressed; we keep the throw so the failure
     mode is loud rather than a malformed OpenSSH PEM downstream. */
  if (rawPriv.length !== 32 || rawPub.length !== 32) {
    throw new Error(
      `ed25519 keypair must be 32B/32B; got pub=${rawPub.length}B priv=${rawPriv.length}B`
    );
  }
  return encodeOpensshEd25519PrivateKey(rawPriv, rawPub, sanitizeComment(comment));
}

/**
 * Validate that a PEM-encoded private key is loadable by node:crypto AND its
 * public half matches the given OpenSSH public-key line. Used by the SSH
 * executor to catch storage corruption before opening a connection.
 *
 * Accepts both OpenSSH-format ("openssh-key-v1") and PKCS#8 PEMs — the
 * latter still rounds-trips through node:crypto even though ssh2 can't
 * read it directly. This makes the function usable for verifying
 * historical rows that predate the OpenSSH-format export switch.
 */
export function verifyKeypairRoundTrip(
  publicKeyLine: string,
  privateKeyPem: string
): boolean {
  try {
    // ssh2's openssh-key-v1 PEMs aren't loadable by node:crypto directly;
    // detect that case first and re-derive from the embedded raw priv32.
    let rawPub: Buffer;
    if (privateKeyPem.includes("BEGIN OPENSSH PRIVATE KEY")) {
      const { rawPub: derivedPub } = parseOpensshEd25519PrivateKey(privateKeyPem);
      rawPub = derivedPub;
    } else {
      // Derive the public key straight from the private PEM. createPublicKey
      // accepts a private key and returns its public half; passing the PEM
      // (rather than a KeyObject) keeps the call typed across @types/node
      // majors, where the KeyObject overload was dropped.
      const derived = createPublicKey({ key: privateKeyPem, format: "pem" });
      const jwk = derived.export({ format: "jwk" }) as { x?: string };
      /* c8 ignore next -- defensive; node:crypto always populates jwk.x for valid ed25519 */
      if (typeof jwk.x !== "string") return false;
      rawPub = base64UrlToBuffer(jwk.x);
    }
    const expected = encodeSshEd25519PublicBlob(rawPub).toString("base64");
    const parts = publicKeyLine.trim().split(/\s+/);
    return parts.length >= 2 && parts[0] === "ssh-ed25519" && parts[1] === expected;
  } catch {
    return false;
  }
}

// -------- internal --------

function encodeSshEd25519PublicBlob(rawPub: Buffer): Buffer {
  // `string "ssh-ed25519" | string <32-byte key>` per RFC 4253 §6.6.
  const algo = Buffer.from("ssh-ed25519", "utf8");
  const out = Buffer.alloc(4 + algo.length + 4 + rawPub.length);
  out.writeUInt32BE(algo.length, 0);
  algo.copy(out, 4);
  out.writeUInt32BE(rawPub.length, 4 + algo.length);
  rawPub.copy(out, 4 + algo.length + 4);
  return out;
}

/**
 * Build an unencrypted OpenSSH-format ed25519 private key per
 * https://github.com/openssh/openssh-portable/blob/master/PROTOCOL.key
 *
 * Layout (no encryption, no KDF):
 *   "openssh-key-v1\0"
 *   string ciphername  = "none"
 *   string kdfname     = "none"
 *   string kdfoptions  = ""
 *   uint32 numkeys     = 1
 *   string pubkey0     = (string "ssh-ed25519" | string <pub32>)
 *   string privblob    = padded to multiple of cipher block size (8 for "none"):
 *     uint32 checkint
 *     uint32 checkint    (same value; pseudo-MAC for the unencrypted case)
 *     string algo        = "ssh-ed25519"
 *     string pub32
 *     string priv64      = priv32 || pub32  (per RFC 8032 internal layout)
 *     string comment
 *     pad bytes 1,2,3,...
 */
function encodeOpensshEd25519PrivateKey(rawPriv32: Buffer, rawPub32: Buffer, comment: string): string {
  const algo = Buffer.from("ssh-ed25519", "utf8");
  const pubblob = Buffer.concat([encodeString(algo), encodeString(rawPub32)]);

  // checkint pair: same 4 bytes twice, used by ssh-keygen as a sanity guard
  // when decrypting. With cipher=none we still emit it so clients (ssh2,
  // OpenSSH) parse the inner blob correctly.
  const checkint = randomBytes(4);
  const fullPriv = Buffer.concat([rawPriv32, rawPub32]); // RFC 8032 SK = priv || pub

  let inner = Buffer.concat([
    checkint,
    checkint,
    encodeString(algo),
    encodeString(rawPub32),
    encodeString(fullPriv),
    encodeString(Buffer.from(comment, "utf8"))
  ]);

  // Pad to a multiple of the (cipher) block size. For cipher=none,
  // OpenSSH uses block size 8. Pad bytes count up from 1 (1, 2, 3, ...).
  // The padNeeded === 0 branch fires for comments with length ≡ 5 (mod 8)
  // — see the dedicated test in tests/hostinger-keypair.test.ts which
  // exercises both halves of this conditional.
  const blockSize = 8;
  const padNeeded = (blockSize - (inner.length % blockSize)) % blockSize;
  if (padNeeded > 0) {
    const pad = Buffer.alloc(padNeeded);
    for (let i = 0; i < padNeeded; i += 1) pad[i] = i + 1;
    inner = Buffer.concat([inner, pad]);
  }

  const magic = Buffer.from("openssh-key-v1\0", "binary");
  const numkeys = Buffer.alloc(4);
  numkeys.writeUInt32BE(1, 0);

  const body = Buffer.concat([
    magic,
    encodeString(Buffer.from("none", "utf8")), // ciphername
    encodeString(Buffer.from("none", "utf8")), // kdfname
    encodeString(Buffer.alloc(0)), // kdfoptions (empty for cipher=none)
    numkeys,
    encodeString(pubblob),
    encodeString(inner)
  ]);

  // Wrap in PEM at 70-char rows (matches ssh-keygen output). The body is
  // guaranteed non-empty here — even an empty comment yields a 131-byte
  // inner blob — so `.match(/.{1,70}/g)` always returns at least one
  // chunk. The `?? b64` fallback is purely a TypeScript narrowing aid
  // for the `RegExpMatchArray | null` return type.
  const b64 = body.toString("base64");
  /* c8 ignore next -- match() never returns null for non-empty strings; fallback exists for type narrowing only */
  const wrapped = b64.match(/.{1,70}/g)?.join("\n") ?? b64;
  return `-----BEGIN OPENSSH PRIVATE KEY-----\n${wrapped}\n-----END OPENSSH PRIVATE KEY-----\n`;
}

/**
 * Parse an unencrypted OpenSSH-format ed25519 private key and return its
 * 32-byte public half. Used by {@link verifyKeypairRoundTrip} for keys
 * stored in the new format that node:crypto can't load directly.
 */
function parseOpensshEd25519PrivateKey(pem: string): { rawPub: Buffer } {
  const inner = pem
    .replace(/-----BEGIN OPENSSH PRIVATE KEY-----/, "")
    .replace(/-----END OPENSSH PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  const buf = Buffer.from(inner, "base64");
  const magic = "openssh-key-v1\0";
  if (buf.slice(0, magic.length).toString("binary") !== magic) {
    throw new Error("Not an openssh-key-v1 PEM");
  }
  let off = magic.length;
  const readString = (): Buffer => {
    const len = buf.readUInt32BE(off);
    off += 4;
    const out = buf.slice(off, off + len);
    off += len;
    return out;
  };
  const ciphername = readString().toString("utf8");
  if (ciphername !== "none") {
    throw new Error(`Encrypted OpenSSH key not supported (cipher=${ciphername})`);
  }
  readString(); // kdfname
  readString(); // kdfoptions
  const numkeys = buf.readUInt32BE(off);
  off += 4;
  /* c8 ignore next -- defensive: openssh-key-v1 always frames a single
     ed25519 keypair when emitted by `generateSshKeypair`, and our only
     external input source (`convertPkcs8Ed25519PemToOpenssh`) re-emits
     using the same single-key encoder. Hitting this branch would
     require a hand-crafted PEM that wraps multiple keys in one frame,
     which is not a shape any of our callers produce. */
  if (numkeys !== 1) throw new Error(`Expected numkeys=1, got ${numkeys}`);
  // Public-key blob: (uint32 algo-len | "ssh-ed25519" | uint32 32 | pub32)
  const pubblob = readString();
  let pbOff = 0;
  const algoLen = pubblob.readUInt32BE(pbOff);
  pbOff += 4;
  pbOff += algoLen; // skip "ssh-ed25519"
  const pubLen = pubblob.readUInt32BE(pbOff);
  pbOff += 4;
  const rawPub = pubblob.slice(pbOff, pbOff + pubLen);
  return { rawPub };
}

function encodeString(buf: Buffer): Buffer {
  const out = Buffer.alloc(4 + buf.length);
  out.writeUInt32BE(buf.length, 0);
  buf.copy(out, 4);
  return out;
}

function base64UrlToBuffer(s: string): Buffer {
  /* c8 ignore next -- ed25519 jwk.x is always 43 chars (len%4===3), only one branch is hot */
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

async function sha256Fingerprint(blob: Buffer): Promise<string> {
  const crypto = await import("node:crypto");
  const hash = crypto.createHash("sha256").update(blob).digest("base64");
  // Trim trailing '=' — matches OpenSSH's `SHA256:…` output.
  return `SHA256:${hash.replace(/=+$/, "")}`;
}

function sanitizeComment(comment: string): string {
  // Keep the comment single-line; strip anything that could break the
  // `ssh-ed25519 <base64> <comment>` authorized_keys grammar.
  return comment.replace(/[\r\n\t]+/g, " ").replace(/[^\x20-\x7e]/g, "").trim() || "newcoworker";
}
