/**
 * patch-kyp-offer-branch.ts — KYP Ads lead follow-up offer routing.
 *
 * $100/week path (deterministic, no LLM classify):
 *   - Facebook form "Simple form setup 5/7/26…"
 *   - Any form_name mentioning 100/week
 * Everything else → $200/week (default Meta lead-gen path).
 *
 * The definition itself lives in kyp-offer-definition.ts (pure builder,
 * pinned by tests/oneshot-kyp-definitions.test.ts — nudges carry the
 * 11:00–18:00 America/Toronto quiet-hours gate, greetings do not). This
 * script only validates and writes it to the live tenant.
 *
 * ASSUMPTION: leads arrive via the Zapier bridge ("Send Lead to Coworker"),
 * whose Lead Fields include the Facebook form_name — that's what
 * lead_form_name extracts from. The DIRECT Meta connection enqueues form_id
 * (no form title), so name-based routing would fall through to the $200
 * else-arm there. KYP has no meta_connections row (bridge-only tenant); if
 * they ever switch to the direct connection, revisit this routing (match on
 * form_id, or map ids → offers).
 *
 * Usage (business id from --business or KYP_BUSINESS_ID — never hard-coded,
 * per scripts/oneshot/README.md):
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/patch-kyp-offer-branch.ts --business <uuid>          # dry-run
 *   npx tsx scripts/oneshot/patch-kyp-offer-branch.ts --business <uuid> --apply  # write
 */
import { loadEnv } from "../../debug/_shared.ts";
import { buildKypOfferDefinition, KYP_FLOW_NAME } from "./kyp-offer-definition.ts";

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
  .eq("name", KYP_FLOW_NAME)
  .maybeSingle();

if (fetchErr || !row) {
  console.error("[oneshot] flow not found:", fetchErr?.message ?? KYP_FLOW_NAME);
  process.exit(1);
}

let definition;
try {
  definition = parseAiFlowDefinition(buildKypOfferDefinition());
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
  "[oneshot] routing: Simple form setup 5/7/26 OR form_name contains 100/week → $100; else → $200"
);
console.log(
  "[oneshot] quiet hours: nudges defer to 11:00–18:00 America/Toronto; greeting stays immediate"
);

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
    flow_name: KYP_FLOW_NAME,
    offer_routing: "simple_form_and_100_week_vs_else_200",
    quiet_hours: "nudges_11_to_18_toronto"
  }
});

console.log("[oneshot] applied.");
