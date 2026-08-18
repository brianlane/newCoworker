/**
 * configure-hq-prospecting.ts, make HQ tenant zero for Prospecting.
 *
 * Prospecting ships off for everyone. This switches it on for our own tenant
 * first, which is the point of dogfooding: New Coworker's outbound outreach
 * runs through New Coworker, and whatever is wrong with it is wrong for us
 * before it is wrong for a customer.
 *
 * What --apply does:
 *
 *   1. Installs the "Prospect outreach follow-through" starter flow if HQ does
 *      not already have it, DISABLED, exactly as the other starters install.
 *      Enabling it is a separate, deliberate click, because it is what files
 *      and tags the people we email.
 *   2. Writes HQ's outreach_settings: targeting (the trades we sell to, across
 *      the Phoenix metro), the offer line, the postal address READ FROM THE
 *      BUSINESS PROFILE (it refuses to apply without one), the sender, a
 *      12-a-day cap, and a weekday 8 to 11 window.
 *   3. Leaves the MODE at manual. Read the first digests, then flip to auto
 *      from Dashboard, Marketing when the drafts read like something you would
 *      have sent yourself.
 *
 * The mode is deliberately not set to auto here. A one-shot that starts cold
 * emailing on the next 5-minute tick, from our own domain, is not a change
 * anybody should be able to make without seeing a draft first.
 *
 * Idempotent: the flow is installed once (matched by name), and an existing
 * mode is left alone in both directions. Off is a deliberate decision to stop,
 * so a re-run must not quietly restart outreach.
 *
 * Usage:
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/configure-hq-prospecting.ts          # dry-run
 *   npx tsx scripts/oneshot/configure-hq-prospecting.ts --apply  # write
 */
import { loadEnv } from "../../debug/_shared.ts";

loadEnv();

const APPLY = process.argv.includes("--apply");
const HQ_BUSINESS_ID = "8f3a5c21-7e94-4b6a-9d02-c4e8b1f6a37d";

/**
 * Who we sell to. Each term is crossed with each city, so this list times the
 * city list is the query space; the rotation buys six of them a day.
 */
const SEARCH_TERMS = [
  "hvac contractor",
  "plumber",
  "roofing contractor",
  "landscaping company",
  "pest control",
  "auto repair shop",
  "dental office",
  "law firm"
];

const CITIES = ["Phoenix AZ", "Mesa AZ", "Scottsdale AZ", "Tempe AZ", "Chandler AZ", "Glendale AZ"];

const VALUE_PROP =
  "We give small businesses an AI coworker that answers every call, text, and " +
  "web message, books the job straight into your calendar, and hands anything " +
  "it should not handle to you.";

const SENDER_NAME = "Brian";

const { createClient } = await import("@supabase/supabase-js");
const { prospectOutreachTemplate } = await import("../../src/lib/ai-flows/templates.ts");
const { parseAiFlowDefinition } = await import("../../src/lib/ai-flows/schema.ts");
const { recordOneshotApplied } = await import("./_ledger.ts");

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "",
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
  { auth: { persistSession: false } }
);

const template = prospectOutreachTemplate();
// Validate before anything is written, so even a dry run catches a template
// that the install route would reject.
parseAiFlowDefinition(template.definition);

const { data: business, error: businessError } = await db
  .from("businesses")
  .select("id, name, timezone, address")
  .eq("id", HQ_BUSINESS_ID)
  .maybeSingle();
if (businessError) throw new Error(`read business: ${businessError.message}`);
if (!business) throw new Error(`HQ business ${HQ_BUSINESS_ID} not found`);

/**
 * The postal address printed in every footer comes from the business profile,
 * never from a constant in here.
 *
 * CAN-SPAM wants a real, current address for the sender. A plausible-looking
 * one hard-coded in a script is the worst of both worlds: it satisfies the
 * check constraint and the reader's glance while being wrong, and nobody
 * re-reads a one-shot after it has run once. So this refuses to apply until
 * the address exists in Settings, Business profile, where it is maintained
 * alongside everything else customers see.
 */
const postalAddress = (business as { address?: string | null }).address?.trim() ?? "";

