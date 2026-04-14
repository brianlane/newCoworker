/** HMAC-SHA256 stream URL MAC (v1), same canonical JSON as `src/lib/telnyx/stream-url.ts`. */

export type StreamPayloadV1 = {
  v: 1;
  call_control_id: string;
  business_id: string;
  to_e164: string;
  exp: number;
  nonce: string;
};

function canonicalJson(p: StreamPayloadV1): string {
  return JSON.stringify({
    v: p.v,
    call_control_id: p.call_control_id,
    business_id: p.business_id,
    to_e164: p.to_e164,
    exp: p.exp,
    nonce: p.nonce
  });
}

function b64url(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]!);
  const b64 = btoa(bin);
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function signStreamUrlMac(payload: StreamPayloadV1, secret: string): Promise<string> {
  const keyData = new TextEncoder().encode(secret);
  const key = await crypto.subtle.importKey(
    "raw",
    keyData,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(canonicalJson(payload)));
  return b64url(sig);
}
