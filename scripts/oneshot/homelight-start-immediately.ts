#!/usr/bin/env tsx
/**
 * One-shot: stop losing the first minute on Amy's HomeLight referrals.
 *
 * A queued run waits for the ai-flow-worker's next tick, about a minute. For a
 * nurture sequence that is invisible; for HomeLight it is the difference between
 * claiming the referral and reading "Sorry, this referral is no longer available
 * for a live transfer". Those withdrawals landed 46s, 1m34s and 1m54s after the
 * alert (and once after 3s), so the tick alone was frequently the reason nobody
 * responded in time.
 *
 * `options.startImmediately` makes the inbound webhook kick the worker in the
 * background the moment the alert is queued, so the flow's first steps (open the
 * portal, click claim) begin within seconds. The tick remains the retry net.
 *
 * Honest scope: this removes the QUEUE delay, not the work. The claim still
 * needs a credentialed page load, so a window measured in single-digit seconds
 * can still close first. It converts "we never even started" into "we started
 * immediately and the browser took as long as it takes".
 *
 * Requires the engine support (options.startImmediately) deployed before
 * --apply: an older webhook ignores the flag, which is a no-op rather than a
 * failure.
 *
 * Validates the patched definition through parseAiFlowDefinition before writing;
 * dry-run by default; records the apply in applied_oneshots.
 *
 * Usage:
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/homelight-start-immediately.ts            # dry run
 *   npx tsx scripts/oneshot/homelight-start-immediately.ts --apply    # write
 *
 * Required env: NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY.
 * Business id: --business-id <uuid> or AIFLOW_SEED_BUSINESS_ID (defaults to Amy's).
 * Optional: AIFLOW_HOMELIGHT_FLOW_NAME (default "HomeLight Referral")
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

export type Definition = {
  options?: Record<string, unknown>;
  trigger?: { channel?: string } & Record<string, unknown>;
} & Record<string, unknown>;

/**
 * Turn on the immediate start. Pure and idempotent. Throws when the flow is not
 * message-triggered, since only the inbound webhook can kick anything: a voice
 * or scheduled flow would silently gain a setting that does nothing.
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

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const supabaseUrl = requireEnv("NEXT_PUBLIC_SUPABASE_URL", process.env.SUPABASE_URL);
  const serviceKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  const businessId =
    args.businessId ?? process.env.AIFLOW_SEED_BUSINESS_ID ?? DEFAULT_BUSINESS_ID;
  const flowName = process.env.AIFLOW_HOMELIGHT_FLOW_NAME ?? "HomeLight Referral";

  const db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  const { data: row, error } = await db
    .from("ai_flows")
    .select("id, name, definition")
    .eq("business_id", businessId)
    .eq("name", flowName)
    .maybeSingle();
  if (error) {
    console.error(`Read failed: ${error.message}`);
    process.exit(1);
  }
  if (!row) {
    console.error(`Flow "${flowName}" not found for business ${businessId}.`);
    process.exit(2);
  }
  const flow = row as { id: string; name: string; definition: Definition };
  const def = JSON.parse(JSON.stringify(flow.definition)) as Definition;

  let changed: boolean;
  try {
    changed = startImmediately(def);
  } catch (err) {
    console.error(
      `Nothing written: ${err instanceof Error ? err.message : String(err)}`
    );
    process.exit(2);
  }
  if (!changed) {
    console.log("Flow already starts immediately, nothing to do.");
    return;
  }

  try {
    parseAiFlowDefinition(def);
  } catch (err) {
    console.error(`Patched "${flow.name}" would become INVALID, aborting before any write:`);
    if (err instanceof AiFlowValidationError) for (const i of err.issues) console.error(`  - ${i}`);
    else console.error(err);
    process.exit(2);
  }

  console.log(`=== ${flow.name} (${flow.id}) ===`);
  console.log("  starts immediately on a matching text instead of at the next tick");

  if (!args.apply) {
    console.log("\n[dry-run] Not writing. Re-run with --apply to write.");
    return;
  }
  const { error: upErr } = await db.from("ai_flows").update({ definition: def }).eq("id", flow.id);
  if (upErr) {
    console.error(`Update failed for ${flow.id}: ${upErr.message}`);
    process.exit(1);
  }
  console.log("  -> updated.");
  await recordOneshotApplied(db, {
    scriptPath: process.argv[1] ?? "homelight-start-immediately.ts",
    businessId,
    details: { flow_id: flow.id, flow_name: flow.name }
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
