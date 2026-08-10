#!/usr/bin/env tsx
/**
 * One-shot: turn on the unclaimed-lead reminder ladder across Amy Laidlaw's
 * lead flows (her ask, 2026-08-10).
 *
 * Before: an offer nobody claimed went to Amy the moment its deadline lapsed.
 * After: the SAME teammates who were offered the lead get three more nudges,
 * twenty minutes apart, and Amy inherits it one interval after the last one.
 * The final nudge leads with a row of double exclamation marks instead of the
 * asterisk emphasis the earlier rounds use.
 *
 * Touches every `route_to_team` step in each named flow, whether it pins one
 * teammate, rotates the roster, or broadcasts: her instruction was "any aiflow
 * that routes to the team or broadcasts to the team". Reminder recipients are
 * whoever actually saw the lead (a rotation's `offered_log`, a broadcast's
 * live offerees), never the whole roster, so a step that deliberately pins one
 * person keeps its routing intent.
 *
 * Read-modify-write against the LIVE definitions, so hand edits since the last
 * one-shot are preserved. Validated through the SAME parseAiFlowDefinition the
 * dashboard and CRUD API use. Dry-run by default; idempotent (re-running after
 * --apply reports nothing to do). `--revert` strips the ladder back off.
 *
 * Usage:
 *   npx tsx scripts/oneshot/amy-unclaimed-reminders-patch.ts            # dry run
 *   npx tsx scripts/oneshot/amy-unclaimed-reminders-patch.ts --apply
 *   npx tsx scripts/oneshot/amy-unclaimed-reminders-patch.ts --apply --revert
 *   npx tsx scripts/oneshot/amy-unclaimed-reminders-patch.ts --only "HomeLight Referral"
 *
 * Required env: NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY.
 * Business id: AIFLOW_SEED_BUSINESS_ID or --business-id <uuid> (defaults to Amy's).
 */
import { loadEnv } from "../../debug/_shared.ts";

loadEnv();

const { createClient } = await import("@supabase/supabase-js");
const { parseAiFlowDefinition, AiFlowValidationError } = await import(
  "../../src/lib/ai-flows/schema.ts"
);
const { recordOneshotApplied } = await import("./_ledger.ts");
const {
  addUnclaimedReminders,
  AMY_REMINDER_FLOWS,
  AMY_REMINDER_INTERVAL_MINUTES,
  AMY_REMINDER_ROUNDS
} = await import("./amy-unclaimed-reminders-definition.ts");
import type { AiFlowDefinition } from "../../src/lib/ai-flows/schema.ts";

const APPLY = process.argv.includes("--apply");
const REVERT = process.argv.includes("--revert");
const onlyFlag = process.argv.indexOf("--only");
const ONLY = onlyFlag >= 0 ? process.argv[onlyFlag + 1] : null;
const bizFlag = process.argv.indexOf("--business-id");
const BUSINESS_ID =
  (bizFlag >= 0 ? process.argv[bizFlag + 1] : undefined) ??
  process.env.AIFLOW_SEED_BUSINESS_ID ??
  "621a5b0d-c2ad-449f-9d74-9d50e7b27fa3";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "";
const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
if (!url || !key) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
  process.exit(2);
}
const db = createClient(url, key, { auth: { persistSession: false } });

/** Strip the ladder from every route step; returns the ids it changed. */
function removeUnclaimedReminders(def: AiFlowDefinition): string[] {
  const changed: string[] = [];
  const walk = (steps: unknown[]): void => {
    for (const raw of steps ?? []) {
      const st = raw as Record<string, unknown>;
      if (st.type === "route_to_team" && st.unclaimedReminders && typeof st.id === "string") {
        delete st.unclaimedReminders;
        changed.push(st.id);
      }
      if (st.type === "branch") {
        for (const arm of (st.branches as { steps: unknown[] }[]) ?? []) walk(arm.steps);
        walk((st.else as unknown[]) ?? []);
      }
    }
  };
  walk(def.steps as unknown[]);
  return changed;
}

async function main(): Promise<void> {
  const targets = AMY_REMINDER_FLOWS.filter((f) => !ONLY || f.name === ONLY);
  if (targets.length === 0) {
    console.error(`--only "${ONLY}" matched none of the configured flows.`);
    process.exit(2);
  }
  console.log(`Business : ${BUSINESS_ID}`);
  console.log(
    REVERT
      ? "Mode     : REVERT (removing the reminder ladder)"
      : `Mode     : apply ${AMY_REMINDER_ROUNDS} rounds, ${AMY_REMINDER_INTERVAL_MINUTES} min apart`
  );

  let totalChanged = 0;
  const ledgerDetails: Record<string, string[]> = {};

  for (const target of targets) {
    const { data, error } = await db
      .from("ai_flows")
      .select("id,name,enabled,definition")
      .eq("business_id", BUSINESS_ID)
      .eq("name", target.name)
      .is("deleted_at", null)
      .maybeSingle();
    if (error) throw new Error(`read "${target.name}": ${error.message}`);
    if (!data) {
      console.log(`\n- ${target.name}: NOT FOUND, skipping`);
      continue;
    }
    const row = data as { id: string; name: string; enabled: boolean; definition: unknown };
    const current = parseAiFlowDefinition(row.definition);
    const changed = REVERT
      ? removeUnclaimedReminders(current)
      : addUnclaimedReminders(current, { detailsTemplate: target.detailsTemplate });

    if (changed.length === 0) {
      console.log(`\n- ${row.name}: already in the desired state`);
      continue;
    }

    let validated: AiFlowDefinition;
    try {
      validated = parseAiFlowDefinition(current);
    } catch (err) {
      if (err instanceof AiFlowValidationError) {
        console.error(`\n- ${row.name}: patched definition failed validation:`);
        for (const issue of err.issues) console.error(`    ${issue}`);
        process.exit(2);
      }
      throw err;
    }

    console.log(`\n- ${row.name} (id=${row.id}, enabled=${row.enabled})`);
    console.log(`    steps changed: ${changed.join(", ")}`);
    totalChanged += changed.length;
    ledgerDetails[row.name] = changed;

    if (!APPLY) continue;
    const { error: updErr } = await db
      .from("ai_flows")
      .update({ definition: validated })
      .eq("id", row.id);
    if (updErr) throw new Error(`update "${row.name}" failed: ${updErr.message}`);
  }

  if (totalChanged === 0) {
    console.log("\nNothing to do.");
    return;
  }
  if (!APPLY) {
    console.log(`\n[dry-run] ${totalChanged} step(s) would change. Re-run with --apply.`);
    return;
  }
  await recordOneshotApplied(db, {
    scriptPath: process.argv[1] ?? "amy-unclaimed-reminders-patch.ts",
    businessId: BUSINESS_ID,
    details: {
      mode: REVERT ? "revert" : "apply",
      rounds: AMY_REMINDER_ROUNDS,
      interval_minutes: AMY_REMINDER_INTERVAL_MINUTES,
      steps_by_flow: ledgerDetails
    }
  });
  console.log(`\nPatched ${totalChanged} route step(s) across ${targets.length} flow(s).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
