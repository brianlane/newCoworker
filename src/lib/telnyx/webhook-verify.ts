import { createPublicKey, verify as nodeVerify } from "node:crypto";

const TOLERANCE_SEC = 300;

/**
 * Verify Telnyx webhook Ed25519 signature over `{timestamp}|{rawBody}`.
 * @param publicKeyB64 Base64-encoded public key from Mission Control (raw32-byte or SPKI)
 */
export function verifyTelnyxWebhookSignature(
  rawBody: string,
  signatureB64: string | null,
  timestampHeader: string | null,
  publicKeyB64: string
): { ok: true } | { ok: false; reason: "malformed" | "crypto_mismatch" } {
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

  const publicKeyBuf = Buffer.from(publicKeyB64.trim(), "base64");

  let keyObject: ReturnType<typeof createPublicKey>;
  try {
    if (publicKeyBuf.length === 32) {
      const spki = Buffer.concat([
        Buffer.from("302a300506032b6570032100", "hex"),
        publicKeyBuf
      ]);
      keyObject = createPublicKey({ key: spki, format: "der", type: "spki" });
    } else {
      keyObject = createPublicKey({ key: publicKeyBuf, format: "der", type: "spki" });
    }
  } catch {
    return { ok: false, reason: "malformed" };
  }

  const sig = Buffer.from(signatureB64.trim(), "base64");
  const msg = Buffer.from(`${timestampHeader}|${rawBody}`, "utf8");
  const ok = nodeVerify(null, msg, keyObject, sig);
  if (!ok) {
    return { ok: false, reason: "crypto_mismatch" };
  }
  return { ok: true };
}
