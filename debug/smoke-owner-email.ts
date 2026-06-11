/**
 * End-to-end smoke test of the AiFlow owner-mailbox email path.
 *
 * POSTs the production /api/aiflows/send-owner-email endpoint EXACTLY the way
 * the ai-flow-worker Edge Function does — bearer ROWBOAT_GATEWAY_TOKEN, NO
 * Origin header — so it also verifies the proxy's CSRF exemption for this
 * route (a missing exemption 403s every worker send with
 * "CSRF validation failed" while a browser-shaped test still passes).
 *
 * Sends a REAL email from the owner's Nango-connected mailbox (Google /
 * Microsoft Graph) to the given address.
 *
 * Usage:
 *   tsx debug/smoke-owner-email.ts [toEmail] [businessId] [connectionId]
 *
 * Defaults: the operator's inbox, Amy's business, Amy's amy@amylaidlaw.com
 * Microsoft connection.
 */
import { loadEnv } from "./_shared.ts";

loadEnv();

const TO = process.argv[2] ?? "brianlane2@gmail.com";
const BUSINESS_ID = process.argv[3] ?? "621a5b0d-c2ad-449f-9d74-9d50e7b27fa3";
const CONNECTION_ID = process.argv[4] ?? "9ddd5344-14f2-46df-a89d-dddc2d50e944";

const baseUrl = process.env.NEXT_PUBLIC_APP_URL?.trim();
const token = process.env.ROWBOAT_GATEWAY_TOKEN?.trim();
if (!baseUrl || !token) {
  console.error("NEXT_PUBLIC_APP_URL and ROWBOAT_GATEWAY_TOKEN must be set in .env");
  process.exit(1);
}

const res = await fetch(`${baseUrl}/api/aiflows/send-owner-email`, {
  method: "POST",
  // Deliberately no Origin header — mirrors the Edge Function's fetch.
  headers: {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json"
  },
  body: JSON.stringify({
    businessId: BUSINESS_ID,
    connectionId: CONNECTION_ID,
    toEmail: TO,
    subject: "NewCoworker smoke test — owner mailbox send",
    bodyText:
      "This is a working smoke test of the AiFlow owner-mailbox email path " +
      "(send_email.fromConnectionId / quiet-hours email fallback)."
  })
});

const body = await res.text();
console.log(`status=${res.status}`);
console.log(body);
process.exit(res.ok ? 0 : 1);
