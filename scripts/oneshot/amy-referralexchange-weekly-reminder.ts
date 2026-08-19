#!/usr/bin/env tsx
/**
 * One-shot: have Amy's ReferralExchange update schedule RE's OWN text reminder
 * seven days out, so the referral stops going quiet after arrival day.
 *
 * `re_update` posts once, on arrival day, and never again. A scheduled flow
 * cannot fix that: a `schedule` trigger produces no URL and
 * `browse_action.urlVar` takes no literal, so every portal write has to be
 * driven by a message carrying its own link, and RE sends no periodic nudge.
 *
 * What RE DOES send is a reminder it schedules for you. Step 3 of the same
 * "Leave an update" modal the flow already drives is "Schedule text reminder",
 * and its controls are a native date input plus three selects (no calendar
 * widget to walk). This adds five actions before the submit, on every update
 * step including the two inside the honesty gate's arms, setting 9:00 AM at
 * {{now.in7Days.iso}}.
 *
 * Seven days out rather than RE's one-click "Tomorrow morning" preset: the
 * preset would text Amy about every open referral EVERY DAY. Brian's call.
 *
 * This is deliberately a BOOTSTRAP. Scheduling the reminder is what makes RE
 * send a text nobody has read yet, and that text is the trigger a recurring
 * update flow needs. Authoring that trigger against guessed vendor copy is how
 * this account lost two flows for weeks, so the consumer is written once a real
 * reminder lands in `sms_inbound_jobs`.
 *
 * IDEMPOTENT: a step already carrying the pick button is skipped.
 * REVERSIBLE: `--revert --apply` restores the stored previous definition.
 *
 * Usage:
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/amy-referralexchange-weekly-reminder.ts            # dry run
 *   npx tsx scripts/oneshot/amy-referralexchange-weekly-reminder.ts --apply
 *   npx tsx scripts/oneshot/amy-referralexchange-weekly-reminder.ts --revert --apply
 *
 * Exit codes: 0 patched / no-op / dry-run, 1 Supabase error, 2 bad env or shape.
 */
import { pathToFileURL } from "node:url";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  AiFlowValidationError,
  parseAiFlowDefinition,
  type AiFlowDefinition
} from "@/lib/ai-flows/schema";
import { buildWithReminder } from "./amy-referralexchange-weekly-reminder-definition";
import { recordOneshotApplied } from "./_ledger";

const DEFAULT_BUSINESS_ID = "621a5b0d-c2ad-449f-9d74-9d50e7b27fa3"; // Amy Laidlaw Real Estate
const SCRIPT = "amy-referralexchange-weekly-reminder.ts";

/** Exact live flow name. Matched case-insensitively but otherwise verbatim. */
const FLOW_NAME = "ReferralExchange Lead";

function requireEnv(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback ?? "";
  if (!value) {
    console.error(`Missing ${name}`);
    process.exit(2);
  }
  return value;
}

function argValue(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}

type FlowRow = { id: string; name: string; enabled: boolean; definition: AiFlowDefinition };

/** Restore each flow's stored previous definition from the ledger. */
async function revert(db: SupabaseClient, businessId: string, apply: boolean): Promise<void> {
  const { data, error } = await db
    .from("applied_oneshots")
    .select("details,applied_at")
    .eq("business_id", businessId)
    .eq("script", SCRIPT)
    .order("applied_at", { ascending: false });
  if (error) {
    console.error(`Ledger read failed: ${error.message}`);
    process.exit(1);
  }
  const row = (data ?? []).find(
    (r) =>
      (r.details as { reverted?: boolean } | null)?.reverted !== true &&
      Array.isArray((r.details as { flows?: unknown[] } | null)?.flows)
  );
  if (!row) {
    console.error("No revertible ledger entry for this script and business.");
    process.exit(2);
  }
  const flows = (
    row.details as { flows: Array<{ id: string; name: string; previous: AiFlowDefinition }> }
  ).flows;
  console.log(`Reverting ${flows.length} flow(s) to the definitions stored ${row.applied_at}:`);
  for (const f of flows) console.log(`  ${f.name} (${f.id})`);
  if (!apply) {
    console.log("\n[dry-run] Nothing written. Re-run with --revert --apply.");
    return;
  }
  for (const f of flows) {
    const { error: upErr } = await db
      .from("ai_flows")
      .update({ definition: f.previous })
      .eq("id", f.id);
    if (upErr) {
      console.error(`Revert of ${f.name} failed: ${upErr.message}`);
      process.exit(1);
    }
  }
  await recordOneshotApplied(db, {
    scriptPath: process.argv[1] ?? SCRIPT,
    businessId,
    details: { reverted: true, flow_ids: flows.map((f) => f.id) }
  });
  console.log("\nReverted.");
}

