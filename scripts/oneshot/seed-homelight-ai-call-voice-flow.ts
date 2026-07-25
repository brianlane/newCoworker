#!/usr/bin/env tsx
/**
 * One-shot: let the AI take the whole HomeLight live-transfer call.
 *
 * Today the partner's call rings Dave for 20s, then Amy for 20s, and only then
 * hands the seller to the AI. HomeLight calls about FOUR SECONDS after texting
 * its referral alert, an announcement plays, and pressing a digit accepts the
 * referral fee, which is what actually claims the lead. So the referral is won
 * by accepting ON the call, and a human racing to pick up is not what wins it.
 *
 * Disables the current voice flow (and the legacy voice_handoff_chains row it
 * would otherwise fall back to) and seeds a copy whose voice_ai_intake sets
 * `answerFirst`: the AI answers, presses the accept digits, and runs the
 * listing conversation, informed by the referral text it reads at answer time.
 * The two ring steps stay in the definition as the FALLBACK, rung only when the
 * AI cannot run (no voice minutes, unhealthy bridge, refused DTMF), so a live
 * seller is never dropped.
 *
 * After the call the lead details text to Dave (notifyE164) with a copy to Amy
 * (alsoNotifyE164).
 *
 * Requires the AI-first engine support deployed (schema + telnyx-voice-inbound)
 * AND a voice-bridge redeploy on the tenant's box for the mid-call brief and the
 * second summary recipient:
 *   tsx debug/redeploy-voice-bridge.ts --business-id <uuid>
 *
 * Rollback is two enabled flags: re-enable the old flow, disable this copy.
 *
 * Idempotent: skips when a flow with the new name already exists. Dry-run by
 * default. Validates through the SAME parseAiFlowDefinition the dashboard uses,
 * and records the apply in applied_oneshots.
 *
 * Usage:
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/seed-homelight-ai-call-voice-flow.ts            # dry run
 *   npx tsx scripts/oneshot/seed-homelight-ai-call-voice-flow.ts --apply    # write, disabled
 *   npx tsx scripts/oneshot/seed-homelight-ai-call-voice-flow.ts --apply --enable
 *
 * Required env: NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY.
 * Business id: --business-id <uuid> or AIFLOW_SEED_BUSINESS_ID (defaults to Amy's).
 * Optional overrides:
 *   HOMELIGHT_VOICE_FROM   (default "+14159851909" HomeLight's live-transfer line)
 *   HOMELIGHT_VOICE_DAVE   (default "+16025245719")
 *   HOMELIGHT_VOICE_AMY    (default "+16026951142")
 *
 * Exit codes: 0 seeded/no-op/dry-run · 1 Supabase error · 2 bad env/arg or invalid definition.
 */
import { pathToFileURL } from "node:url";
import { createClient } from "@supabase/supabase-js";
import {
  parseAiFlowDefinition,
  summarizeDefinition,
  AiFlowValidationError
} from "@/lib/ai-flows/schema";
import { recordOneshotApplied } from "./_ledger";

