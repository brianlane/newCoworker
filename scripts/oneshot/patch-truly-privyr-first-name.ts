#!/usr/bin/env tsx
/**
 * One-shot: address Truly Insurance's Privyr leads by FIRST name in the
 * flow's customer-facing texts.
 *
 * Jul 21 2026: the Privyr lead email carries the raw full name
 * ("shabir gulamhussein lukmanji"), and the intake flow's templates used
 * `{{vars.lead_name}}` verbatim — so the greeting and every templated nudge
 * opened with the whole lowercase legal name. The `.first` name part
 * (PR #806) plus its polite casing renders "Shabir" instead.
 *
 * Scope: `send_sms` steps addressed TO THE LEAD only (`to` references
 * `lead_phone` / `trigger.from`). Staff-facing texts (route_to_team offers,
 * owner notices) deliberately keep the full name — brokers want it.
 *
 * Read-modify-write, validated through parseAiFlowDefinition, idempotent
 * (the replacement token no longer matches once patched). Dry-run by
 * default. Records to applied_oneshots on --apply. Does NOT enqueue runs.
 *
 * Usage:
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/patch-truly-privyr-first-name.ts          # dry run
 *   npx tsx scripts/oneshot/patch-truly-privyr-first-name.ts --apply
 */
import { loadEnv } from "../../debug/_shared.ts";

loadEnv();

const { createClient } = await import("@supabase/supabase-js");
const { parseAiFlowDefinition, AiFlowValidationError } = await import(
  "../../src/lib/ai-flows/schema.ts"
);
const { recordOneshotApplied } = await import("./_ledger.ts");
import type { AiFlowDefinition } from "../../src/lib/ai-flows/schema.ts";

const APPLY = process.argv.includes("--apply");
const BUSINESS_ID = "690f85c0-ee16-4ee5-bde5-5829df2e5410"; // Truly Insurance
const FLOW_NAMES = [
  "Lead intake & follow-up (Privyr) (copy)", // enabled, live
  "Lead intake & follow-up (Privyr)" // disabled original, kept consistent
];

const FULL = "{{vars.lead_name}}";
const FIRST = "{{vars.lead_name.first}}";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "";
const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
if (!url || !key) throw new Error("Missing Supabase env");
const db = createClient(url, key, { auth: { persistSession: false } });

type Row = { id: string; name: string; enabled: boolean; definition: AiFlowDefinition };
type AnyStep = Record<string, unknown>;

async function loadFlow(name: string): Promise<Row> {
  const { data, error } = await db
    .from("ai_flows")
    .select("id,name,enabled,definition")
    .eq("business_id", BUSINESS_ID)
    .eq("name", name)
    .maybeSingle();
  if (error) throw new Error(`read "${name}": ${error.message}`);
  if (!data) throw new Error(`no "${name}" flow for business ${BUSINESS_ID}`);
  return data as Row;
}

/** Whether a send_sms step's `to` targets the LEAD (not a staff number). */
function targetsLead(step: AnyStep): boolean {
  const to = typeof step.to === "string" ? step.to : "";
  return to.includes("lead_phone") || to.includes("trigger.from");
}

/** Patch one flow definition in place; returns the touched step ids. */
function patchDefinition(def: AiFlowDefinition): string[] {
  const touched: string[] = [];
  for (const step of (def as unknown as { steps: AnyStep[] }).steps) {
    if (step.type !== "send_sms" || !targetsLead(step)) continue;
    const body = typeof step.body === "string" ? step.body : "";
    if (!body.includes(FULL)) continue;
    step.body = body.split(FULL).join(FIRST);
    touched.push(String(step.id));
  }
  return touched;
}

async function main() {
  console.log(`${APPLY ? "APPLY" : "dry-run"} — Truly Privyr first-name templates`);
  const patchedFlows: Array<{ id: string; name: string; steps: string[] }> = [];

  for (const name of FLOW_NAMES) {
    const row = await loadFlow(name);
    const def = structuredClone(row.definition);
    const touched = patchDefinition(def);
    if (touched.length === 0) {
      console.log(`  "${row.name}": nothing to patch (already on ${FIRST}?)`);
      continue;
    }
    try {
      parseAiFlowDefinition(def);
    } catch (err) {
      if (err instanceof AiFlowValidationError) {
        throw new Error(`patched "${row.name}" fails validation: ${err.message}`);
      }
      throw err;
    }
    console.log(`  "${row.name}" (${row.enabled ? "enabled" : "disabled"}):`);
    console.log(`    ${touched.length} customer-facing send_sms step(s): ${touched.join(", ")}`);
    if (APPLY) {
      const { error } = await db
        .from("ai_flows")
        .update({ definition: def })
        .eq("id", row.id)
        .eq("business_id", BUSINESS_ID);
      if (error) throw new Error(`update "${row.name}": ${error.message}`);
      console.log("    applied.");
    }
    patchedFlows.push({ id: row.id, name: row.name, steps: touched });
  }

  if (APPLY && patchedFlows.length > 0) {
    await recordOneshotApplied(db, {
      scriptPath: process.argv[1] ?? "patch-truly-privyr-first-name.ts",
      businessId: BUSINESS_ID,
      details: { flows: patchedFlows, replaced: `${FULL} -> ${FIRST}` }
    });
  }
  console.log(APPLY ? "Done." : "Dry-run complete — re-run with --apply to write.");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
