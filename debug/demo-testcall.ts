/**
 * Synthetic inbound test call to a voice line (default: the HQ homepage demo
 * line +1 602 313 1823): originates a Telnyx call from an account-owned DID,
 * lets the AI answer, and reports the call_control_id. Hangup is handled
 * separately (hang up from the callee side, or let the demo-line session cap
 * end it).
 *
 * Caller id must be an account-owned DID. TELNYX_SMS_FROM_E164 is blank in
 * the platform env, so set TEST_CALL_FROM_E164 (any owned tenant DID works —
 * it is used purely as caller id).
 *
 * Requires TELNYX_API_KEY + TELNYX_CONNECTION_ID in the repo-root .env.
 * ⚠️ Places a real PSTN call and starts a real Gemini Live session on the
 * target tenant — keep it pointed at the HQ demo line.
 *
 * Usage: tsx debug/demo-testcall.ts [--to +1XXXXXXXXXX]
 */
import { loadEnv } from "./_shared.ts";

loadEnv();

const HQ_DEMO_LINE = "+16023131823";
const toIdx = process.argv.indexOf("--to");
const TO =
  (toIdx >= 0 ? process.argv[toIdx + 1] : process.argv.find((a) => a.startsWith("--to="))?.slice(5)) ??
  HQ_DEMO_LINE;

const FROM = process.env.TEST_CALL_FROM_E164 || "";
const CONNECTION_ID = process.env.TELNYX_CONNECTION_ID ?? "";
const API_KEY = process.env.TELNYX_API_KEY ?? "";
if (!FROM || !CONNECTION_ID || !API_KEY) {
  throw new Error("TEST_CALL_FROM_E164 / TELNYX_CONNECTION_ID / TELNYX_API_KEY required");
}

const res = await fetch("https://api.telnyx.com/v2/calls", {
  method: "POST",
  headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
  body: JSON.stringify({ connection_id: CONNECTION_ID, to: TO, from: FROM })
});
const body = (await res.json()) as { data?: { call_control_id?: string; call_session_id?: string } };
if (!res.ok) {
  console.error("originate failed", res.status, JSON.stringify(body).slice(0, 800));
  process.exit(1);
}
console.log("test call placed", {
  from: FROM,
  to: TO,
  call_control_id: body.data?.call_control_id,
  call_session_id: body.data?.call_session_id,
  placed_at: new Date().toISOString()
});
