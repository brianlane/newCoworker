/**
 * Mint (or read) a business's webchat widget key and enable the widget with
 * the newcoworker.com origins/theme — the script that re-keyed the site
 * webchat onto the HQ tenant when the Residency Pilot backing box retired.
 *
 * Prints the ncw_pub_ site key (public by design — it ships in page HTML).
 * The Vercel env flip (NEXT_PUBLIC_WEBCHAT_SITE_KEY, via
 * debug/vercel-env-set.ts + debug/vercel-redeploy.ts) is a separate step —
 * do it only after the target box is verified (debug/box-verify.ts).
 *
 * Defaults to the New Coworker (HQ, internal) tenant.
 * Dry-run by default (prints current settings); --apply writes.
 *
 * Usage: tsx debug/webchat-rekey.ts [businessId] [--apply]
 */
import { loadEnv } from "./_shared.ts";

loadEnv();

const HQ_BUSINESS_ID = "8f3a5c21-7e94-4b6a-9d02-c4e8b1f6a37d";
const APPLY = process.argv.includes("--apply");
const businessId = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? HQ_BUSINESS_ID;

const { getOrCreateWidgetSettings, updateWidgetSettings, getWidgetSettingsForBusiness } =
  await import("../src/lib/webchat/db.ts");

const existing = await getWidgetSettingsForBusiness(businessId);
console.log("existing widget settings:", existing && {
  enabled: existing.enabled,
  origins: existing.allowed_origins,
  engine: existing.reply_engine,
  key: existing.public_key
});

if (!APPLY) {
  console.log("dry-run: pass --apply to mint/enable the widget");
  process.exit(0);
}

await getOrCreateWidgetSettings(businessId);
const updated = await updateWidgetSettings(businessId, {
  enabled: true,
  allowed_origins: ["https://newcoworker.com", "https://www.newcoworker.com"],
  require_contact_form: false,
  reply_engine: "vps",
  theme: {
    greeting:
      "Hi! I’m the New Coworker assistant. Ask me anything about what an AI coworker can do for your business.",
    accentColor: "#1BD96A",
    agentDisplayName: "New Coworker assistant"
  }
});
console.log("widget ready:", {
  enabled: updated.enabled,
  origins: updated.allowed_origins,
  engine: updated.reply_engine
});
console.log("SITE KEY (set as NEXT_PUBLIC_WEBCHAT_SITE_KEY on Vercel):", updated.public_key);