type Args = { apply: boolean; enable: boolean; businessId: string | null };

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { apply: false, enable: false, businessId: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") args.apply = true;
    else if (a === "--enable") args.enable = true;
    else if (a === "--business-id") args.businessId = argv[++i] ?? null;
    else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

const DEFAULT_BUSINESS_ID = "621a5b0d-c2ad-449f-9d74-9d50e7b27fa3";

export const AI_CALL_FLOW_NAME = "HomeLight Live Transfer (AI takes the call)";

/**
 * The AI's opening line. It is answering a partner's transfer, so it leads as
 * the office and gets straight to the seller's plans; the apologize-and-ask rule
 * for details we were never sent lives in the bridge's intake instruction.
 */
const INTAKE_PERSONA =
  "Hi, this is Amy Laidlaw's office with HomeSmart. Thanks for reaching out about selling your home, I have your inquiry here and would love to hear what you are looking to do.";

const CAPTURE_FIELDS = ["name", "phone", "address", "timeframe", "notes"];

/** What the newest inbound text must contain to be read as the referral alert. */
const BRIEF_MATCH = "HomeLight Referral";

export function aiCallVoiceDefinition(opts: {
  fromE164: string;
  daveE164: string;
  amyE164: string;
}): unknown {
  return {
    version: 1,
    trigger: { channel: "voice", fromE164: opts.fromE164 },
    steps: [
      // The rings are the FALLBACK under answerFirst, not the first move: they
      // only ever ring when the AI cannot take the call at all. They stay in the
      // definition because a chain must always have a ringable human, which is
      // what makes the safety net structural rather than optional.
      { id: "ring1", type: "ring_handoff", toE164: opts.daveE164, ringSeconds: 20 },
      { id: "ring2", type: "ring_handoff", toE164: opts.amyE164, ringSeconds: 20 },
      {
        id: "ai",
        type: "voice_ai_intake",
        answerFirst: true,
        // One press of 1 accepts the referral fee. Three seconds lets the
        // announcement play first; a digit sent into it is not accepted at all.
        // Tune this from the first live call, no deploy needed.
        acceptDigits: [{ digit: "1", afterSeconds: 3 }],
        // HomeLight dials the seller after we accept, so hold the AI's greeting
        // back or it plays to hold music.
        mediaStartSeconds: 2,
        briefFromSmsContaining: BRIEF_MATCH,
        persona: INTAKE_PERSONA,
        captureFields: CAPTURE_FIELDS,
        // The lead details go to whoever works it; Amy gets the copy.
        notifyE164: opts.daveE164,
        alsoNotifyE164: opts.amyE164
      }
    ],
    // Keep the framed alerts: a live transfer has to stand out from routine
    // texts, including the fallback ring notices and the post-call summary.
    options: { starAlerts: true }
  };
}

export type VoiceFlowRow = { id: string; name: string; enabled: boolean };

export type VoiceCutoverPlan = {
  /** Insert the copy (absent today). */
  seed: boolean;
  /** Turn ON an existing copy that is still disabled. */
  enableExistingId: string | null;
  /** Older voice flows for this caller to switch off. */
  disableFlowIds: string[];
  /** Switch off the legacy voice_handoff_chains row too. */
  disableLegacyChain: boolean;
};

/**
 * Decide the cutover, so the ordering rule lives somewhere testable rather than
 * inside the IO: the replacement must be LIVE before anything else is switched
 * off, or the caller is left with no routing at all. Nothing is disabled unless
 * `enable` is set, which is what makes a bare `--apply` a safe no-op preview.
 */
export function planVoiceCutover(args: {
  existing: readonly VoiceFlowRow[];
  flowName: string;
  enable: boolean;
  legacyChainLive: boolean;
}): VoiceCutoverPlan {
  const mine = args.existing.find((f) => f.name.trim() === args.flowName);
  return {
    seed: !mine,
    // Re-running with --enable after seeding disabled is the documented cutover,
    // so an existing-but-off copy has to be switched on here.
    enableExistingId: mine && args.enable && !mine.enabled ? mine.id : null,
    disableFlowIds: args.enable
      ? args.existing.filter((f) => f.name.trim() !== args.flowName && f.enabled).map((f) => f.id)
      : [],
    disableLegacyChain: args.enable && args.legacyChainLive
  };
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
  const fromE164 = process.env.HOMELIGHT_VOICE_FROM ?? "+14159851909";
  const daveE164 = process.env.HOMELIGHT_VOICE_DAVE ?? "+16025245719";
  const amyE164 = process.env.HOMELIGHT_VOICE_AMY ?? "+16026951142";

  let definition;
  try {
    definition = parseAiFlowDefinition(aiCallVoiceDefinition({ fromE164, daveE164, amyE164 }));
  } catch (err) {
    console.error("Definition failed validation:");
    if (err instanceof AiFlowValidationError) for (const i of err.issues) console.error(`  - ${i}`);
    else console.error(err);
    process.exit(2);
  }

  const db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  // Every voice flow for this caller, so the old one can be turned off in the
  // same pass. Matched on the trigger caller id, not the name: the migrated flow
  // carries the caller's label in its name and a rename must not orphan this.
  const { data: rows, error } = await db
    .from("ai_flows")
    .select("id, name, enabled")
    .eq("business_id", businessId)
    .eq("definition->trigger->>channel", "voice")
    .eq("definition->trigger->>fromE164", fromE164);
  if (error) {
    console.error(`Read failed: ${error.message}`);
    process.exit(1);
  }
  const existing = (rows ?? []) as VoiceFlowRow[];
  const alreadySeeded = existing.find((f) => f.name.trim() === AI_CALL_FLOW_NAME);

  // The legacy chain row for this caller is shadowed while a voice flow matches,
  // but it would silently resurrect ring-Dave-then-Amy if both flows were ever
  // disabled. Turn it off in the same pass.
  const { data: chainRows, error: chainErr } = await db
    .from("voice_handoff_chains")
    .select("from_e164, enabled")
    .eq("business_id", businessId)
    .eq("from_e164", fromE164);
  if (chainErr) {
    console.error(`Legacy chain read failed: ${chainErr.message}`);
    process.exit(1);
  }
  const liveChain = (chainRows ?? []).some((c) => (c as { enabled?: boolean }).enabled);

  const plan = planVoiceCutover({
    existing,
    flowName: AI_CALL_FLOW_NAME,
    enable: args.enable,
    legacyChainLive: liveChain
  });
  const byId = new Map(existing.map((f) => [f.id, f]));

  console.log(`Business : ${businessId}`);
  console.log(`Caller   : ${fromE164}`);
  console.log(`Name     : ${AI_CALL_FLOW_NAME}`);
  console.log(`Enabled  : ${args.enable}`);
  console.log(`Summary  : ${summarizeDefinition(definition)}`);
  console.log(`AI first : answers, presses 1 at 3s, media at +2s, brief from "${BRIEF_MATCH}"`);
  console.log(`Details  : ${daveE164} (copy to ${amyE164})`);
  console.log(`Fallback : ring ${daveE164}, then ${amyE164}, only if the AI cannot run`);
  for (const id of plan.disableFlowIds) {
    console.log(`Disable  : ${byId.get(id)?.name ?? id} (${id})`);
  }
  if (plan.disableLegacyChain) {
    console.log(`Disable  : legacy voice_handoff_chains row ${fromE164}`);
  }
  if (alreadySeeded) {
    console.log(
      `\nFlow "${AI_CALL_FLOW_NAME}" already exists (id=${alreadySeeded.id}, ` +
        `enabled=${alreadySeeded.enabled}). Nothing to seed` +
        (args.enable && !alreadySeeded.enabled ? ", but it will be ENABLED." : ".")
    );
  }
  console.log(`\nDefinition:\n${JSON.stringify(definition, null, 2)}`);

  if (!args.apply) {
    console.log("\n[dry-run] Not writing. Re-run with --apply (add --enable to turn it on).");
    return;
  }

  // Seed (or enable) FIRST, disable second: if this half fails, the tenant keeps
  // working call routing rather than none at all.
  let seededId = alreadySeeded?.id ?? "";
  // The documented cutover is --apply, then --apply --enable. On that second run
  // the row already exists, so enabling it here is what makes the switch real:
  // without it the old flows would be disabled while the replacement stayed off,
  // leaving the caller with NO routing.
  if (plan.enableExistingId) {
    const { error: enErr } = await db
      .from("ai_flows")
      .update({ enabled: true })
      .eq("id", plan.enableExistingId);
    if (enErr) {
      console.error(`Enable failed for ${plan.enableExistingId}: ${enErr.message}`);
      process.exit(1);
    }
    console.log(`\n  -> enabled the existing ${AI_CALL_FLOW_NAME} (${plan.enableExistingId}).`);
  }
  if (plan.seed) {
    const { data: inserted, error: insErr } = await db
      .from("ai_flows")
      .insert({
        business_id: businessId,
        name: AI_CALL_FLOW_NAME,
        enabled: args.enable,
        definition
      })
      .select("id")
      .single();
    if (insErr) {
      console.error(`Insert failed: ${insErr.message}`);
      process.exit(1);
    }
    seededId = (inserted as { id: string }).id;
    console.log(`\n  -> seeded ${AI_CALL_FLOW_NAME} (${seededId}).`);
  }

  // Only retire the old routing once the replacement is enabled, so a
  // --apply without --enable never leaves the caller unrouted.
  const disabled: string[] = [];
  {
    for (const id of plan.disableFlowIds) {
      const { error: upErr } = await db.from("ai_flows").update({ enabled: false }).eq("id", id);
      if (upErr) {
        console.error(`Disable failed for ${id}: ${upErr.message}`);
        process.exit(1);
      }
      console.log(`  -> disabled ${byId.get(id)?.name ?? id}.`);
      disabled.push(id);
    }
    if (plan.disableLegacyChain) {
      const { error: chainUpErr } = await db
        .from("voice_handoff_chains")
        .update({ enabled: false })
        .eq("business_id", businessId)
        .eq("from_e164", fromE164);
      if (chainUpErr) {
        console.error(`Legacy chain disable failed: ${chainUpErr.message}`);
        process.exit(1);
      }
      console.log(`  -> disabled the legacy chain row ${fromE164}.`);
    }
  }
  if (!args.enable) {
    console.log(
      "\nSeeded DISABLED, so the old routing is untouched. Re-run with --enable " +
        "to switch the caller over."
    );
  }

  await recordOneshotApplied(db, {
    scriptPath: process.argv[1] ?? "seed-homelight-ai-call-voice-flow.ts",
    businessId,
    details: {
      from_e164: fromE164,
      seeded_flow_id: seededId,
      seeded_now: plan.seed,
      enabled_existing: plan.enableExistingId,
      enabled: args.enable,
      disabled_flow_ids: disabled,
      disabled_legacy_chain: plan.disableLegacyChain
    }
  });
  if (args.enable) {
    console.log(
      "\nRedeploy the tenant's voice bridge so the mid-call brief and the summary " +
        `copy work:\n  tsx debug/redeploy-voice-bridge.ts --business-id ${businessId}`
    );
  }
}

// Run only when executed directly (not when imported by unit tests, which
// exercise the exported pure builder above).
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
