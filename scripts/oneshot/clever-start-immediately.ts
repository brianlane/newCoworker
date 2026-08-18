#!/usr/bin/env tsx
/**
 * One-shot: stop losing the first minute on Amy's Clever referrals.
 *
 * `options.startImmediately` (PR #990) makes the inbound webhook kick the worker
 * on enqueue instead of leaving the run for the next tick. HomeLight already has
 * it; two Clever flows have the same shape:
 *
 *   Clever Cue Text, "Clever has a customer ready to connect NOW", and the
 *                         flow's whole job is to reply Y and arm the live-transfer
 *                         window. Measured queue-to-done on her last 12 runs:
 *                         22s median, 52s worst. That is a person waiting on the
 *                         line while a queued run sits there. Clever sends no
 *                         "no longer available" text, so the loss is silent.
 *   Clever Lead - Accept, its second step ACCEPTS the referral in the portal,
 *                         and the flow already guards on the page saying
 *                         "already been claimed", which is direct evidence other
 *                         agents race for the same lead.
 *
 * Deliberately NOT applied to her other Clever flows (Homeward Offers, the group
 * replies, Re-enroll, Update Leads): those are internal notifications or bulk
 * portal updates where a minute is invisible, and a kick per inbound message is a
 * real invocation cost.
 *
 * Requires the engine support deployed before --apply: an older webhook ignores
 * the flag, which is a no-op rather than a failure.
 *
 * Validates each patched definition through parseAiFlowDefinition before writing;
 * dry-run by default; records the apply in applied_oneshots.
 *
 * Usage:
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/clever-start-immediately.ts            # dry run
 *   npx tsx scripts/oneshot/clever-start-immediately.ts --apply    # write
 *
 * Required env: NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY.
 * Business id: --business-id <uuid> or AIFLOW_SEED_BUSINESS_ID (defaults to Amy's).
 *
 * Exit codes: 0 patched/no-op/dry-run · 1 Supabase error · 2 bad env/arg, flow
 * not found, or invalid definition.
 */
import { pathToFileURL } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { parseAiFlowDefinition, AiFlowValidationError } from "@/lib/ai-flows/schema";
import { recordOneshotApplied } from "./_ledger";

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

/** Exactly the two flows where a queued minute costs something. */
export const TARGET_FLOW_NAMES = ["Clever Cue Text", "Clever Lead - Accept"] as const;

export type Definition = {
  options?: Record<string, unknown>;
  trigger?: { channel?: string } & Record<string, unknown>;
} & Record<string, unknown>;

/**
 * Turn on the immediate start. Pure and idempotent. Throws for a flow no webhook
 * can kick, so the setting can never look enabled while doing nothing.
 */
export function startImmediately(def: Definition): boolean {
  const channel = def.trigger?.channel;
  if (channel !== "sms") {
    throw new Error(`only an sms-triggered flow can start immediately (this one is "${channel}")`);
  }
  const options = (def.options ?? {}) as Record<string, unknown>;
  if (options.startImmediately === true) return false;
  def.options = { ...options, startImmediately: true };
  return true;
}

function requireEnv(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (!v) {
    console.error(`Missing required env: ${name}`);
    process.exit(2);
  }
  return v;
}

type FlowRow = { id: string; name: string; definition: Definition };

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const supabaseUrl = requireEnv("NEXT_PUBLIC_SUPABASE_URL", process.env.SUPABASE_URL);
  const serviceKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  const businessId =
    args.businessId ?? process.env.AIFLOW_SEED_BUSINESS_ID ?? DEFAULT_BUSINESS_ID;

  const db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  const { data, error } = await db
    .from("ai_flows")
    .select("id, name, definition")
    .eq("business_id", businessId)
    .in("name", TARGET_FLOW_NAMES as unknown as string[]);
  if (error) {
    console.error(`Read failed: ${error.message}`);
    process.exit(1);
  }
  const rows = (data ?? []) as FlowRow[];
  const missing = TARGET_FLOW_NAMES.filter((n) => !rows.some((r) => r.name === n));
  if (missing.length > 0) {
    console.error(`Flow(s) not found for business ${businessId}: ${missing.join(", ")}`);
    process.exit(2);
  }

  const planned: Array<{ row: FlowRow; def: Definition }> = [];
  for (const row of rows) {
    const def = JSON.parse(JSON.stringify(row.definition)) as Definition;
    let changed: boolean;
    try {
      changed = startImmediately(def);
    } catch (err) {
      console.error(
        `Nothing written: "${row.name}" ${err instanceof Error ? err.message : String(err)}`
      );
      process.exit(2);
    }
    console.log(`=== ${row.name} (${row.id}) ===`);
    console.log(`  starts immediately: ${changed ? "yes" : "already"}`);
    if (!changed) continue;
    try {
      parseAiFlowDefinition(def);
    } catch (err) {
      console.error(`Patched "${row.name}" would become INVALID, aborting before any write:`);
      if (err instanceof AiFlowValidationError) {
        for (const i of err.issues) console.error(`  - ${i}`);
      } else console.error(err);
      process.exit(2);
    }
    planned.push({ row, def });
  }
  if (planned.length === 0) {
    console.log("\nBoth flows already start immediately, nothing to do.");
    return;
  }

  if (!args.apply) {
    console.log("\n[dry-run] Not writing. Re-run with --apply to write.");
    return;
  }
  for (const { row, def } of planned) {
    const { error: upErr } = await db.from("ai_flows").update({ definition: def }).eq("id", row.id);
    if (upErr) {
      console.error(`Update failed for ${row.id}: ${upErr.message}`);
      process.exit(1);
    }
    console.log(`  -> updated ${row.name}.`);
  }
  await recordOneshotApplied(db, {
    scriptPath: process.argv[1] ?? "clever-start-immediately.ts",
    businessId,
    details: { flows: planned.map((p) => ({ id: p.row.id, name: p.row.name })) }
  });
}

// Run only when executed directly (not when imported by unit tests, which
// exercise the exported pure helper above).
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
