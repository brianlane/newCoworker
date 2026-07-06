#!/usr/bin/env tsx
/**
 * One-shot: fix the two Clever "Update Leads" AiFlows so their `browse_action`
 * update sequence actually reaches an ENABLED "Submit Update" button.
 *
 * Clever's "We Spoke" update modal has a react-datepicker "When do you plan to
 * follow up again? *" field. The flows only pick the DAY:
 *
 *   click_role option "Choose {{now.in7Days.weekday}}, {{now.in7Days.month}} …"
 *
 * As of July 2026 that no longer commits the field: the datepicker popup stays
 * OPEN (its popper overlaps the modal footer) and the required follow-up value
 * is never confirmed, so "Submit Update" stays disabled. The click then times
 * out; the render service's overlay-dismiss retry closes the whole modal and
 * the action fails with `click_text "Submit Update": no matching control on the
 * page` — which is exactly what "Clever Update Leads (Chris)" has been failing
 * with (all list items).
 *
 * DOM-verified fix: pick a concrete TIME right after the day. Selecting a time
 * from the time column commits the field, closes the popup, and enables Submit.
 * We insert:
 *
 *   click_role option "09:00"     (react-datepicker time-list item; 24h label)
 *
 * immediately after the day-picking click_role. Idempotent (skips if a time
 * pick is already present) and validated through parseAiFlowDefinition.
 *
 * Usage (reads repo-root `.env`, like the rest of debug/):
 *   tsx debug/update-clever-update-followup-time.ts            # dry run
 *   tsx debug/update-clever-update-followup-time.ts --apply
 *
 * Env: NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY.
 * Optional: AIFLOW_UPDATE_BUSINESS_ID, AIFLOW_FOLLOWUP_TIME (default "09:00").
 */
import { createClient } from "@supabase/supabase-js";
import { loadEnv } from "./_shared.ts";
import {
  parseAiFlowDefinition,
  summarizeDefinition,
  AiFlowValidationError,
  type FlowStep
} from "../src/lib/ai-flows/schema.ts";

const FLOW_NAMES = ["Clever Update Leads (Chris)", "Clever Update Leads"] as const;

/** True for the day-picking action we insert the time pick after. */
function isDayPick(a: { kind: string; target: string; valueTemplate?: string }): boolean {
  return a.kind === "click_role" && a.target === "option" && /^Choose\s/i.test(a.valueTemplate ?? "");
}

/** True for a time-list pick like "09:00" (already-applied guard). */
function isTimePick(
  a: { kind: string; target: string; valueTemplate?: string },
  time: string
): boolean {
  return a.kind === "click_role" && a.target === "option" && (a.valueTemplate ?? "") === time;
}

async function main(): Promise<void> {
  loadEnv();
  const BUSINESS_ID =
    process.env.AIFLOW_UPDATE_BUSINESS_ID ?? "621a5b0d-c2ad-449f-9d74-9d50e7b27fa3";
  const FOLLOWUP_TIME = process.env.AIFLOW_FOLLOWUP_TIME ?? "09:00";
  const apply = process.argv.includes("--apply");
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!url || !key) {
    console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
    process.exit(2);
  }
  const db = createClient(url, key, { auth: { persistSession: false } });

  const timePick = {
    kind: "click_role" as const,
    target: "option",
    valueTemplate: FOLLOWUP_TIME
  };

  for (const FLOW_NAME of FLOW_NAMES) {
    const { data: row, error } = await db
      .from("ai_flows")
      .select("id, name, enabled, definition")
      .eq("business_id", BUSINESS_ID)
      .eq("name", FLOW_NAME)
      .maybeSingle();
    if (error) {
      console.error(`[${FLOW_NAME}] read failed: ${error.message}`);
      process.exitCode = 1;
      continue;
    }
    if (!row) {
      console.error(`[${FLOW_NAME}] no flow for business ${BUSINESS_ID} — skipping`);
      continue;
    }

    const def = parseAiFlowDefinition(row.definition);
    const steps: FlowStep[] = def.steps.map((s) => ({ ...s }));
    const idx = steps.findIndex((s) => s.type === "browse_action");
    if (idx === -1) {
      console.error(`[${FLOW_NAME}] no browse_action step — skipping`);
      continue;
    }
    const step = steps[idx];
    if (step.type !== "browse_action") continue;

    const actions = step.actions.map((a) => ({ ...a }));
    const dayIdx = actions.findIndex(isDayPick);
    if (dayIdx === -1) {
      console.error(`[${FLOW_NAME}] no day-picking click_role action — skipping`);
      continue;
    }
    const before = JSON.stringify(step.actions);

    if (actions.some((a) => isTimePick(a, FOLLOWUP_TIME))) {
      console.log(`[${FLOW_NAME}] already has a "${FOLLOWUP_TIME}" time pick — no change`);
      continue;
    }
    actions.splice(dayIdx + 1, 0, { ...timePick });
    steps[idx] = { ...step, actions };

    let validated;
    try {
      validated = parseAiFlowDefinition({ ...def, steps });
    } catch (err) {
      if (err instanceof AiFlowValidationError) {
        console.error(`[${FLOW_NAME}] validation failed:`);
        for (const issue of err.issues) console.error(`  - ${issue}`);
      } else {
        console.error(`[${FLOW_NAME}] validation failed:`, err);
      }
      process.exitCode = 2;
      continue;
    }

    console.log(`\n[${FLOW_NAME}] ${row.id} (enabled=${row.enabled})`);
    console.log(`  Summary       : ${summarizeDefinition(validated)}`);
    console.log(`  Actions before: ${before}`);
    console.log(`  Actions after : ${JSON.stringify(actions)}`);

    if (!apply) {
      console.log("  [dry-run] not writing");
      continue;
    }
    const { error: upErr } = await db
      .from("ai_flows")
      .update({ definition: validated })
      .eq("id", row.id);
    if (upErr) {
      console.error(`[${FLOW_NAME}] update failed: ${upErr.message}`);
      process.exitCode = 1;
      continue;
    }
    console.log("  Updated.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