const { data: existingFlow, error: flowError } = await db
  .from("ai_flows")
  .select("id, name, enabled")
  .eq("business_id", HQ_BUSINESS_ID)
  .eq("name", template.name)
  .maybeSingle();
if (flowError) throw new Error(`read flows: ${flowError.message}`);

const { data: existingSettings, error: settingsError } = await db
  .from("outreach_settings")
  .select("mode, search_terms, cities, daily_cap")
  .eq("business_id", HQ_BUSINESS_ID)
  .maybeSingle();
if (settingsError) throw new Error(`read outreach_settings: ${settingsError.message}`);

/**
 * An existing mode is left exactly as it is, in BOTH directions. Off is the
 * owner's kill switch, so a re-run that quietly turned it back to manual would
 * be the script overruling a deliberate decision to stop. Manual defaults only
 * when there is no row yet.
 */
const mode = existingSettings?.mode ?? "manual";

console.log(`Business: ${business.name} (${HQ_BUSINESS_ID})`);
console.log(`Timezone: ${business.timezone ?? "(none, the send window will read as UTC)"}`);
console.log(
  existingFlow
    ? `Flow: "${template.name}" already installed (${existingFlow.id}, ${existingFlow.enabled ? "enabled" : "disabled"})`
    : `Flow: will install "${template.name}" DISABLED`
);
console.log(
  existingSettings
    ? `Settings: exist (mode ${existingSettings.mode}, ${existingSettings.search_terms.length} terms x ${existingSettings.cities.length} cities, cap ${existingSettings.daily_cap})`
    : "Settings: will create"
);
console.log(`Mode after apply: ${mode}`);
console.log(`Targeting: ${SEARCH_TERMS.length} terms x ${CITIES.length} cities`);
console.log(
  `Postal address: ${postalAddress || "MISSING. Set it under Settings, Business profile: this cannot apply without one."}`
);

if (!APPLY) {
  console.log("\nDry run. Re-run with --apply to write.");
  process.exit(0);
}

if (!postalAddress) {
  console.error(
    "\nRefusing to apply: HQ has no address in its business profile, and every " +
      "marketing email has to carry a real postal address. Set it under " +
      "Settings, Business profile, then re-run."
  );
  process.exit(1);
}

let installedFlowId = existingFlow?.id ?? null;
if (!existingFlow) {
  const { data: created, error: insertError } = await db
    .from("ai_flows")
    .insert({
      business_id: HQ_BUSINESS_ID,
      name: template.name,
      definition: template.definition,
      enabled: false
    })
    .select("id")
    .single();
  if (insertError) throw new Error(`install flow: ${insertError.message}`);
  installedFlowId = (created as { id: string }).id;
  console.log(`Installed flow ${installedFlowId} (disabled).`);
}

const { error: upsertError } = await db.from("outreach_settings").upsert(
  {
    business_id: HQ_BUSINESS_ID,
    mode,
    search_terms: SEARCH_TERMS,
    cities: CITIES,
    daily_cap: 12,
    send_window_start_hour: 8,
    send_window_end_hour: 11,
    postal_address: postalAddress,
    value_prop: VALUE_PROP,
    sender_name: SENDER_NAME,
    updated_at: new Date().toISOString()
  },
  { onConflict: "business_id" }
);
if (upsertError) throw new Error(`write outreach_settings: ${upsertError.message}`);

await recordOneshotApplied(db, {
  scriptPath: process.argv[1],
  businessId: HQ_BUSINESS_ID,
  details: {
    mode,
    flow_id: installedFlowId,
    flow_installed: !existingFlow,
    search_terms: SEARCH_TERMS.length,
    cities: CITIES.length
  }
});

console.log("\nApplied.");
console.log("Next, in order:");
console.log("  1. GOOGLE_PLACES_API_KEY must be set in the app environment, or discovery no-ops.");
console.log("  2. Enable the flow from Dashboard, AiFlows once you have read it.");
console.log("  3. Read the first drafts on Dashboard, Marketing, then Send or Skip each.");
console.log("  4. Flip the mode to automatic there when the drafts read right.");
