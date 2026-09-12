#!/usr/bin/env tsx
/**
 * One-shot: stop Amy's HomeLight portal-note step dying on `click_text
 * "Referrals"` after the run has already done the lead work.
 *
 * INCIDENT, 2026-09-11 22:30 UTC, run 39f53cb7 (Annalie H., $379,205). The
 * HomeLight Referral flow claimed the lead, offered it, texted Amy, ran the
 * late-contact ladder, and then failed at its LAST step (`hl_portal_note`)
 * with `click_text "Referrals": no matching control on the page`. That pair of
 * rows is what showed up on the admin System Errors card. The 404 and the
 * aborted Google Analytics posts in the same message are HomeLight's usual
 * noise (identical on a healthy live probe).
 *
 * The saved failure screenshot and HTML both showed the header link
 * `<a href="/referrals">Referrals</a>` on a logged-in claim page. A live
 * probe of the same shortlink the next day clicked that text and landed on
 * `/referrals/page/1`. So the control was not gone: `click_text` spent its 5s
 * appear wait before the header finished hydrating (settlePage returns once
 * the body has text; the claim copy paints first). The run had been parked
 * 3.5 hours, so this was a fresh login, not a mid-session click.
 *
 * WHAT THIS CHANGES. Replaces that first action with
 * `click_selector nav[data-test="navbar"] a[href="/referrals"]`. HomeLight's
 * own href is the handle, and Playwright's selector click waits the full
 * action timeout for visibility instead of the shorter text-appear window.
 * The rest of the note sequence is untouched. The matching appear-wait bump
 * (5s to 15s) lives in vps/aiflow-render and needs a box redeploy.
 *
 * Structure is untouched: no step is added, removed, or moved, so parked
 * runs resume as before. Idempotent, validated through parseAiFlowDefinition,
 * REFUSES when the first action is neither the legacy text click nor the new
 * selector, dry-run by default, ledger-recorded with `--revert`.
 *
 * Usage:
 *   npx tsx scripts/oneshot/amy-homelight-portal-note-nav.ts            # dry run
 *   npx tsx scripts/oneshot/amy-homelight-portal-note-nav.ts --apply
 *   npx tsx scripts/oneshot/amy-homelight-portal-note-nav.ts --revert --apply
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
import {
  LEGACY_REFERRALS_CLICK,
  NOTE_STEP_ID,
  REFERRALS_NAV_SELECTOR,
  findPortalNoteStep,
  patchPortalNoteNav
} from "./amy-homelight-portal-note-definition";
import { recordOneshotApplied } from "./_ledger";

const DEFAULT_BUSINESS_ID = "621a5b0d-c2ad-449f-9d74-9d50e7b27fa3"; // Amy Laidlaw Real Estate
const SCRIPT = "amy-homelight-portal-note-nav.ts";
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
  let changed = false;
  try {
    changed = patchPortalNoteNav(next);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(2);
  }

  if (!changed) {
    const note = findPortalNoteStep(flow.definition);
    console.log(
      `\n${NOTE_STEP_ID} already clicks ${REFERRALS_NAV_SELECTOR}. Nothing to do (already applied).`
    );
    console.log(`First action: ${note?.actions[0]?.kind} "${note?.actions[0]?.target}"`);
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

  const after = findPortalNoteStep(next);
  console.log(`\n${flow.name} (${flow.id})`);
  console.log(
    `    ${NOTE_STEP_ID}: ${LEGACY_REFERRALS_CLICK.kind} "${LEGACY_REFERRALS_CLICK.target}"` +
      ` -> ${after?.actions[0]?.kind} "${after?.actions[0]?.target}"`
  );

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
      flows: [{ id: flow.id, name: flow.name, previous }]
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
