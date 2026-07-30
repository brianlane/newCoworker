/**
 * patch-scar-fairy-lead-flow.ts: Scar Fairy Meta lead follow-up.
 *
 * Replaces the never-customized white-glove template on Scar Fairy's "Lead
 * follow-up (white-glove build)" row with the routed definition in
 * scar-fairy-lead-definition.ts (pure builder, pinned by
 * tests/oneshot-scar-fairy-definitions.test.ts). This script only validates,
 * shows the rollback, and writes.
 *
 * What the row looked like before this ran, all of it template default:
 *   - greeting body was the literal placeholder "Hi name.  Thanks for
 *     contacting us. Will be in touch soon."
 *   - trigger conditions were [], so the whole nurture fired on ANY
 *     authenticated webhook event, not just Meta leads
 *   - two steps carried em dashes, which the repo bans
 *
 * Behavior after: 3-minute self-book window, then a text and an email routed
 * to one of three bundles by Facebook lead-form name, then the standard nudge
 * cascade. A Vagaro booking observed inside the window fast-forwards the run
 * past every send. See the header of scar-fairy-lead-definition.ts for why
 * that works and what it depends on.
 *
 * ENABLED IS LEFT ALONE. The row is disabled and stays disabled: the flow is
 * not safe to run until Selena's Vagaro OAuth connection exists, because
 * without it nothing can observe a booking and the "skip if they booked" half
 * of the request silently does nothing. Enabling is a separate, deliberate act.
 *
 * ASSUMPTION: leads arrive via the Zapier bridge ("Send Lead to Coworker"),
 * whose Lead Fields include the Facebook form_name, which is what
 * lead_form_name extracts from and what the bundle routing matches on. The
 * DIRECT Meta connection enqueues form_id with no form title, so name-based
 * routing would fall through to the general arm there. Scar Fairy has no
 * meta_connections row today (bridge-only, same posture as KYP); if that
 * changes, revisit the routing and match on form_id.
 *
 * Usage (business id from --business or SCAR_FAIRY_BUSINESS_ID, never
 * hard-coded, per scripts/oneshot/README.md):
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/patch-scar-fairy-lead-flow.ts --business <uuid>          # dry-run
 *   npx tsx scripts/oneshot/patch-scar-fairy-lead-flow.ts --business <uuid> --apply  # write
 */
import { loadEnv } from "../../debug/_shared.ts";
import {
  buildScarFairyLeadDefinition,
  bookingLinkIsPending,
  SCAR_FAIRY_BOOKING_LINK,
  SCAR_FAIRY_FLOW_NAME,
  SCAR_FAIRY_SELF_BOOK_MINUTES
} from "./scar-fairy-lead-definition.ts";

loadEnv();

const APPLY = process.argv.includes("--apply");
const businessArgIdx = process.argv.indexOf("--business");
const BUSINESS_ID =
  (businessArgIdx !== -1 ? process.argv[businessArgIdx + 1] : undefined) ??
  process.env.SCAR_FAIRY_BUSINESS_ID;
if (!BUSINESS_ID || !/^[0-9a-f-]{36}$/i.test(BUSINESS_ID)) {
  console.error("[oneshot] pass --business <uuid> (or set SCAR_FAIRY_BUSINESS_ID)");
  process.exit(1);
}

const { createClient } = await import("@supabase/supabase-js");
const { parseAiFlowDefinition, summarizeDefinition, AiFlowValidationError } = await import(
  "../../src/lib/ai-flows/schema.ts"
);
const { recordOneshotApplied } = await import("./_ledger.ts");

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "",
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
  { auth: { persistSession: false } }
);

const { data: row, error: fetchErr } = await db
  .from("ai_flows")
  .select("id, name, enabled, definition")
  .eq("business_id", BUSINESS_ID)
  .eq("name", SCAR_FAIRY_FLOW_NAME)
  .maybeSingle();

if (fetchErr || !row) {
  console.error("[oneshot] flow not found:", fetchErr?.message ?? SCAR_FAIRY_FLOW_NAME);
  process.exit(1);
}

let definition;
try {
  definition = parseAiFlowDefinition(buildScarFairyLeadDefinition());
} catch (err) {
  if (err instanceof AiFlowValidationError) {
    console.error("[oneshot] validation failed:", err.issues);
  } else {
    console.error("[oneshot] validation failed:", err);
  }
  process.exit(1);
}

console.log("[oneshot] target:", { businessId: BUSINESS_ID, flowId: row.id, enabled: row.enabled });

// Rollback artifact: the previous definition, verbatim, so this run can be
// undone from its own output without going back to the database.
console.log("[oneshot] PREVIOUS definition (keep this for rollback):");
console.log(JSON.stringify(row.definition, null, 2));

console.log("[oneshot] new definition:", summarizeDefinition(definition));
console.log(
  `[oneshot] self-book window: ${SCAR_FAIRY_SELF_BOOK_MINUTES} minutes, then text + email`
);
console.log("[oneshot] routing: form name contains melasma / vaginal / acne; else the general arm");
console.log("[oneshot] quiet hours: lead SMS defers to 09:00-20:00 America/New_York");
console.log("[oneshot] enabled is NOT changed by this script");

if (bookingLinkIsPending()) {
  console.error("");
  console.error("[oneshot] REFUSING TO APPLY: the Vagaro booking link is still the placeholder");
  console.error(`[oneshot]   SCAR_FAIRY_BOOKING_LINK = ${SCAR_FAIRY_BOOKING_LINK}`);
  console.error("[oneshot] Set the real link in scripts/oneshot/scar-fairy-lead-definition.ts,");
  console.error("[oneshot] then re-run. Applying now would text leads the placeholder string.");
  process.exit(1);
}

if (!APPLY) {
  console.log("[oneshot] dry run complete. Re-run with --apply to write.");
  process.exit(0);
}

const { error: updateErr } = await db
  .from("ai_flows")
  .update({ definition, updated_at: new Date().toISOString() })
  .eq("id", row.id)
  .eq("business_id", BUSINESS_ID);

if (updateErr) {
  console.error("[oneshot] update failed:", updateErr.message);
  process.exit(1);
}

await recordOneshotApplied(db, {
  scriptPath: process.argv[1],
  businessId: BUSINESS_ID,
  details: {
    flow_id: row.id,
    flow_name: SCAR_FAIRY_FLOW_NAME,
    self_book_minutes: SCAR_FAIRY_SELF_BOOK_MINUTES,
    package_routing: "melasma_vaginal_acne_else_general",
    quiet_hours: "lead_sms_09_to_20_new_york",
    left_disabled: row.enabled === false
  }
});

console.log("[oneshot] applied.");
