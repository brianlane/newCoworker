#!/usr/bin/env tsx
/**
 * One-shot: stop Amy's HomeLight portal-note step dying on an exact
 * `click_text` of the full lead name, and stop the Referrals nav click
 * depending on a bare `/referrals` href that Next.js aborts.
 *
 * INCIDENT, 2026-09-14. Four HomeLight Referral runs failed terminal at
 * `hl_portal_note` (current_step 85) after the rest of the lead work:
 *
 *   - e09b3f18 Vince Nguyen, attempt 5:
 *     click_text "Vince Nguyen": no matching control
 *     Abort fetching component for route: "/referrals/page/[page]"
 *   - 62ecd626 Brandi V.: click_text "Brandi V.": no matching control, same abort
 *   - 89268fa7 Sharon I.: click_text "Sharon I.": no matching control
 *   - d9c840e3 Brandi V.: click_selector add-note button Timeout 10000ms
 *     (Loading initial props cancelled)
 *
 * The 404s in those messages are HomeLight's usual `_next` / GA noise. The
 * abort is not: the live list is `/referrals/page/1`, and the Sep 12 nav
 * patch still clicked exact `a[href="/referrals"]`.
 *
 * The name click is the other break. The claim card / SMS often carry a full
 * name ("Vince Nguyen") while the list shows the abbreviated form
 * ("Vince N."), so exact `click_text "{{vars.lead_name}}"` finds no control.
 * Sonia R. (Sep 13) succeeded because her `lead_name` already WAS "Sonia R.".
 *
 * WHAT THIS CHANGES. Structure untouched (no step added, removed, or moved):
 *   1. Nav selector matches `/referrals` OR `/referrals/page/...`, not claim
 *      URLs (`href^="/referrals"` would also hit `/referrals/claim`).
 *   2. Row click is HomeLight's `referralsList-row` filtered by the client
 *      name cell `:has-text("{{vars.lead_first_name}}")`. Playwright
 *      `:has-text` is a substring, so "Vince" hits both forms. Clicking the
 *      row (not a name span) is what opens the drawer, which is the add-note
 *      timeout.
 *   3. Inner arm gates on `lead_first_name notEquals none` so an empty
 *      `:has-text("")` cannot match every row.
 *
 * Do not requeue those runs: it would redo outreach. Idempotent, validated
 * through parseAiFlowDefinition, REFUSES when the note form actions are not
 * the known sequence, dry-run by default, ledger-recorded with `--revert`.
 *
 * Usage:
 *   npx tsx scripts/oneshot/amy-homelight-portal-note-row.ts            # dry run
 *   npx tsx scripts/oneshot/amy-homelight-portal-note-row.ts --apply
 *   npx tsx scripts/oneshot/amy-homelight-portal-note-row.ts --revert --apply
 *
 * Required env: NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY.
 * Business id: --business-id <uuid> or AIFLOW_SEED_BUSINESS_ID (defaults to Amy's).
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
import { loadEnv } from "../../debug/_shared.ts";
import {
  NAMED_ARM_CONDITION,
  NAMED_ARM_ID,
  NOTE_STEP_ID,
  findNamedArm,
  findPortalNoteStep,
  patchPortalNoteRow
} from "./amy-homelight-portal-note-definition";
import { recordOneshotApplied } from "./_ledger";

loadEnv();

const DEFAULT_BUSINESS_ID = "621a5b0d-c2ad-449f-9d74-9d50e7b27fa3"; // Amy Laidlaw Real Estate
const SCRIPT = "amy-homelight-portal-note-row.ts";
const FLOW_NAME = "HomeLight Referral";

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

function pickFlow(rows: readonly FlowRow[], name: string): FlowRow {
  const matches = rows.filter((r) => r.name.trim().toLowerCase() === name.toLowerCase());
  if (matches.length !== 1) {
    console.error(
      `Expected exactly one flow named "${name}", found ${matches.length}. ` +
        `Flows present: ${rows
          .filter((r) => /homelight/i.test(r.name))
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
  const flow = pickFlow((data ?? []) as FlowRow[], FLOW_NAME);
  if (!flow.enabled) {
    console.error(`"${flow.name}" (${flow.id}) is DISABLED. Enable it before or after applying.`);
  }

  const previous = JSON.parse(JSON.stringify(flow.definition)) as AiFlowDefinition;
  const next = JSON.parse(JSON.stringify(flow.definition)) as AiFlowDefinition;
  let edits: string[] = [];
  try {
    edits = patchPortalNoteRow(next);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(2);
  }

  if (edits.length === 0) {
    const note = findPortalNoteStep(flow.definition);
    const arm = findNamedArm(flow.definition);
    console.log(`\n${NOTE_STEP_ID} already uses the row data-test + first-name click. Nothing to do.`);
    console.log(`Nav: ${note?.actions[0]?.kind} "${note?.actions[0]?.target}"`);
    console.log(`Row: ${note?.actions[1]?.kind} "${note?.actions[1]?.target}"`);
    console.log(`${NAMED_ARM_ID} gate: ${JSON.stringify(arm?.condition ?? NAMED_ARM_CONDITION)}`);
    return;
  }

  try {
    parseAiFlowDefinition(next);
  } catch (err) {
    console.error(`\n"${flow.name}" would become INVALID, aborting before any write:`);
    if (err instanceof AiFlowValidationError) for (const i of err.issues) console.error(`  - ${i}`);
    else console.error(err);
    process.exit(2);
  }

  console.log(`\n${flow.name} (${flow.id})`);
  for (const e of edits) console.log(`    ${e}`);

  if (!apply) {
    console.log("\n[dry-run] Nothing written. Re-run with --apply.");
    return;
  }

  const { error: upErr } = await db.from("ai_flows").update({ definition: next }).eq("id", flow.id);
  if (upErr) {
    console.error(`Update of ${flow.name} failed: ${upErr.message}`);
    process.exit(1);
  }

  await recordOneshotApplied(db, {
    scriptPath: process.argv[1] ?? SCRIPT,
    businessId,
    details: {
      flows: [{ id: flow.id, name: flow.name, previous, changes: edits }]
    }
  });
  console.log("\nApplied.");
}

const isDirect = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isDirect) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
