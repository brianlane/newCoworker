#!/usr/bin/env tsx
/**
 * One-shot: relabel the price in the Clever buyer live-transfer whisper so a
 * missed extraction reads as a fact instead of gibberish.
 *
 * Fleet fallback-composition audit, Aug 27 2026. The buyer connect path's
 * `reachTeammate.preSmsTemplate` (three sites in "Clever Lead - Accept")
 * composes "looking around {{vars.lead_address}} at about {{vars.price}}."
 * The `price` field falls back to the literal 'none' (13 of the last 50 runs
 * held the fallback), so the teammate picking up a LIVE transfer would read
 * "at about none" in the whisper. It has never actually fired (the buyer
 * connect path has been dormant), which is exactly the moment to fix it.
 *
 * The whisper is team-facing, so the fix is the label style from Amy's
 * cadence fix (PR #1673): "looking around X. Budget: {{vars.price}}." reads
 * correctly whether price is "$450,000" or "none". Spoken lead-facing copy is
 * untouched.
 *
 * Template-only: no step is added, removed, or moved, so flat step indices
 * are unchanged and parked runs are safe (same guarantee the timezone patch
 * documented). Matched as a whole phrase: a whisper that drifted from the
 * expected wording is reported and left alone rather than half-rewritten.
 *
 * Idempotent, dry-run by default, validates through parseAiFlowDefinition,
 * prints the previous definition for rollback, records in applied_oneshots.
 *
 * Usage:
 *   npx tsx scripts/oneshot/patch-clever-accept-whisper-budget.ts --business <uuid>
 *   npx tsx scripts/oneshot/patch-clever-accept-whisper-budget.ts --business <uuid> --apply
 */
import { createClient } from "@supabase/supabase-js";
import { pathToFileURL } from "node:url";
import { parseAiFlowDefinition } from "../../src/lib/ai-flows/schema";
import { recordOneshotApplied } from "./_ledger";

export const CLEVER_ACCEPT_FLOW_NAME = "Clever Lead - Accept";

/** The pre-fix phrase, anchored on its tail so only the whisper matches. */
export const WHISPER_PRICE_PRE_FIX = " at about {{vars.price}}.\nThey are on the line now.";
export const WHISPER_PRICE_FIXED = ". Budget: {{vars.price}}.\nThey are on the line now.";

export type TransformResult = {
  definition: Record<string, unknown>;
  changed: boolean;
  notes: string[];
};

/**
 * Replace the phrase in every `preSmsTemplate`, wherever it nests. Pure and
 * exported for tests/oneshot-fallback-copy-patches.test.ts.
 */
export function relabelWhisperBudget(input: unknown): TransformResult {
  const definition = structuredClone(input) as Record<string, unknown>;
  const notes: string[] = [];
  let patched = 0;
  let alreadyFixed = 0;

  const visit = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      node.forEach((v, i) => visit(v, `${path}[${i}]`));
      return;
    }
    if (!node || typeof node !== "object") return;
    const obj = node as Record<string, unknown>;
    for (const [key, value] of Object.entries(obj)) {
      const at = path ? `${path}.${key}` : key;
      if (key === "preSmsTemplate" && typeof value === "string") {
        if (value.includes(WHISPER_PRICE_PRE_FIX)) {
          obj[key] = value.split(WHISPER_PRICE_PRE_FIX).join(WHISPER_PRICE_FIXED);
          patched++;
          notes.push(`${at}: price is a labelled Budget now`);
        } else if (value.includes(WHISPER_PRICE_FIXED)) {
          alreadyFixed++;
        }
        continue;
      }
      visit(value, at);
    }
  };
  visit(definition, "");

  const changed = patched > 0;
  if (!changed) {
    notes.push(
      alreadyFixed > 0
        ? `already patched (${alreadyFixed} whisper site(s) carry the Budget label)`
        : "pattern not found in any preSmsTemplate: the whisper copy drifted, resolve by hand"
    );
  }
  return { definition, changed, notes };
}

type Args = { apply: boolean; businessId: string | null };

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { apply: false, businessId: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") args.apply = true;
    else if (a === "--business") args.businessId = argv[++i] ?? null;
    else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!url || !key) {
    console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
    process.exit(2);
  }
  if (!args.businessId || !/^[0-9a-f-]{36}$/i.test(args.businessId)) {
    console.error("Pass --business <uuid>");
    process.exit(2);
  }
  const db = createClient(url, key, { auth: { persistSession: false } });

  const { data: row, error } = await db
    .from("ai_flows")
    .select("id, name, enabled, definition")
    .eq("business_id", args.businessId)
    .eq("name", CLEVER_ACCEPT_FLOW_NAME)
    .maybeSingle();
  if (error) {
    console.error(`Read failed: ${error.message}`);
    process.exit(1);
  }
  if (!row) {
    console.error(`No "${CLEVER_ACCEPT_FLOW_NAME}" flow for ${args.businessId}`);
    process.exit(1);
  }

  console.log(`=== ${CLEVER_ACCEPT_FLOW_NAME} (${row.id}, enabled=${row.enabled}) ===`);
  console.log(`Previous definition (for rollback):\n${JSON.stringify(row.definition)}`);

  const result = relabelWhisperBudget(row.definition);
  for (const note of result.notes) console.log(`  - ${note}`);
  if (!result.changed) return;

  try {
    parseAiFlowDefinition(result.definition);
  } catch (e) {
    console.error(`  ! Patched definition is invalid: ${(e as Error).message}`);
    process.exit(1);
  }

  if (!args.apply) {
    console.log("  [dry-run] Not writing. Re-run with --apply.");
    return;
  }

  const { error: writeErr } = await db
    .from("ai_flows")
    .update({ definition: result.definition })
    .eq("id", row.id);
  if (writeErr) {
    console.error(`  ! Write failed: ${writeErr.message}`);
    process.exit(1);
  }
  console.log("  Written.");

  await recordOneshotApplied(db, {
    scriptPath: process.argv[1],
    businessId: args.businessId,
    details: { flow: `${CLEVER_ACCEPT_FLOW_NAME} (${row.id})`, fix: "whisper Budget label" }
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
