/**
 * patch-kyp-noshow-links.ts — KYP Ads no-show recovery link routing.
 *
 * Incident (Jul 20 2026, Tim Tsai): the "No-show recovery text" flow
 * hardcoded the $200 booking link (kyp-ads-free-strategy-2) for every
 * no-show, so a $100/week lead was offered the $200 event. The patched
 * definition (kyp-noshow-definition.ts, pinned by
 * tests/oneshot-kyp-noshow-definition.test.ts) extracts the booked event's
 * title and rebooks the SAME offer: "… | 2" → $200 link, plain
 * "Free Strategy Call" → $100 link, anything else → owner-only note.
 *
 * The flow's ENABLED state is deliberately untouched: it was switched off on
 * Jul 20 after the duplicate-text incident and stays off until James
 * approves it (its name still says "awaiting approval").
 *
 * Usage (business id from --business or KYP_BUSINESS_ID — never hard-coded,
 * per scripts/oneshot/README.md):
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/patch-kyp-noshow-links.ts --business <uuid>          # dry-run
 *   npx tsx scripts/oneshot/patch-kyp-noshow-links.ts --business <uuid> --apply  # write
 */
import { loadEnv } from "../../debug/_shared.ts";
import { buildKypNoShowDefinition, KYP_NOSHOW_FLOW_NAME } from "./kyp-noshow-definition.ts";

loadEnv();

const APPLY = process.argv.includes("--apply");
const businessArgIdx = process.argv.indexOf("--business");
const BUSINESS_ID =
  (businessArgIdx !== -1 ? process.argv[businessArgIdx + 1] : undefined) ??
  process.env.KYP_BUSINESS_ID;
if (!BUSINESS_ID || !/^[0-9a-f-]{36}$/i.test(BUSINESS_ID)) {
  console.error("[oneshot] pass --business <uuid> (or set KYP_BUSINESS_ID)");
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
  .eq("name", KYP_NOSHOW_FLOW_NAME)
  .maybeSingle();

if (fetchErr || !row) {
  console.error("[oneshot] flow not found:", fetchErr?.message ?? KYP_NOSHOW_FLOW_NAME);
  process.exit(1);
}

let definition;
try {
  definition = parseAiFlowDefinition(buildKypNoShowDefinition());
} catch (err) {
  if (err instanceof AiFlowValidationError) {
    console.error("[oneshot] validation failed:", err.issues);
  } else {
    console.error("[oneshot] validation failed:", err);
  }
  process.exit(1);
}

console.log("[oneshot] target:", { businessId: BUSINESS_ID, flowId: row.id, enabled: row.enabled });
console.log("[oneshot] new definition:", summarizeDefinition(definition));
console.log(
  '[oneshot] routing: title contains "free strategy call | 2" → $200 link; ' +
    'plain "free strategy call" → $100 link; unrecognized → owner-only note (no lead text)'
);
console.log("[oneshot] enabled state untouched (stays", row.enabled, "— James re-approves)");

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
    flow_name: KYP_NOSHOW_FLOW_NAME,
    link_routing: "event_title_branch_200_vs_100_else_owner_note",
    enabled_untouched: row.enabled
  }
});

console.log("[oneshot] applied.");
