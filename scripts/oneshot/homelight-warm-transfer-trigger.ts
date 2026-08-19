#!/usr/bin/env tsx
/**
 * One-shot: fire Amy's HomeLight flow on WARM TRANSFER alerts too.
 *
 * HomeLight texts her from two different lines with two different wordings:
 *
 *   +14159157879  "New HomeLight Referral: Salma - $250K seller in Mesa, AZ."
 *   +14158553933  "New HomeLight Warm Transfer Opportunity: Jose - $250,000
 *                  seller in Mesa, AZ."
 *
 * The trigger required the literal text "HomeLight Referral", so only the first
 * line ever started a run. Every warm-transfer opportunity (Jose Jul 20, Salma
 * Jul 25, June Jul 26, Jann Jul 28) was ignored by the flow, and each was
 * followed within seconds by "Sorry, this referral is no longer available for a
 * live transfer", the exact referrals this flow exists to win.
 *
 * Both lines behave identically otherwise: the alert text carries no link, and
 * the link arrives as its own message in the same second, which the trigger's
 * 15-minute correlation window already stitches together.
 *
 * Two edits:
 *
 *   1. TRIGGER: `contains "HomeLight Referral"` becomes
 *      `regex "New HomeLight (Referral|Warm Transfer)"`. Anchoring on "New"
 *      also drops a false positive the old condition allowed: HomeLight's
 *      post-call feedback text ("...your HomeLight referral using the link
 *      below. https://hmlt.co/...") contains both the phrase AND a URL, so it
 *      could start a run for a lead that was already handled.
 *   2. PRE-CALL BRIEF: the voice flow's `briefFromSmsContaining` was the same
 *      literal, so on a warm transfer the AI answered knowing nothing about the
 *      seller. It becomes "New HomeLight", which matches both wordings (it is a
 *      substring test, not a regex).
 *
 * Validates both patched definitions through parseAiFlowDefinition before
 * writing; dry-run by default; records the apply in applied_oneshots.
 *
 * Usage:
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/homelight-warm-transfer-trigger.ts            # dry run
 *   npx tsx scripts/oneshot/homelight-warm-transfer-trigger.ts --apply    # write
 *
 * Required env: NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY.
 * Business id: --business-id <uuid> or AIFLOW_SEED_BUSINESS_ID (defaults to Amy's).
 * Optional: AIFLOW_HOMELIGHT_FLOW_NAME       (default "HomeLight Referral")
 *           AIFLOW_HOMELIGHT_VOICE_FLOW_NAME (default "HomeLight Live Transfer (AI takes the call)")
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

type Condition = Record<string, unknown> & { type?: string; value?: string };
type Trigger = Record<string, unknown> & { conditions?: Condition[] };
export type Step = Record<string, unknown> & { id?: string; type?: string };
export type Definition = { steps?: Step[]; trigger?: Trigger; triggers?: Trigger[] } & Record<
  string,
  unknown
>;

/** The old literal, which only ever matched one of HomeLight's two wordings. */
export const OLD_NEEDLE = "HomeLight Referral";
/** Matches "New HomeLight Referral..." AND "New HomeLight Warm Transfer...". */
export const ALERT_REGEX = "New HomeLight (Referral|Warm Transfer)";
/** Substring form for the pre-call brief lookup, which is not a regex. */
export const BRIEF_NEEDLE = "New HomeLight";

/**
 * Edit 1: match both alert wordings. Rewrites the condition in place across the
 * trigger AND any additional triggers. Pure and idempotent.
 */
export function matchWarmTransfers(def: Definition): boolean {
  let changed = false;
  const triggers = [def.trigger, ...(def.triggers ?? [])].filter(Boolean) as Trigger[];
  if (triggers.length === 0) throw new Error("flow has no trigger");
  for (const trig of triggers) {
    for (const cond of trig.conditions ?? []) {
      if (cond.type !== "contains") continue;
      if (typeof cond.value !== "string") continue;
      if (cond.value.trim().toLowerCase() !== OLD_NEEDLE.toLowerCase()) continue;
      cond.type = "regex";
      cond.value = ALERT_REGEX;
      cond.caseInsensitive = true;
      changed = true;
    }
  }
  return changed;
}

