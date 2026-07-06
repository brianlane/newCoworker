#!/usr/bin/env tsx
/**
 * One-shot: SIMPLIFY a tenant's route_to_team claim options down to the
 * universal "1" claim digit, in place (idempotent).
 *
 * The engine now treats "1" as the universal claim digit everywhere:
 *   - "1"          → claims a live offer, OR retroactively claims a lapsed,
 *                    still-unclaimed offer (late claim) — seamless, no extra digit.
 *   - "1, <ETA>"   → same claim, live or late, with the stated timeframe
 *                    surfaced to the owner (what claimTimeframeOption's digit did).
 *   - "2"          → pass (round-robin flows), unchanged.
 *   - "86"         → retroactive UNCLAIM (release a claimed lead), unchanged.
 *
 * That makes the separate "Reply 3 with a timeframe" (claimTimeframeOption) and
 * "Lapsed lead? Reply 4, <ETA>" (lateClaimOption) options redundant, so this
 * script removes them from every route_to_team step:
 *   1. drops the appended "with a timeframe to claim" offer line,
 *   2. drops the appended "triple tap this lead" retro offer line,
 *   3. deletes claimTimeframeOption + lateClaimOption from the step, and
 *   4. where a timeframe option was advertised, appends the universal ETA hint
 *      (`You can also reply "1, <ETA>" ...`) so the affordance stays visible.
 *
 * Supersedes the option-appending patches from
 * scripts/oneshot/update-dave-routed-aiflows.ts (which no longer adds them).
 * The engine still honors legacy stamped digits on runs already in flight.
 *
 * Patches the existing rows (no re-seed) so any manual edits are preserved, and
 * re-validates each modified definition through the SAME parseAiFlowDefinition
 * the dashboard uses before writing. Dry-run by default; prints the before/after
 * definition of each changed flow for rollback.
 *
 * Usage:
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/simplify-claim-options.ts            # dry run
 *   npx tsx scripts/oneshot/simplify-claim-options.ts --apply    # write
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

/** Marker of the appended live "accept with a timeframe" option line. */
const TIMEFRAME_LINE_MARKER = "with a timeframe to claim";
/**
 * Marker of the appended retro/late-claim option line. Deliberately includes
 * "this lead" so authored copy like Realtor.com's "ETA of when you can please
 * triple tap? Thanks." is never stripped.
 */
const RETRO_LINE_MARKER = "triple tap this lead";

/**
 * The universal ETA hint appended where a timeframe option used to be
 * advertised — same affordance, now on the one claim digit. Doubles as the
 * idempotency marker (`"1, <ETA>"` appears only in this line).
 */
export const CLAIM_ETA_HINT_LINE =
  'You can also reply "1, <ETA>" to claim and tell us when you\'ll reach out ' +
  '(e.g. "1, 20 min").';

type Step = Record<string, unknown> & { id?: string; type?: string };
type Definition = { steps?: Step[] } & Record<string, unknown>;

/**
 * Strip the redundant claim options from every route_to_team step of one
 * definition: remove the appended timeframe + retro offer lines, delete the
 * claimTimeframeOption/lateClaimOption digits, and (only where a timeframe
 * option was advertised) append the universal "1, <ETA>" hint so the ETA
 * affordance stays visible. Idempotent. Returns whether anything changed.
 */
export function simplifyClaimOptions(def: Definition): boolean {
  let changed = false;
  for (const step of def.steps ?? []) {
    if (step.type !== "route_to_team") continue;

    const offer = typeof step.offerTemplate === "string" ? step.offerTemplate : "";
    if (offer) {
      const lines = offer.split("\n");
      const hadTimeframeLine = lines.some((l) => l.includes(TIMEFRAME_LINE_MARKER));
      const kept = lines.filter(
        (l) => !l.includes(TIMEFRAME_LINE_MARKER) && !l.includes(RETRO_LINE_MARKER)
      );
      // The timeframe option advertised a real affordance (claim + say when
      // you'll reach out); keep it discoverable on the universal digit. The
      // retro option gets NO replacement line — a late "1" just works.
      if (hadTimeframeLine && !kept.some((l) => l.includes('"1, <ETA>"'))) {
        kept.push(CLAIM_ETA_HINT_LINE);
      }
      const next = kept.join("\n");
      if (next !== offer) {
        step.offerTemplate = next;
        changed = true;
      }
    }

    if (step.claimTimeframeOption !== undefined) {
      delete step.claimTimeframeOption;
      changed = true;
    }
    if (step.lateClaimOption !== undefined) {
      delete step.lateClaimOption;
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
    if (!simplifyClaimOptions(def)) continue;

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
    console.log("\nNo flows needed changes (already simplified).");
  } else if (!args.apply) {
    console.log(`\n[dry-run] ${changedCount} flow(s) would change. Re-run with --apply to write.`);
  } else {
    console.log(`\nSimplified ${changedCount} flow(s).`);
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
