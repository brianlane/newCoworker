/** HMAC-SHA256 stream URL MAC, same canonical JSON as `src/lib/telnyx/stream-url.ts`. */

export type StreamPayloadV1 = {
  v: 1;
  call_control_id: string;
  business_id: string;
  to_e164: string;
  exp: number;
  nonce: string;
};

/**
 * v2 adds the caller number (`from_e164`) to the signed canonical so the bridge
 * can trust it for staff detection and customer-memory recognition. v1 left
 * `from_e164_info` unsigned (informational only), which meant a party holding a
 * live stream URL could tamper with it to get the staff persona or surface
 * another contact's memory (see issue #268).
 */
export type StreamPayloadV2 = {
  v: 2;
  call_control_id: string;
  business_id: string;
  to_e164: string;
  /** Caller E.164, or "" when Telnyx gave no caller id. Always signed in v2. */
  from_e164: string;
  exp: number;
  nonce: string;
};

export type StreamPayload = StreamPayloadV1 | StreamPayloadV2;

// Key order here is the security contract: it MUST match byte-for-byte across
// the Deno signer, the Node signer (src/lib/telnyx/stream-url.ts), and the
// bridge verifier (vps/voice-bridge/src/index.ts). from_e164 sits between
// to_e164 and exp in v2.
function canonicalJson(p: StreamPayload): string {
  if (p.v === 2) {
    return JSON.stringify({
      v: p.v,
      call_control_id: p.call_control_id,
      business_id: p.business_id,
      to_e164: p.to_e164,
      from_e164: p.from_e164,
      exp: p.exp,
      nonce: p.nonce
    });
  }
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

export async function signStreamUrlMac(payload: StreamPayload, secret: string): Promise<string> {
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
