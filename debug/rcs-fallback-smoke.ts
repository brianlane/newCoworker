/**
 * One-shot: prove the RCS→SMS fallback in sendTelnyxSms.
 *
 * Sends through the REAL helper with the HQ tenant's resolved config
 * (RCS-first). A non-tester recipient must make Telnyx reject the RCS leg
 * and the helper must re-send as plain SMS (result.channel === "sms").
 * Metered against HQ like any customer-facing send.
 *
 * Usage: tsx debug/rcs-fallback-smoke.ts [phone] ["message"]
 */
import { loadEnv } from "./_shared.ts";

loadEnv();

const BUSINESS_ID = "8f3a5c21-7e94-4b6a-9d02-c4e8b1f6a37d";
const PHONE = process.argv[2] ?? "+16029226392";
const MESSAGE =
  process.argv[3] ?? "RCS fallback smoke: non-tester recipient, should arrive as plain SMS.";

async function main(): Promise<void> {
  const { getTelnyxMessagingForBusiness, sendTelnyxSms } = await import(
    "../src/lib/telnyx/messaging.ts"
  );
  const config = await getTelnyxMessagingForBusiness(BUSINESS_ID, undefined, { resolveRcs: true });
  console.log(`resolved rcsAgentId=${config.rcsAgentId ?? "(none)"} from=${config.fromE164}`);
  const result = await sendTelnyxSms(config, PHONE, MESSAGE, {
    meterBusinessId: BUSINESS_ID,
    idempotencyKey: crypto.randomUUID()
  });
  console.log(`sent id=${result.id} channel=${result.channel}`);
}

main().catch((e) => {
  console.error("smoke failed:", e?.message ?? e);
  process.exit(1);
});
