/**
 * bafitness-fb-lead-calls.ts
 *
 * BA Fitness item 4 (2026-09-25):
 *   - Keep "Lead follow-up (white-glove build)" DISABLED.
 *   - Install (or converge) "FB Patient + Clinic Quinn call": webhook source
 *     facebook_lead_ads only. Wait 7 minutes, place_ai_call as Quinn with
 *     distinct Patient vs Clinic-owner copy (branch on clinic_type), then
 *     one SMS if the call did not connect. No upsert_customer. No welcome
 *     email (James owns FB sequences). Enabled on apply.
 *
 * Usage:
 *   npx tsx scripts/oneshot/bafitness-fb-lead-calls.ts --business <uuid>
 *   npx tsx scripts/oneshot/bafitness-fb-lead-calls.ts --business <uuid> --apply
 */
import { loadEnv } from "../../debug/_shared.ts";
import {
  BAFITNESS_FB_FLOW_NAME,
  BAFITNESS_STOCK_FOLLOWUP_NAME,
  buildBafitnessFbLeadCallsDefinition
} from "./bafitness-fb-lead-calls-definition.ts";

loadEnv();

const APPLY = process.argv.includes("--apply");
const businessArgIdx = process.argv.indexOf("--business");
const BUSINESS_ID =
  (businessArgIdx !== -1 ? process.argv[businessArgIdx + 1] : undefined) ??
  process.env.BAFITNESS_BUSINESS_ID;
if (!BUSINESS_ID || !/^[0-9a-f-]{36}$/i.test(BUSINESS_ID)) {
  console.error("[oneshot] pass --business <uuid> (or set BAFITNESS_BUSINESS_ID)");
  process.exit(1);
}

const { createClient } = await import("@supabase/supabase-js");
const { parseAiFlowDefinition, AiFlowValidationError } = await import(
  "../../src/lib/ai-flows/schema.ts"
);
const { recordOneshotApplied } = await import("./_ledger.ts");

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "",
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
  { auth: { persistSession: false } }
);

const next = buildBafitnessFbLeadCallsDefinition();
try {
  parseAiFlowDefinition(next);
} catch (err) {
  if (err instanceof AiFlowValidationError) {
    console.error(`[oneshot] built definition failed schema validation: ${err.message}`);
    process.exit(1);
  }
  throw err;
}

const { data: stock, error: stockErr } = await db
  .from("ai_flows")
  .select("id, name, enabled, deleted_at")
  .eq("business_id", BUSINESS_ID)
  .eq("name", BAFITNESS_STOCK_FOLLOWUP_NAME)
  .is("deleted_at", null)
  .maybeSingle();
if (stockErr) {
  console.error(`[oneshot] stock flow fetch failed: ${stockErr.message}`);
  process.exit(1);
}

const { data: fbFlow, error: fbErr } = await db
  .from("ai_flows")
  .select("id, name, enabled, definition")
  .eq("business_id", BUSINESS_ID)
  .eq("name", BAFITNESS_FB_FLOW_NAME)
  .is("deleted_at", null)
  .maybeSingle();
if (fbErr) {
  console.error(`[oneshot] fb flow fetch failed: ${fbErr.message}`);
  process.exit(1);
}

console.log(
  `[oneshot] stock follow-up ${stock ? `${stock.id} enabled=${stock.enabled}` : "not found"}`
);
console.log(
  `[oneshot] fb call ${fbFlow ? `${fbFlow.id} enabled=${fbFlow.enabled} (will converge)` : "will insert, enabled"}`
);
if (fbFlow) {
  console.log("[oneshot] CURRENT fb definition (rollback copy):");
  console.log(JSON.stringify(fbFlow.definition));
}
console.log("[oneshot] NEW fb definition:");
console.log(JSON.stringify(next));

if (!APPLY) {
  console.log("[oneshot] dry-run only. Re-run with --apply to write.");
  process.exit(0);
}

const now = new Date().toISOString();

if (stock?.enabled) {
  const { data: disabled, error: disableErr } = await db
    .from("ai_flows")
    .update({
      enabled: false,
      enabled_changed_at: now,
      updated_at: now,
      edit_source: "oneshot",
      edit_actor: "bafitness-fb-lead-calls.ts"
    })
    .eq("id", stock.id)
    .eq("business_id", BUSINESS_ID)
    .eq("enabled", true)
    .select("id");
  if (disableErr) {
    console.error(`[oneshot] disable failed: ${disableErr.message}`);
    process.exit(1);
  }
  if (!disabled || disabled.length !== 1) {
    console.error("[oneshot] disable matched no row");
    process.exit(1);
  }
  console.log(`[oneshot] disabled ${stock.id}`);
} else {
  console.log("[oneshot] stock follow-up already off or absent");
}

let fbId = fbFlow?.id as string | undefined;
if (fbFlow) {
  const { data: updated, error: updateErr } = await db
    .from("ai_flows")
    .update({
      definition: next,
      enabled: true,
      enabled_changed_at: now,
      updated_at: now,
      edit_source: "oneshot",
      edit_actor: "bafitness-fb-lead-calls.ts"
    })
    .eq("id", fbFlow.id)
    .eq("business_id", BUSINESS_ID)
    .select("id, enabled");
  if (updateErr) {
    console.error(`[oneshot] fb update failed: ${updateErr.message}`);
    process.exit(1);
  }
  if (!updated || updated.length !== 1 || updated[0].enabled !== true) {
    console.error("[oneshot] fb update matched no row");
    process.exit(1);
  }
  console.log(`[oneshot] updated ${fbId}`);
} else {
  const { data: inserted, error: insertErr } = await db
    .from("ai_flows")
    .insert({
      business_id: BUSINESS_ID,
      name: BAFITNESS_FB_FLOW_NAME,
      enabled: true,
      definition: next,
      enabled_changed_at: now,
      updated_at: now,
      edit_source: "oneshot",
      edit_actor: "bafitness-fb-lead-calls.ts"
    })
    .select("id, enabled");
  if (insertErr || !inserted || inserted.length !== 1 || inserted[0].enabled !== true) {
    console.error(`[oneshot] fb insert failed: ${insertErr?.message ?? "no row"}`);
    process.exit(1);
  }
  fbId = inserted[0].id;
  console.log(`[oneshot] inserted ${fbId}`);
}

await recordOneshotApplied(db, {
  scriptPath: process.argv[1],
  businessId: BUSINESS_ID,
  details: {
    stockFlowId: stock?.id ?? null,
    stockDisabled: Boolean(stock?.enabled),
    fbFlowId: fbId ?? null
  }
});
console.log("[oneshot] applied.");
