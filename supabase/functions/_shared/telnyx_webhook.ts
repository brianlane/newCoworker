/** Telnyx webhook Ed25519 verification for Edge (Deno). */

const TOLERANCE_SEC = 300;

function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64.trim());
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

const ED25519_SPKI_PREFIX = new Uint8Array([
  0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00
]);

async function importPublicKey(publicKeyB64: string): Promise<CryptoKey> {
  const raw = decodeBase64(publicKeyB64);
  let der: Uint8Array;
  if (raw.length === 32) {
    der = concat(ED25519_SPKI_PREFIX, raw);
  } else {
    der = raw;
  }
  return crypto.subtle.importKey("spki", der, { name: "Ed25519" }, false, ["verify"]);
}

export type TelnyxVerifyResult =
  | { ok: true }
  | { ok: false; reason: "malformed" | "crypto_mismatch" };

export async function verifyTelnyxWebhook(
  rawBody: string,
  signatureB64: string | null,
  timestampHeader: string | null,
  publicKeyB64: string
): Promise<TelnyxVerifyResult> {
  if (!signatureB64 || !timestampHeader) {
    return { ok: false, reason: "malformed" };
  }
  const ts = Number(timestampHeader);
  if (!Number.isFinite(ts)) {
    return { ok: false, reason: "malformed" };
  }
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > TOLERANCE_SEC) {
    return { ok: false, reason: "crypto_mismatch" };
  }

  let key: CryptoKey;
  try {
    key = await importPublicKey(publicKeyB64);
  } catch {
    return { ok: false, reason: "malformed" };
  }

  let sig: Uint8Array;
  try {
    sig = decodeBase64(signatureB64);
  } catch {
    return { ok: false, reason: "malformed" };
  }

  const msg = new TextEncoder().encode(`${timestampHeader}|${rawBody}`);
  let valid: boolean;
  try {
    valid = await crypto.subtle.verify({ name: "Ed25519" }, key, sig, msg);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!valid) {
    return { ok: false, reason: "crypto_mismatch" };
  }
  return { ok: true };
}

export function header(req: Request, name: string): string | null {
  const lower = name.toLowerCase();
  for (const [k, v] of req.headers.entries()) {
    if (k.toLowerCase() === lower) return v;
  }
  return null;
}
