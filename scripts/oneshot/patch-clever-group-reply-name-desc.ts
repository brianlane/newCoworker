#!/usr/bin/env tsx
/**
 * One-shot: sharpen the `seller_first_name` extraction description in Amy's
 * Clever group-reply AiFlows (the Jul 22 2026 "Hi Amy" greeting regression).
 *
 * Clever's group intro mentions the AGENT ("Amy Laidlaw") four times and the
 * seller only twice ("Hi Pamela 👋 … Amy, when is the earliest you'll be able
 * to give Pamela a call?"). Starting Jul 22 the old one-line description —
 * "The seller's first name from the Clever intro message" — extracted "Amy",
 * so the canned seller reply greeted three sellers with our own agent's name
 * (8/8 correct Jul 13–21, 0/3 after). The break lined up with the Jul 21
 * extraction-model migration (PR #809, 2.5-flash-lite → 3.5-flash-lite), but
 * Jul 23 incident probing showed CURRENT 2.5-flash-lite failing the same
 * prompt 4/4 — the model version isn't the durable variable; the description
 * below probes correct 8/8 on BOTH models even with the pre-fix worker
 * prompt, which is why this patch (applied Jul 23 17:07 UTC) was the
 * immediate mitigation.
 *
 * This patch replaces that description with one that anchors the answer to
 * the greeting ("Hi <name>") and explicitly rules out the agent, in BOTH
 * flows that read the intro:
 *   - "Clever Lead - Group Reply Intro Notify me"  (sends the canned reply)
 *   - "Clever Lead - Group Reply Connected"        (owner notification)
 *
 * Belt-and-suspenders with the same-PR engine fixes (person-role
 * disambiguation in buildExtractionPrompt + the worker's self-name retry):
 * the description is the flow-level guard that also protects a tenant whose
 * worker deploy lags the flow row.
 *
 * Read-modify-write; idempotent (re-running after the description is in
 * place is a no-op). Validated through the SAME parseAiFlowDefinition the
 * dashboard uses. Dry-run by default; --apply records the change in the
 * applied_oneshots ledger.
 *
 * Usage:
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/patch-clever-group-reply-name-desc.ts            # dry run
 *   npx tsx scripts/oneshot/patch-clever-group-reply-name-desc.ts --apply
 *
 * Required env: NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY.
 * Business id: AIFLOW_SEED_BUSINESS_ID or --business-id <uuid> (defaults to Amy's).
 * Optional: AIFLOW_CLEVER_AGENT_DISPLAY (default "Amy Laidlaw") — the agent
 *           name the description rules out.
 */
import { loadEnv } from "../../debug/_shared.ts";

loadEnv();

const { createClient } = await import("@supabase/supabase-js");
const { parseAiFlowDefinition, AiFlowValidationError } = await import(
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
const AGENT_DISPLAY = process.env.AIFLOW_CLEVER_AGENT_DISPLAY ?? "Amy Laidlaw";
const AGENT_FIRST = AGENT_DISPLAY.split(/\s+/)[0];

const FLOW_NAMES = [
  "Clever Lead - Group Reply Intro Notify me",
  "Clever Lead - Group Reply Connected"
];

const FIELD_NAME = "seller_first_name";
const NEW_DESCRIPTION =
  "The seller's first name — the person Clever greets at the START of the " +
  'message ("Hi <name>") and asks the agent to call. ' +
  `NEVER "${AGENT_FIRST}" or "${AGENT_DISPLAY}": that is our own agent being ` +
  "introduced TO the seller, not the seller.";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "";
const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
if (!url || !key) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
  process.exit(2);
}
const db = createClient(url, key, { auth: { persistSession: false } });

function patch(def: AiFlowDefinition): { next: AiFlowDefinition; changed: boolean } {
  let changed = false;
  const steps: FlowStep[] = def.steps.map((s) => {
    if (s.type !== "extract_text") return s;
    const fields = s.fields.map((f) => {
      if (f.name !== FIELD_NAME || f.description === NEW_DESCRIPTION) return f;
      changed = true;
      return { ...f, description: NEW_DESCRIPTION };
    });
    return { ...s, fields };
  });
  return { next: { ...def, steps }, changed };
}

async function main(): Promise<void> {
  const patchedFlows: Array<{ id: string; name: string }> = [];
  for (const flowName of FLOW_NAMES) {
    const { data, error } = await db
      .from("ai_flows")
      .select("id,name,enabled,definition")
      .eq("business_id", BUSINESS_ID)
      .eq("name", flowName)
      .maybeSingle();
    if (error) throw new Error(`read "${flowName}": ${error.message}`);
    if (!data) {
      console.log(`No "${flowName}" flow for business ${BUSINESS_ID} — skipping.`);
      continue;
    }
    const row = data as { id: string; name: string; enabled: boolean; definition: unknown };

    const current = parseAiFlowDefinition(row.definition);
    const { next, changed } = patch(current);
    if (!changed) {
      console.log(`"${row.name}" already carries the sharpened description. Nothing to do.`);
      continue;
    }

    let validated: AiFlowDefinition;
    try {
      validated = parseAiFlowDefinition(next);
    } catch (err) {
      if (err instanceof AiFlowValidationError) {
        console.error(`Patched "${row.name}" failed validation:`);
        for (const issue of err.issues) console.error(`  - ${issue}`);
        process.exit(2);
      }
      throw err;
    }

    console.log(`Flow     : ${row.name} (id=${row.id}, enabled=${row.enabled})`);
    console.log(`Change   : ${FIELD_NAME} description → ${NEW_DESCRIPTION}`);

    if (!APPLY) {
      console.log("[dry-run] Not writing.\n");
      continue;
    }

    const { error: updErr } = await db
      .from("ai_flows")
      .update({ definition: validated })
      .eq("id", row.id);
    if (updErr) throw new Error(`update "${row.name}" failed: ${updErr.message}`);
    patchedFlows.push({ id: row.id, name: row.name });
    console.log(`Patched "${row.name}".\n`);
  }

  if (!APPLY) {
    console.log("\n[dry-run] Re-run with --apply to update.");
    return;
  }
  if (patchedFlows.length > 0) {
    await recordOneshotApplied(db, {
      scriptPath: process.argv[1] ?? "patch-clever-group-reply-name-desc.ts",
      businessId: BUSINESS_ID,
      details: { flows: patchedFlows, field: FIELD_NAME, description: NEW_DESCRIPTION }
    });
  }
  console.log(`Done (${patchedFlows.length} flow(s) patched).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
