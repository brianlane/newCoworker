#!/usr/bin/env tsx
/**
 * One-shot: prepare "Clever Lead - Accept" for the weekly call follow-up flow
 * (see seed-clever-spoke-check-aiflow.ts — Amy's "AI calls the lead weekly
 * until Dave has spoken with them" routine).
 *
 * Read-modify-write; two additions, both idempotent:
 *
 *   1. `remember_page` browse_action AFTER `read_details`: re-opens the
 *      claimed lead URL in a credentialed pass and persists it keyed by the
 *      extracted lead phone (`rememberUrlKeyedByVar: "lead_phone"`), so the
 *      follow-up flow can `recall_url` the SAME Clever page weeks later and
 *      read the CURRENT address + cash offers. The step's single action is a
 *      `click_text_while_present` on a marker string that never appears on
 *      the page — zero matches is SUCCESS for that action kind, so this is a
 *      deliberate no-op visit whose only effect is the URL memory write (the
 *      accept step itself can't remember: lead_phone is extracted two steps
 *      later, and browse_extract has no remember support).
 *   2. `tag_clever` update_contact AFTER `save_contact`: tags the contact
 *      "Clever" so the follow-up flow's owner_assigned trigger can scope to
 *      Clever leads (the contact-event text carries the tag line).
 *
 * Validated through the SAME parseAiFlowDefinition the dashboard uses.
 * Dry-run by default; --apply records the change in the applied_oneshots
 * ledger.
 *
 * Usage:
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/patch-clever-accept-followup.ts            # dry run
 *   npx tsx scripts/oneshot/patch-clever-accept-followup.ts --apply
 *
 * Required env: NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY.
 * Business id: AIFLOW_SEED_BUSINESS_ID or --business-id <uuid> (defaults to Amy's).
 * Optional: AIFLOW_SEED_NAME (default "Clever Lead - Accept"),
 *           AIFLOW_CLEVER_INTEGRATION_LABEL (default "Clever").
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
const FLOW_NAME = process.env.AIFLOW_SEED_NAME ?? "Clever Lead - Accept";
const INTEGRATION_LABEL = process.env.AIFLOW_CLEVER_INTEGRATION_LABEL ?? "Clever";

/**
 * click_text_while_present target that never matches page text: zero matches
 * is success for that kind, so the step is a pure "load the page and remember
 * its URL" visit.
 */
const NOOP_TARGET = "aiflow-remember-page-noop-marker";

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

  const hasRemember = steps.some(
    (s) => s.type === "browse_action" && s.rememberUrlKeyedByVar === "lead_phone"
  );
  if (!hasRemember) {
    // Insert right after the browse_extract that produces lead_phone (the
    // claimed-details re-read), so the remember key is in scope.
    const detailsIdx = steps.findIndex(
      (s) => s.type === "browse_extract" && (s.fields ?? []).some((f) => f.name === "lead_phone")
    );
    if (detailsIdx < 0) {
      throw new Error(
        'no browse_extract producing "lead_phone" found — is this the Clever accept flow?'
      );
    }
    const urlVar = (steps[detailsIdx] as Extract<FlowStep, { type: "browse_extract" }>).urlVar;
    steps.splice(detailsIdx + 1, 0, {
      id: "remember_page",
      type: "browse_action",
      urlVar,
      auth: { integrationLabel: INTEGRATION_LABEL },
      actions: [{ kind: "click_text_while_present", target: NOOP_TARGET }],
      rememberUrlKeyedByVar: "lead_phone"
    } as FlowStep);
    changes.push(`insert remember_page after step ${detailsIdx + 1} (urlVar ${urlVar})`);
  }

  const hasCleverTag = steps.some(
    (s) =>
      s.type === "update_contact" &&
      (s.addTags ?? []).some((t) => t.toLowerCase() === "clever")
  );
  if (!hasCleverTag) {
    const upsertIdx = steps.findIndex((s) => s.type === "upsert_customer");
    if (upsertIdx < 0) {
      throw new Error("no upsert_customer step found — is this the Clever accept flow?");
    }
    steps.splice(upsertIdx + 1, 0, {
      id: "tag_clever",
      type: "update_contact",
      phoneVar: "lead_phone",
      addTags: ["Clever"]
    } as FlowStep);
    changes.push(`insert tag_clever after step ${upsertIdx + 1}`);
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
    console.log(`"${FLOW_NAME}" already patched (remember_page + Clever tag present). Nothing to do.`);
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
    scriptPath: process.argv[1] ?? "patch-clever-accept-followup.ts",
    businessId: BUSINESS_ID,
    details: { flow_id: row.id, flow_name: row.name, changes }
  });
  console.log(`\nPatched "${row.name}" (${changes.length} change(s)).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
