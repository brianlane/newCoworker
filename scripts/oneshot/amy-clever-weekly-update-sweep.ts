#!/usr/bin/env tsx
/**
 * One-shot: make Amy's Clever weekly update sweep actually run, and make its
 * shortfall audible.
 *
 * THE BUG, in one line: the sweep listens to `3142707635`; Clever texts from
 * `3142077635`. A transposed digit has kept "Clever Update Leads" at zero runs
 * since it was seeded, so the weekly reminder falls through to
 * "Clever Update Leads (Chris)" instead, which filters the card list down to the
 * leads NAMED in the message. The weekly reminder names nobody, so the filter
 * matches nothing and the run reports success:
 *
 *   2026-08-12  "29 Active Deals awaiting update"
 *     [1] extract_text   lead_names=""
 *     [2] browse_action  forEach {items: 0, succeeded: 0}    run status: done
 *
 * Zero of 29 active deals updated, green. Same on 2026-08-05 with 7 deals.
 * Clever decides how many leads Amy receives from exactly this compliance
 * signal, so this is not cosmetic.
 *
 * WHAT THIS WRITES (all to live `ai_flows` rows for one business):
 *
 *   Clever Update Leads          from_matches -> 3142077635
 *                                + contains "awaiting update"
 *                                note -> honest weekly wording
 *                                + backlog read, 2 math steps, capacity branch
 *   Clever Update Leads (Chris)  + contains "summary of the new customers"
 *
 * BOTH flows must change together. Fixing only the sweep's sender would make
 * things WORSE: both flows would then match both messages, and the sweep would
 * blanket-update Amy's entire active book every single day.
 *
 * The rationale for each edit, the measured 100s Cloudflare ceiling, and the two
 * things deliberately left alone (the "We Spoke" status click, and chaining
 * passes to cover the whole backlog) are documented at length in
 * `amy-clever-weekly-update-sweep-definition.ts`.
 *
 * IDEMPOTENT: a second run finds nothing to change and exits 0 without writing.
 * REVERSIBLE: `--revert --apply` restores each flow's exact previous definition
 * from the ledger, the same mechanism the other Amy appliers use.
 *
 * Usage:
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/amy-clever-weekly-update-sweep.ts            # dry run
 *   npx tsx scripts/oneshot/amy-clever-weekly-update-sweep.ts --apply
 *   npx tsx scripts/oneshot/amy-clever-weekly-update-sweep.ts --revert --apply
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
import { buildDaily, buildWeeklySweep } from "./amy-clever-weekly-update-sweep-definition";
import { recordOneshotApplied } from "./_ledger";

const DEFAULT_BUSINESS_ID = "621a5b0d-c2ad-449f-9d74-9d50e7b27fa3"; // Amy Laidlaw Real Estate
const SCRIPT = "amy-clever-weekly-update-sweep.ts";

/** Exact live flow names. Matched case-insensitively but otherwise verbatim. */
const WEEKLY_FLOW_NAME = "Clever Update Leads";
const DAILY_FLOW_NAME = "Clever Update Leads (Chris)";

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
  const daily = pickFlow(rows, DAILY_FLOW_NAME);

  // Both flows are useless while disabled, and a disabled sweep would make the
  // "fixed" claim false. Say so rather than write and report success.
  for (const f of [weekly, daily]) {
    if (!f.enabled) {
      console.error(`"${f.name}" (${f.id}) is DISABLED. Enable it before or after applying.`);
    }
  }

  const built = [
    { row: weekly, ...buildWeeklySweep(weekly.definition) },
    { row: daily, ...buildDaily(daily.definition) }
  ].filter((b) => b.changes.length > 0);

  if (built.length === 0) {
    console.log("\nBoth flows already say this. Nothing to do (already applied).");
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
