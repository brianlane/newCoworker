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
 */

import { createPrivateKey, createPublicKey, generateKeyPair as nodeGenKeyPair } from "node:crypto";
import { promisify } from "node:util";

const generateKeyPair = promisify(nodeGenKeyPair);

export type SshKeypair = {
  /** OpenSSH-format public key: `ssh-ed25519 AAAA… <comment>` (newline-terminated). */
  publicKey: string;
  /** PEM-encoded PKCS#8 private key (OpenSSL-compatible). */
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

  const privateKeyPem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();

  // node:crypto doesn't ship an OpenSSH formatter, but ed25519 has a trivial
  // wire format (`"ssh-ed25519" + 32-byte key`). Decode the DER/JWK to grab
  // the raw 32-byte public part, then wrap per RFC 4253 §6.6.
  const jwk = publicKey.export({ format: "jwk" }) as { crv?: string; x?: string };
  /* c8 ignore next 3 -- defensive guard against node:crypto regressions */
  if (jwk.crv !== "Ed25519" || typeof jwk.x !== "string") {
    throw new Error("Unexpected JWK shape from ed25519 keyGen");
  }
  const rawPub = base64UrlToBuffer(jwk.x);
  /* c8 ignore next 3 -- ed25519 public is always 32 bytes per RFC 8032 */
  if (rawPub.length !== 32) {
    throw new Error(`ed25519 public key must be 32 bytes, got ${rawPub.length}`);
  }

  const sshBlob = encodeSshEd25519PublicBlob(rawPub);
  const safeComment = sanitizeComment(comment);
  const publicKeyLine = `ssh-ed25519 ${sshBlob.toString("base64")} ${safeComment}\n`;

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
 * Validate that a PEM-encoded private key is loadable by node:crypto AND its
 * public half matches the given OpenSSH public-key line. Used by the SSH
 * executor to catch storage corruption before opening a connection.
 */
export function verifyKeypairRoundTrip(
  publicKeyLine: string,
  privateKeyPem: string
): boolean {
  try {
    const derived = createPublicKey(createPrivateKey(privateKeyPem));
    const jwk = derived.export({ format: "jwk" }) as { x?: string };
    /* c8 ignore next -- defensive; node:crypto always populates jwk.x for valid ed25519 */
    if (typeof jwk.x !== "string") return false;
    const raw = base64UrlToBuffer(jwk.x);
    const expected = encodeSshEd25519PublicBlob(raw).toString("base64");
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
