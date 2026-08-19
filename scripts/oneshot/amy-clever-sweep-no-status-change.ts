#!/usr/bin/env tsx
/**
 * One-shot: switch Amy's weekly Clever sweep from "We Spoke" to
 * "No Status Change", and drop the select that only the "We Spoke" path shows.
 *
 * Clever's status list is a FORWARD-ONLY progression from the card's current
 * stage. Read live 2026-08-18 in a signed-in browser: a card at "Tried Reaching
 * Out" offers "We Spoke"; a card already at "Spoke" does NOT. The weekly sweep
 * runs over EVERY active deal and most of Amy's 87-card book is past that
 * point, so the sweep as shipped would have failed its second action on the
 * majority of cards, one `failed` at a time, and updated almost nothing.
 *
 * "No Status Change" is the first option on every stage's list, and it is also
 * the truthful one for a weekly compliance ping. Choosing it also SHORTENS the
 * action list: the required "Did you schedule a time to meet in person?" select
 * is revealed by "We Spoke" and is never rendered here, so it is removed rather
 * than retargeted.
 *
 * The full option list, the two-card evidence and what is deliberately left
 * alone (the daily Chris flow keeps "We Spoke") are in
 * `amy-clever-sweep-no-status-change-definition.ts`.
 *
 * IDEMPOTENT: a second run finds nothing to change and exits 0 without writing.
 * REVERSIBLE: `--revert --apply` restores the stored previous definition.
 *
 * Usage:
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/amy-clever-sweep-no-status-change.ts            # dry run
 *   npx tsx scripts/oneshot/amy-clever-sweep-no-status-change.ts --apply
 *   npx tsx scripts/oneshot/amy-clever-sweep-no-status-change.ts --revert --apply
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
import { buildSweep } from "./amy-clever-sweep-no-status-change-definition";
import { recordOneshotApplied } from "./_ledger";

const DEFAULT_BUSINESS_ID = "621a5b0d-c2ad-449f-9d74-9d50e7b27fa3"; // Amy Laidlaw Real Estate
const SCRIPT = "amy-clever-sweep-no-status-change.ts";

/** Exact live flow name. Matched case-insensitively but otherwise verbatim. */
const WEEKLY_FLOW_NAME = "Clever Update Leads";

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
        `Clever flows present: ${rows
          .filter((r) => /clever/i.test(r.name))
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

  const weekly = pickFlow(rows, WEEKLY_FLOW_NAME);
  if (!weekly.enabled) {
    console.error(`"${weekly.name}" (${weekly.id}) is DISABLED. Enable it before or after applying.`);
  }

  // The DAILY (Chris) flow keeps "We Spoke" on purpose: it fires the day a lead
  // arrives, when the card is at "New" or "Tried Reaching Out" and that option
  // IS offered. Only the weekly sweep runs over cards at every stage.
  const built = [{ row: weekly, ...buildSweep(weekly.definition) }].filter(
    (b) => b.changes.length > 0
  );

  if (built.length === 0) {
    console.log("\nThe sweep already posts \"No Status Change\". Nothing to do.");
    return;
  }

  console.log("");
  for (const b of built) {
    console.log(`${b.row.name} (${b.row.id})`);
    for (const c of b.changes) console.log(`    ${c}`);

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
