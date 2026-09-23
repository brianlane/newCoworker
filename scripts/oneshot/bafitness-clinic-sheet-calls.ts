/**
 * bafitness-clinic-sheet-calls.ts
 *
 * BA Fitness, 2026-09-23:
 *   - Turn OFF "Lead follow-up (white-glove build)". It was restored with
 *     stock "book a visit" SMS, which the owner had asked to remove, and the
 *     next Facebook lead would have been texted that line. Enabled is set
 *     false. The definition is left as it is.
 *   - Install (or converge) "Clinic sheet patient call": webhook source
 *     clinic_google_sheet, 7 minute wait, then an AI call inside 09:00-18:00
 *     clinic time. Dane is Pacific. Every other named clinic is Eastern.
 *     The flow is enabled. It does not create a contact.
 *   - Relabel bare `phone` memory facts whose number is the coworker DID
 *     or the forwarded business line, so personal / business / coworker
 *     stop collapsing into one predicate.
 *
 * Usage:
 *   npx tsx scripts/oneshot/bafitness-clinic-sheet-calls.ts --business <uuid>
 *   npx tsx scripts/oneshot/bafitness-clinic-sheet-calls.ts --business <uuid> --apply
 */
import { loadEnv } from "../../debug/_shared.ts";
import {
  BAFITNESS_CLINIC_FLOW_NAME,
  BAFITNESS_STOCK_FOLLOWUP_NAME,
  buildBafitnessClinicSheetDefinition
} from "./bafitness-clinic-sheet-definition.ts";

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

const next = buildBafitnessClinicSheetDefinition();
try {
  parseAiFlowDefinition(next);
} catch (err) {
  if (err instanceof AiFlowValidationError) {
    console.error(`[oneshot] built definition failed schema validation: ${err.message}`);
    process.exit(1);
  }
  throw err;
}

function last10(value: string): string {
  const digits = value.replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : "";
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

const { data: clinic, error: clinicErr } = await db
  .from("ai_flows")
  .select("id, name, enabled, definition")
  .eq("business_id", BUSINESS_ID)
  .eq("name", BAFITNESS_CLINIC_FLOW_NAME)
  .is("deleted_at", null)
  .maybeSingle();
if (clinicErr) {
  console.error(`[oneshot] clinic flow fetch failed: ${clinicErr.message}`);
  process.exit(1);
}

const { data: route, error: routeErr } = await db
  .from("telnyx_voice_routes")
  .select("to_e164")
  .eq("business_id", BUSINESS_ID)
  .limit(1)
  .maybeSingle();
if (routeErr) {
  console.error(`[oneshot] voice route fetch failed: ${routeErr.message}`);
  process.exit(1);
}
const { data: settings, error: settingsErr } = await db
  .from("business_telnyx_settings")
  .select("forward_to_e164")
  .eq("business_id", BUSINESS_ID)
  .maybeSingle();
if (settingsErr) {
  console.error(`[oneshot] telnyx settings fetch failed: ${settingsErr.message}`);
  process.exit(1);
}

const did10 = last10(typeof route?.to_e164 === "string" ? route.to_e164 : "");
const forward10 = last10(
  typeof settings?.forward_to_e164 === "string" ? settings.forward_to_e164 : ""
);

const { data: phoneFacts, error: factsErr } = await db
  .from("memory_facts")
  .select("id, predicate, object_value")
  .eq("business_id", BUSINESS_ID)
  .eq("predicate", "phone")
  .eq("active", true);
if (factsErr) {
  console.error(`[oneshot] memory fact fetch failed: ${factsErr.message}`);
  process.exit(1);
}

const relabel: Array<{ id: string; predicate: string }> = [];
for (const fact of phoneFacts ?? []) {
  const value = typeof fact.object_value === "string" ? fact.object_value : "";
  const key = last10(value);
  if (!key) continue;
  if (did10 && key === did10) relabel.push({ id: fact.id, predicate: "coworker_phone" });
  else if (forward10 && key === forward10) relabel.push({ id: fact.id, predicate: "business_phone" });
}

console.log(
  `[oneshot] stock follow-up ${stock ? `${stock.id} enabled=${stock.enabled}` : "not found"}`
);
console.log(
  `[oneshot] clinic call ${clinic ? `${clinic.id} enabled=${clinic.enabled} (will converge)` : "will insert, enabled"}`
);
console.log(`[oneshot] phone facts to relabel: ${relabel.length}`);
if (clinic) {
  console.log("[oneshot] CURRENT clinic definition (rollback copy):");
  console.log(JSON.stringify(clinic.definition));
}
console.log("[oneshot] NEW clinic definition:");
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
      edit_actor: "bafitness-clinic-sheet-calls.ts"
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

let clinicId = clinic?.id as string | undefined;
if (clinic) {
  const { data: updated, error: updateErr } = await db
    .from("ai_flows")
    .update({
      definition: next,
      enabled: true,
      enabled_changed_at: now,
      updated_at: now,
      edit_source: "oneshot",
      edit_actor: "bafitness-clinic-sheet-calls.ts"
    })
    .eq("id", clinic.id)
    .eq("business_id", BUSINESS_ID)
    .select("id, enabled");
  if (updateErr) {
    console.error(`[oneshot] clinic update failed: ${updateErr.message}`);
    process.exit(1);
  }
  if (!updated || updated.length !== 1 || updated[0].enabled !== true) {
    console.error("[oneshot] clinic update matched no row");
    process.exit(1);
  }
} else {
  const { data: inserted, error: insertErr } = await db
    .from("ai_flows")
    .insert({
      business_id: BUSINESS_ID,
      name: BAFITNESS_CLINIC_FLOW_NAME,
      enabled: true,
      definition: next,
      enabled_changed_at: now,
      updated_at: now,
      edit_source: "oneshot",
      edit_actor: "bafitness-clinic-sheet-calls.ts"
    })
    .select("id, enabled");
  if (insertErr || !inserted || inserted.length !== 1 || inserted[0].enabled !== true) {
    console.error(`[oneshot] clinic insert failed: ${insertErr?.message ?? "no row"}`);
    process.exit(1);
  }
  clinicId = inserted[0].id;
  console.log(`[oneshot] inserted ${clinicId}`);
}

for (const fact of relabel) {
  const { data: changed, error: relabelErr } = await db
    .from("memory_facts")
    .update({ predicate: fact.predicate })
    .eq("id", fact.id)
    .eq("business_id", BUSINESS_ID)
    .eq("predicate", "phone")
    .select("id");
  if (relabelErr || !changed || changed.length !== 1) {
    console.error(`[oneshot] phone relabel failed for ${fact.id}: ${relabelErr?.message ?? "no row"}`);
    process.exit(1);
  }
}

await recordOneshotApplied(db, {
  scriptPath: process.argv[1],
  businessId: BUSINESS_ID,
  details: {
    stockFlowId: stock?.id ?? null,
    stockDisabled: Boolean(stock?.enabled),
    clinicFlowId: clinicId ?? null,
    phoneFactsRelabeled: relabel.length
  }
});
console.log("[oneshot] applied.");
