#!/usr/bin/env tsx
/**
 * One-shot: make Amy's weekly Clever sweep alert report what the sweep
 * MEASURED, instead of backlog arithmetic that assumed one capped pass.
 *
 * The engine now chains capped forEachLink passes until the portal's
 * "Needs Action" list is drained, and publishes the totals as
 * `{{vars.update_each_updated}}` / `{{vars.update_each_left}}`. This patch
 * points the flow's alert chain at those vars:
 *
 *   - `sweep_fits_check` becomes `less_than(update_each_left, 1)`, i.e.
 *     "did the sweep leave anything", instead of "would 41 fit in 6".
 *   - `sweep_remainder` (backlog minus 6) is removed; nothing consumes it.
 *   - `capacity_notify` texts the measured updated/left counts, so a clean
 *     sweep of any backlog size stays SILENT, which is the goal state.
 *
 * Evidence and the full design are in
 * `amy-clever-sweep-measured-alert-definition.ts`. Apply AFTER the engine
 * deploy (the worker must be writing the measured vars) and after the
 * aiflow-render redeploy on Amy's box (the sidecar must be reporting
 * `remaining`, or the sweep stays a single pass, with the alert now at least
 * reporting the truth of that single pass).
 *
 * IDEMPOTENT: a second run finds nothing to change and exits 0 without writing.
 * REVERSIBLE: `--revert --apply` restores the stored previous definition.
 *
 * Usage:
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/amy-clever-sweep-measured-alert.ts            # dry run
 *   npx tsx scripts/oneshot/amy-clever-sweep-measured-alert.ts --apply
 *   npx tsx scripts/oneshot/amy-clever-sweep-measured-alert.ts --revert --apply
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
import { buildMeasuredAlert } from "./amy-clever-sweep-measured-alert-definition";
import { recordOneshotApplied } from "./_ledger";

const DEFAULT_BUSINESS_ID = "621a5b0d-c2ad-449f-9d74-9d50e7b27fa3"; // Amy Laidlaw Real Estate
const SCRIPT = "amy-clever-sweep-measured-alert.ts";

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
  if (!weekly.enabled) {
    console.error(`"${weekly.name}" (${weekly.id}) is DISABLED. Enable it before or after applying.`);
  }

  const built = buildMeasuredAlert(weekly.definition);
  if (built.issues.length > 0) {
    console.error(`\n"${weekly.name}" (${weekly.id}) does not have the expected alert chain:`);
    for (const i of built.issues) console.error(`  - ${i}`);
    console.error("Aborting before any write; read the live definition and update the builder.");
    process.exit(2);
  }
  if (built.changes.length === 0) {
    console.log("\nThe alert already reports the measured totals. Nothing to do.");
    return;
  }

  console.log(`\n${weekly.name} (${weekly.id})`);
  for (const c of built.changes) console.log(`    ${c}`);

  // Validate before any write: a definition the authoring validator rejects
  // must never reach a live row. This also proves the measured vars are
  // registered for templating (the validator rejects unproduced vars).
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
