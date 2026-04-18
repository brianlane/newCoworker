import { createHmac, timingSafeEqual, randomBytes } from "node:crypto";

export type StreamUrlPayloadV1 = {
  v: 1;
  call_control_id: string;
  business_id: string;
  to_e164: string;
  exp: number;
  nonce: string;
};

function b64url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function signStreamUrlPayload(payload: StreamUrlPayloadV1, secret: string): string {
  const canonical = JSON.stringify({
    v: payload.v,
    call_control_id: payload.call_control_id,
    business_id: payload.business_id,
    to_e164: payload.to_e164,
    exp: payload.exp,
    nonce: payload.nonce
  });
  const mac = createHmac("sha256", secret).update(canonical).digest();
  return b64url(mac);
}

export function verifyStreamUrlPayload(
  payload: StreamUrlPayloadV1,
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