/** Pick exactly one flow by name, or fail loudly rather than guess. */
function pickFlow(rows: readonly FlowRow[], name: string): FlowRow {
  const matches = rows.filter((r) => r.name.trim().toLowerCase() === name.toLowerCase());
  if (matches.length !== 1) {
    console.error(
      `Expected exactly one flow named "${name}", found ${matches.length}. ` +
        `Flows present: ${rows
          .filter((r) => /referral/i.test(r.name))
          .map((r) => `"${r.name}"`)
          .join(", ")}`
    );
    process.exit(2);
  }
  return matches[0];
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const isRevert = process.argv.includes("--revert");
  const businessId = argValue("business-id", DEFAULT_BUSINESS_ID);

  const db = createClient(
    requireEnv("NEXT_PUBLIC_SUPABASE_URL", process.env.SUPABASE_URL),
    requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false } }
  );

  if (isRevert) return await revert(db, businessId, apply);

  const { data, error } = await db
    .from("ai_flows")
    .select("id,name,enabled,definition")
    .eq("business_id", businessId);
  if (error) {
    console.error(`Read failed: ${error.message}`);
    process.exit(1);
  }
  const rows = (data ?? []) as FlowRow[];

  const flow = pickFlow(rows, FLOW_NAME);
  if (!flow.enabled) {
    console.error(`"${flow.name}" (${flow.id}) is DISABLED. Enable it before or after applying.`);
  }

  const { definition, changed } = buildWithReminder(flow.definition);
  const built = changed.length > 0 ? [{ row: flow, definition, changes: changed }] : [];

  if (built.length === 0) {
    console.log("\nEvery update step already schedules a reminder. Nothing to do.");
    return;
  }
  console.log(`\nAdding RE's own 7-day reminder to ${changed.length} update step(s).`);

  console.log("");
  for (const b of built) {
    console.log(`${b.row.name} (${b.row.id})`);
    for (const c of b.changes) console.log(`    + ${c}`);

    // Validate before any write: a definition the authoring validator rejects
    // must never reach a live row.
    try {
      parseAiFlowDefinition(b.definition);
    } catch (err) {
      console.error(`\n"${b.row.name}" would become INVALID, aborting before any write:`);
      if (err instanceof AiFlowValidationError) for (const i of err.issues) console.error(`  - ${i}`);
      else console.error(err);
      process.exit(2);
    }
  }

  if (!apply) {
    console.log("\n[dry-run] Nothing written. Re-run with --apply.");
    return;
  }

  for (const b of built) {
    const { error: upErr } = await db
      .from("ai_flows")
      .update({ definition: b.definition })
      .eq("id", b.row.id);
    if (upErr) {
      console.error(`Update of ${b.row.name} failed: ${upErr.message}`);
      process.exit(1);
    }
  }
  await recordOneshotApplied(db, {
    scriptPath: process.argv[1] ?? SCRIPT,
    businessId,
    details: {
      flows: built.map((b) => ({
        id: b.row.id,
        name: b.row.name,
        changes: b.changes,
        previous: b.row.definition
      }))
    }
  });
  console.log(`\nUpdated ${built.length} flow(s).`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
