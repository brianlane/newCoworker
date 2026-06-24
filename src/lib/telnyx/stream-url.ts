import { createHmac, timingSafeEqual, randomBytes } from "node:crypto";

export type StreamUrlPayloadV1 = {
  v: 1;
  call_control_id: string;
  business_id: string;
  to_e164: string;
  exp: number;
  nonce: string;
};

/**
 * v2 adds the caller number (`from_e164`) to the signed canonical so the bridge
 * can trust it for staff detection and customer-memory recognition. See
 * issue #268 and supabase/functions/_shared/stream_url.ts for the rationale.
 */
export type StreamUrlPayloadV2 = {
  v: 2;
  call_control_id: string;
  business_id: string;
  to_e164: string;
  /** Caller E.164, or "" when Telnyx gave no caller id. Always signed in v2. */
  from_e164: string;
  exp: number;
  nonce: string;
};

export type StreamUrlPayload = StreamUrlPayloadV1 | StreamUrlPayloadV2;

function b64url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// Key order is the security contract — keep it byte-identical with the Deno
// signer and the bridge verifier. from_e164 sits between to_e164 and exp in v2.
function canonicalJson(payload: StreamUrlPayload): string {
  if (payload.v === 2) {
    return JSON.stringify({
      v: payload.v,
      call_control_id: payload.call_control_id,
      business_id: payload.business_id,
      to_e164: payload.to_e164,
      from_e164: payload.from_e164,
      exp: payload.exp,
      nonce: payload.nonce
    });
  }
  return JSON.stringify({
    v: payload.v,
    call_control_id: payload.call_control_id,
    business_id: payload.business_id,
    to_e164: payload.to_e164,
    exp: payload.exp,
    nonce: payload.nonce
  });
}

export function signStreamUrlPayload(payload: StreamUrlPayload, secret: string): string {
  const mac = createHmac("sha256", secret).update(canonicalJson(payload)).digest();
  return b64url(mac);
}

export function verifyStreamUrlPayload(
  payload: StreamUrlPayload,
  macB64url: string,
  secret: string
): boolean {
  const expected = signStreamUrlPayload(payload, secret);
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(macB64url, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function newStreamNonce(): string {
  return randomBytes(24).toString("hex");
}
