#!/usr/bin/env tsx
/**
 * One-shot: add an `arm_voice_transfer` step to the "Clever Cue Text" AiFlow.
 *
 * Why (incident Jul 20 2026): the Cue flow replied "Y" and Clever queued a
 * live transfer, but the concierge called from a number NOT in any per-caller
 * voice routing rule (+18609926975 — the concierge pool rotates), so the AI
 * answered and ran its intake script instead of bridging to Dave; the lead was
 * lost. The fix: the moment the Cue flow confirms "Y", arm a short
 * voice_expected_transfers window so the NEXT unmatched inbound call bridges
 * straight to the assigned agent, whatever number it comes from.
 *
 *   inbound cue -> reply "Y" -> arm 20-min expected-call window to Dave
 *
 * Read-modify-write; idempotent (skips when an arm_voice_transfer step already
 * exists). Validated through the SAME parseAiFlowDefinition the dashboard
 * uses. Dry-run by default; --apply records the change in the
 * applied_oneshots ledger.
 *
 * Usage:
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/patch-clever-cue-arm-transfer.ts            # dry run
 *   npx tsx scripts/oneshot/patch-clever-cue-arm-transfer.ts --apply
 *
 * Required env: NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY.
 * Business id: AIFLOW_SEED_BUSINESS_ID or --business-id <uuid> (defaults to Amy's).
 * Optional overrides:
 *   AIFLOW_SEED_NAME                  (default "Clever Cue Text")
 *   AIFLOW_CLEVER_CUE_TRANSFER_TO     (default "+16025245719" — Dave)
 *   AIFLOW_CLEVER_CUE_WINDOW_MINUTES  (default "20")
 */
import { loadEnv } from "../../debug/_shared.ts";

loadEnv();

const { createClient } = await import("@supabase/supabase-js");
const { parseAiFlowDefinition, summarizeDefinition, AiFlowValidationError } = await import(
  "../../src/lib/ai-flows/schema.ts"
);
const { recordOneshotApplied } = await import("./_ledger.ts");
import type { AiFlowDefinition, FlowStep } from "../../src/lib/ai-flows/schema.ts";

const APPLY = process.argv.includes("--apply");
const bizFlag = process.argv.indexOf("--business-id");
const BUSINESS_ID =
  (bizFlag >= 0 ? process.argv[bizFlag + 1] : undefined) ??
  process.env.AIFLOW_SEED_BUSINESS_ID ??
  "621a5b0d-c2ad-449f-9d74-9d50e7b27fa3";
const FLOW_NAME = process.env.AIFLOW_SEED_NAME ?? "Clever Cue Text";
const TRANSFER_TO = process.env.AIFLOW_CLEVER_CUE_TRANSFER_TO ?? "+16025245719";
const WINDOW_MINUTES = Number(process.env.AIFLOW_CLEVER_CUE_WINDOW_MINUTES ?? "20");

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "";
const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
if (!url || !key) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
  process.exit(2);
}
const db = createClient(url, key, { auth: { persistSession: false } });

function patch(def: AiFlowDefinition): { next: AiFlowDefinition; changes: string[] } {
  const changes: string[] = [];
  const steps: FlowStep[] = [...def.steps];

  const hasArm = steps.some((s) => s.type === "arm_voice_transfer");
  if (!hasArm) {
    // Insert right after the "Y" reply so the window arms the moment the cue
    // is confirmed (Clever calls "within 5 minutes"; observed at ~7).
    const replyIdx = steps.findIndex((s) => s.type === "send_sms");
    if (replyIdx < 0) {
      throw new Error('no send_sms ("Y" reply) step found — is this the Clever Cue flow?');
    }
    steps.splice(replyIdx + 1, 0, {
      id: "arm_transfer",
      type: "arm_voice_transfer",
      toE164: TRANSFER_TO,
      windowMinutes: WINDOW_MINUTES
    } as FlowStep);
    changes.push(
      `insert arm_transfer after step ${replyIdx + 1} (${WINDOW_MINUTES} min -> ${TRANSFER_TO})`
    );
  }

  return { next: { ...def, steps }, changes };
}

async function main(): Promise<void> {
  const { data, error } = await db
    .from("ai_flows")
    .select("id,name,enabled,definition")
    .eq("business_id", BUSINESS_ID)
    .eq("name", FLOW_NAME)
    .maybeSingle();
  if (error) throw new Error(`read "${FLOW_NAME}": ${error.message}`);
  if (!data) throw new Error(`no "${FLOW_NAME}" flow for business ${BUSINESS_ID}`);
  const row = data as { id: string; name: string; enabled: boolean; definition: unknown };

  const current = parseAiFlowDefinition(row.definition);
  const { next, changes } = patch(current);
  if (changes.length === 0) {
    console.log(`"${FLOW_NAME}" already patched (arm_voice_transfer present). Nothing to do.`);
    return;
  }

  let validated: AiFlowDefinition;
  try {
    validated = parseAiFlowDefinition(next);
  } catch (err) {
    if (err instanceof AiFlowValidationError) {
      console.error("Patched definition failed validation:");
      for (const issue of err.issues) console.error(`  - ${issue}`);
      process.exit(2);
    }
    throw err;
  }

  console.log(`Business : ${BUSINESS_ID}`);
  console.log(`Flow     : ${row.name} (id=${row.id}, enabled=${row.enabled})`);
  console.log(`Changes  : ${changes.join("; ")}`);
  console.log(`Summary  : ${summarizeDefinition(validated)}`);

  if (!APPLY) {
    console.log("\n[dry-run] Not writing. Re-run with --apply to update.");
    return;
  }

  const { error: updErr } = await db
    .from("ai_flows")
    .update({ definition: validated })
    .eq("id", row.id);
  if (updErr) throw new Error(`update failed: ${updErr.message}`);
  await recordOneshotApplied(db, {
    scriptPath: process.argv[1] ?? "patch-clever-cue-arm-transfer.ts",
    businessId: BUSINESS_ID,
    details: { flow_id: row.id, flow_name: row.name, changes }
  });
  console.log(`\nPatched "${row.name}" (${changes.length} change(s)).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
