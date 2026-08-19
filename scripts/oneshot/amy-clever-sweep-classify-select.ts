#!/usr/bin/env tsx
/**
 * One-shot: Amy's weekly Clever sweep answers the classification select on
 * the cards whose update modal requires it, and skips it everywhere else.
 *
 * The 2026-08-19 chained sweep drained 6 of 34 cards and stopped at its
 * no_progress terminal: at least 6 distinct cards' modals carry a REQUIRED
 * "How would you classify this customer?" select the flow never answered, so
 * "Submit Update" stayed disabled and those cards failed every pass. This
 * inserts `select_option[optional]` = "Active/progressing" before the submit;
 * `optional` (added the same day) makes the render service skip it on cards
 * whose modal lacks the select. Full evidence and the honesty argument for
 * the chosen value live in `amy-clever-sweep-classify-select-definition.ts`.
 *
 * Apply AFTER the engine deploy and the aiflow-render redeploy (both must
 * know the `optional` field; an older sidecar treats the select as mandatory
 * and fails the cards that lack it, which is worse than today).
 *
 * IDEMPOTENT: a second run finds nothing to change and exits 0 without writing.
 * REVERSIBLE: `--revert --apply` restores the stored previous definition.
 *
 * Usage:
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/amy-clever-sweep-classify-select.ts            # dry run
 *   npx tsx scripts/oneshot/amy-clever-sweep-classify-select.ts --apply
 *   npx tsx scripts/oneshot/amy-clever-sweep-classify-select.ts --revert --apply
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
import { buildClassifySelect } from "./amy-clever-sweep-classify-select-definition";
import { recordOneshotApplied } from "./_ledger";

const DEFAULT_BUSINESS_ID = "621a5b0d-c2ad-449f-9d74-9d50e7b27fa3"; // Amy Laidlaw Real Estate
const SCRIPT = "amy-clever-sweep-classify-select.ts";
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

/** Restore the flow's stored previous definition from the ledger. */
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
    const { data: updated, error: upErr } = await db
      .from("ai_flows")
      .update({ definition: f.previous })
      .eq("id", f.id)
      .select("id");
    if (upErr || (updated ?? []).length !== 1) {
      console.error(`Revert of ${f.name} failed: ${upErr?.message ?? "no row matched"}`);
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
  const built = buildClassifySelect(weekly.definition);
  if (built.issues.length > 0) {
    console.error(`\n"${weekly.name}" (${weekly.id}) does not have the expected shape:`);
    for (const i of built.issues) console.error(`  - ${i}`);
    process.exit(2);
  }
  if (built.changes.length === 0) {
    console.log("\nThe sweep already answers the classification select. Nothing to do.");
    return;
  }

  console.log(`\n${weekly.name} (${weekly.id})`);
  for (const c of built.changes) console.log(`    ${c}`);

  try {
    parseAiFlowDefinition(built.definition);
  } catch (err) {
    console.error(`\n"${weekly.name}" would become INVALID, aborting before any write:`);
    if (err instanceof AiFlowValidationError) for (const i of err.issues) console.error(`  - ${i}`);
    else console.error(err);
    process.exit(2);
  }

  if (!apply) {
    console.log("\n[dry-run] Nothing written. Re-run with --apply.");
    return;
  }

  const { data: updated, error: upErr } = await db
    .from("ai_flows")
    .update({ definition: built.definition })
    .eq("id", weekly.id)
    .select("id");
  if (upErr || (updated ?? []).length !== 1) {
    console.error(`Update of ${weekly.name} failed: ${upErr?.message ?? "no row matched"}`);
    process.exit(1);
  }
  await recordOneshotApplied(db, {
    scriptPath: process.argv[1] ?? SCRIPT,
    businessId,
    details: {
      flows: [
        {
          id: weekly.id,
          name: weekly.name,
          changes: built.changes,
          previous: weekly.definition
        }
      ]
    }
  });
  console.log("\nUpdated 1 flow.");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
