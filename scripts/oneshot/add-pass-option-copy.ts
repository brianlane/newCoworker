#!/usr/bin/env tsx
/**
 * One-shot: bring every route_to_team offer in line with the universal
 * claim/pass digits, in place (idempotent).
 *
 * 1. HomeLight fix: the offer's "Reply 1 to confirm you're taking it by ..."
 *    line predates the pass option (the flow was pinned no-pass with a
 *    "2 with a timeframe" claim). Now that "1" / "1, <ETA>" is the universal
 *    claim and "2" is the pass everywhere, rewrite it to
 *    "Reply 1 to claim or 2 to pass by ..." so HomeLight reads like the other
 *    flows.
 *
 * 2. Pass-reason hint: every offer that advertises "2 to pass" gets one short
 *    line advertising the optional annotated form —
 *    `Passing? You can reply "2, <reason>" to tell us why (e.g. "2, out of town").`
 *    The engine (telnyx-sms-inbound `tryAgentPassWithReason` + ai-flow-worker)
 *    records the reason and appends it to the owner-fallback notice.
 *
 * Patches the existing rows (no re-seed) so any manual edits are preserved, and
 * re-validates each modified definition through the SAME parseAiFlowDefinition
 * the dashboard uses before writing. Dry-run by default; prints the
 * before/after definition of each changed flow for rollback.
 *
 * Usage:
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/add-pass-option-copy.ts            # dry run
 *   npx tsx scripts/oneshot/add-pass-option-copy.ts --apply    # write
 *
 * Required env: NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY.
 * Business id: --business-id <uuid> or AIFLOW_SEED_BUSINESS_ID (defaults to Amy's).
 *
 * Exit codes: 0 patched/no-op/dry-run · 1 Supabase error · 2 bad env/arg or invalid definition.
 */
import { pathToFileURL } from "node:url";
import { createClient } from "@supabase/supabase-js";
import {
  parseAiFlowDefinition,
  AiFlowValidationError
} from "@/lib/ai-flows/schema";

type Args = { apply: boolean; businessId: string | null };

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { apply: false, businessId: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") args.apply = true;
    else if (a === "--business-id") args.businessId = argv[++i] ?? null;
    else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

const DEFAULT_BUSINESS_ID = "621a5b0d-c2ad-449f-9d74-9d50e7b27fa3";

/** The legacy HomeLight confirm phrasing (no pass option advertised). */
const HOMELIGHT_CONFIRM_PHRASE = "Reply 1 to confirm you're taking it by";
/** Its replacement — same claim/pass digits as every other flow. */
const CLAIM_OR_PASS_PHRASE = "Reply 1 to claim or 2 to pass by";

/**
 * The optional pass-reason hint. Doubles as the idempotency marker
 * (`"2, <reason>"` appears only in this line).
 */
export const PASS_REASON_HINT_LINE =
  'Passing? You can reply "2, <reason>" to tell us why (e.g. "2, out of town").';

type Step = Record<string, unknown> & { id?: string; type?: string };
type Definition = { steps?: Step[] } & Record<string, unknown>;

/**
 * Rewrite the legacy HomeLight confirm line to the universal claim/pass copy
 * and append the pass-reason hint to every offer that advertises "2 to pass".
 * Idempotent. Returns whether anything changed.
 */
export function addPassOptionCopy(def: Definition): boolean {
  let changed = false;
  for (const step of def.steps ?? []) {
    if (step.type !== "route_to_team") continue;
    const offer = typeof step.offerTemplate === "string" ? step.offerTemplate : "";
    if (!offer) continue;

    let next = offer;
    if (next.includes(HOMELIGHT_CONFIRM_PHRASE)) {
      next = next.replaceAll(HOMELIGHT_CONFIRM_PHRASE, CLAIM_OR_PASS_PHRASE);
    }
    if (next.includes("2 to pass") && !next.includes('"2, <reason>"')) {
      next = `${next}\n${PASS_REASON_HINT_LINE}`;
    }
    if (next !== offer) {
      step.offerTemplate = next;
      changed = true;
    }
  }
  return changed;
}

function requireEnv(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (!v) {
    console.error(`Missing required env: ${name}`);
    process.exit(2);
  }
  return v;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const supabaseUrl = requireEnv("NEXT_PUBLIC_SUPABASE_URL", process.env.SUPABASE_URL);
  const serviceKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  const businessId =
    args.businessId ?? process.env.AIFLOW_SEED_BUSINESS_ID ?? DEFAULT_BUSINESS_ID;

  const db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  const { data: rows, error } = await db
    .from("ai_flows")
    .select("id, name, definition")
    .eq("business_id", businessId)
    .order("name");
  if (error) {
    console.error(`Read failed: ${error.message}`);
    process.exit(1);
  }

  let changedCount = 0;
  for (const row of (rows ?? []) as Array<{ id: string; name: string; definition: Definition }>) {
    const def = JSON.parse(JSON.stringify(row.definition)) as Definition;
    const before = JSON.stringify(row.definition);
    if (!addPassOptionCopy(def)) continue;

    // Re-validate the patched definition exactly like the dashboard/CRUD path.
    try {
      parseAiFlowDefinition(def);
    } catch (err) {
      console.error(`\nFlow "${row.name}" (${row.id}) would become INVALID — skipping:`);
      if (err instanceof AiFlowValidationError) for (const i of err.issues) console.error(`  - ${i}`);
      else console.error(err);
      process.exit(2);
    }

    changedCount += 1;
    console.log(`\n=== ${row.name} (${row.id}) ===`);
    console.log(`  BEFORE: ${before}`);
    console.log(`  AFTER : ${JSON.stringify(def)}`);

    if (args.apply) {
      const { error: upErr } = await db
        .from("ai_flows")
        .update({ definition: def })
        .eq("id", row.id);
      if (upErr) {
        console.error(`Update failed for ${row.id}: ${upErr.message}`);
        process.exit(1);
      }
      console.log("  -> updated.");
    }
  }

  if (changedCount === 0) {
    console.log("\nNo flows needed changes (already patched).");
  } else if (!args.apply) {
    console.log(`\n[dry-run] ${changedCount} flow(s) would change. Re-run with --apply to write.`);
  } else {
    console.log(`\nPatched ${changedCount} flow(s).`);
  }
}

// Run only when executed directly (not when imported by unit tests, which
// exercise the exported pure helpers above).
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