/**
 * Edit 2: let the AI's pre-call brief find a warm-transfer alert. Without this
 * the AI answers a warm transfer with no idea who is calling, which is the one
 * thing it can never recover on a live call.
 */
export function briefOnBothWordings(def: Definition): boolean {
  const intake = (def.steps ?? []).find((s) => s.type === "voice_ai_intake");
  if (!intake) throw new Error("no voice_ai_intake step in this flow");
  const current = typeof intake.briefFromSmsContaining === "string"
    ? intake.briefFromSmsContaining
    : "";
  if (current === BRIEF_NEEDLE) return false;
  intake.briefFromSmsContaining = BRIEF_NEEDLE;
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
  const smsName = process.env.AIFLOW_HOMELIGHT_FLOW_NAME ?? "HomeLight Referral";
  const voiceName =
    process.env.AIFLOW_HOMELIGHT_VOICE_FLOW_NAME ?? "HomeLight Live Transfer (AI takes the call)";

  const db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  const load = async (name: string): Promise<FlowRow> => {
    const { data, error } = await db
      .from("ai_flows")
      .select("id, name, definition")
      .eq("business_id", businessId)
      .eq("name", name)
      .maybeSingle();
    if (error) {
      console.error(`Read failed for "${name}": ${error.message}`);
      process.exit(1);
    }
    if (!data) {
      console.error(`Flow "${name}" not found for business ${businessId}.`);
      process.exit(2);
    }
    return data as FlowRow;
  };

  const sms = await load(smsName);
  const voice = await load(voiceName);
  const smsDef = JSON.parse(JSON.stringify(sms.definition)) as Definition;
  const voiceDef = JSON.parse(JSON.stringify(voice.definition)) as Definition;

  let triggerChanged: boolean;
  let briefChanged: boolean;
  try {
    triggerChanged = matchWarmTransfers(smsDef);
    briefChanged = briefOnBothWordings(voiceDef);
  } catch (err) {
    console.error(
      `The flows do not have the shape this patch expects, so nothing was written: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    process.exit(2);
  }
  if (!triggerChanged && !briefChanged) {
    console.log("Both flows already match the warm-transfer wording, nothing to do.");
    return;
  }

  for (const [label, def] of [
    [sms.name, smsDef],
    [voice.name, voiceDef]
  ] as Array<[string, Definition]>) {
    try {
      parseAiFlowDefinition(def);
    } catch (err) {
      console.error(`Patched "${label}" would become INVALID, aborting before any write:`);
      if (err instanceof AiFlowValidationError) {
        for (const i of err.issues) console.error(`  - ${i}`);
      } else console.error(err);
      process.exit(2);
    }
  }

  console.log(`=== ${sms.name} (${sms.id}) ===`);
  console.log(`  trigger updated : ${triggerChanged ? "yes" : "already"}`);
  console.log(`  trigger now     : ${JSON.stringify(smsDef.trigger)}`);
  console.log(`=== ${voice.name} (${voice.id}) ===`);
  console.log(`  brief updated   : ${briefChanged ? "yes" : "already"}`);

  if (!args.apply) {
    console.log("\n[dry-run] Not writing. Re-run with --apply to write.");
    return;
  }
  // The trigger first: a warm transfer that lands between the two writes is
  // better off starting a run with a stale brief needle than being ignored.
  for (const [row, def, changed] of [
    [sms, smsDef, triggerChanged],
    [voice, voiceDef, briefChanged]
  ] as Array<[FlowRow, Definition, boolean]>) {
    if (!changed) continue;
    const { error: upErr } = await db.from("ai_flows").update({ definition: def }).eq("id", row.id);
    if (upErr) {
      console.error(`Update failed for ${row.id}: ${upErr.message}`);
      process.exit(1);
    }
    console.log(`  -> updated ${row.name}.`);
  }
  await recordOneshotApplied(db, {
    scriptPath: process.argv[1] ?? "homelight-warm-transfer-trigger.ts",
    businessId,
    details: {
      sms_flow_id: sms.id,
      voice_flow_id: voice.id,
      trigger_updated: triggerChanged,
      brief_updated: briefChanged,
      regex: ALERT_REGEX
    }
  });
}

// Run only when executed directly (not when imported by unit tests, which
// exercise the exported pure helpers above).
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
