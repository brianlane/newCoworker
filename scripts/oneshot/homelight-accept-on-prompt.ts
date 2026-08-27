#!/usr/bin/env tsx
/**
 * One-shot: stop guessing how long HomeLight's announcement runs.
 *
 * Amy's AI-first voice flow pressed 1 exactly three seconds after answering,
 * which was a guess at the length of the "press 1 to accept this referral"
 * recording. Too early and the tone lands before the menu is listening; too
 * late and the referral is offered to the next agent. Her words: it "needs to be
 * able to press 1 when being asked to press 1 to accept".
 *
 * `acceptOnPrompt` inverts it. The answer webhook presses nothing and attaches
 * media immediately, so the AI HEARS the announcement and presses through the
 * bridge's `press_digits` tool the moment it is actually asked, staying silent
 * until a person is connected. `fallbackSeconds` is the backstop blind press for
 * a recording it does not recognize, because not pressing at all forfeits the
 * referral.
 *
 * It replaces the timed sequence rather than joining it: two owners of the same
 * keypress would press twice, and the second tone would land on whatever the
 * partner's menu moved on to (the schema rejects the combination).
 *
 * Requires the engine support (voice_ai_intake.acceptOnPrompt) deployed AND the
 * tenant's voice bridge redeployed before --apply: the bridge is what owns the
 * press in this mode, so an old bridge would answer and never accept.
 *
 * Validates the patched definition through parseAiFlowDefinition before writing;
 * dry-run by default; records the apply in applied_oneshots.
 *
 * Usage:
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/homelight-accept-on-prompt.ts            # dry run
 *   npx tsx scripts/oneshot/homelight-accept-on-prompt.ts --apply    # write
 *
 * Required env: NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY.
 * Business id: --business-id <uuid> or AIFLOW_SEED_BUSINESS_ID (defaults to Amy's).
 * Optional: AIFLOW_HOMELIGHT_VOICE_FLOW_NAME (default "HomeLight Live Transfer (AI takes the call)")
 *           AIFLOW_HOMELIGHT_ACCEPT_DIGIT    (default "1")
 *           AIFLOW_HOMELIGHT_ACCEPT_FALLBACK (default "20", seconds; 12 fired mid-announcement)
 *
 * Exit codes: 0 patched/no-op/dry-run · 1 Supabase error · 2 bad env/arg, flow
 * not found, unexpected flow shape, or invalid definition.
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

export type Step = Record<string, unknown> & { id?: string; type?: string };
export type Definition = { steps?: Step[] } & Record<string, unknown>;

/**
 * Swap the timed accept for a heard one. Pure and idempotent (a second run
 * returns false). Throws when the flow has no AI-first intake to patch, so a
 * renamed or rebuilt flow fails loudly instead of silently doing nothing.
 */
export function switchToAcceptOnPrompt(
  def: Definition,
  opts: { digit: string; fallbackSeconds: number }
): boolean {
  const intake = (def.steps ?? []).find((s) => s.type === "voice_ai_intake");
  if (!intake) throw new Error("no voice_ai_intake step in this flow");
  if (intake.answerFirst !== true) {
    throw new Error(
      "the intake does not answer the call itself (answerFirst), so there is no announcement for it to hear"
    );
  }
  if (intake.acceptOnPrompt) return false;
  intake.acceptOnPrompt = { digit: opts.digit, fallbackSeconds: opts.fallbackSeconds };
  // The timed sequence and the heard one own the same keypress; the schema
  // rejects both being set, and leaving them would press twice.
  delete intake.acceptDigits;
  delete intake.mediaStartSeconds;
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
  const flowName =
    process.env.AIFLOW_HOMELIGHT_VOICE_FLOW_NAME ?? "HomeLight Live Transfer (AI takes the call)";
  const digit = process.env.AIFLOW_HOMELIGHT_ACCEPT_DIGIT ?? "1";
  const fallbackRaw = Number(process.env.AIFLOW_HOMELIGHT_ACCEPT_FALLBACK ?? "20");
  const fallbackSeconds = Number.isFinite(fallbackRaw) ? Math.round(fallbackRaw) : 20;

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
    changed = switchToAcceptOnPrompt(def, { digit, fallbackSeconds });
  } catch (err) {
    console.error(
      `The flow does not have the shape this patch expects, so nothing was written: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    process.exit(2);
  }
  if (!changed) {
    console.log("Flow already presses on the prompt, nothing to do.");
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
  console.log(`  presses "${digit}" when asked, or blind after ${fallbackSeconds}s`);
  console.log(`\nAFTER: ${JSON.stringify(def)}`);

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
    scriptPath: process.argv[1] ?? "homelight-accept-on-prompt.ts",
    businessId,
    details: { flow_id: flow.id, flow_name: flow.name, digit, fallback_seconds: fallbackSeconds }
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
