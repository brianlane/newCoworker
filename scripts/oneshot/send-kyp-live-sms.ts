/**
 * send-kyp-live-sms.ts — one-shot: deliver the "your Coworker is live" SMS
 * that KYP Ads' signup (Jul 14 2026) never got. The original send failed on
 * the released platform sender number; the fixed behavior (tenant's own DID
 * → owner's phone) is what this replays: +14388035806 → +15145188192.
 *
 * Usage: npx tsx scripts/oneshot/send-kyp-live-sms.ts --apply
 */
import { loadEnv } from "../../debug/_shared.ts";

loadEnv();

const BUSINESS_ID = "056034a7-e84c-444d-8d15-747eeb1fa899";
const OWNER_PHONE = "+15145188192";

const { getTelnyxMessagingForBusiness, sendTelnyxSms } = await import(
  "../../src/lib/telnyx/messaging.ts"
);

const cfg = await getTelnyxMessagingForBusiness(BUSINESS_ID);
console.log("[oneshot] resolved sender:", cfg.fromE164, "profile:", cfg.messagingProfileId);
if (cfg.fromE164 !== "+14388035806") {
  console.error("[oneshot] refusing: expected KYP's own DID as the sender");
  process.exit(1);
}

if (!process.argv.includes("--apply")) {
  console.log("[oneshot] dry run complete. Re-run with --apply to send.");
  process.exit(0);
}

const res = await sendTelnyxSms(
  cfg,
  OWNER_PHONE,
  "Your New Coworker is live! Dashboard: https://www.newcoworker.com/dashboard"
);
console.log("[oneshot] sent:", res);
