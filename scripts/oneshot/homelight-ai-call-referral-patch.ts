#!/usr/bin/env tsx
/**
 * One-shot: make Amy's "HomeLight Referral" flow fit the world where the AI
 * takes the call.
 *
 * The companion voice flow now answers HomeLight's call itself and accepts the
 * referral on it. Three idempotent edits to the SMS flow so the two agree:
 *
 *   1. REWORD the team offer. Dave and Amy used to be told to claim the call;
 *      the AI is already on it, so the offer now says so and asks who wants to
 *      OWN THE FOLLOW-UP. The offer stays: `claimed_agent` is what unlocks the
 *      whole details pipeline (the portal read, the email read, both retry
 *      rungs, the QT email, the bad-phone report), it is referenced 27 times
 *      across four nested branch trees, and route_to_team has no
 *      assign-without-offering mode. Dropping it would also break the
 *      agent-report wait outright, since `bp_wait` needs claimed_agent_phone in
 *      a var and no step type can seed a var with a literal.
 *   2. CLICK "Call me to claim referral" when the button is still there. The
 *      flow only ever READ the page, so a human had to claim in the portal. The
 *      click is gated on the `already_claimed` sentinel, so a referral HomeLight
 *      already auto-called (or gave away) is not clicked again, which would ask
 *      for a second call.
 *   3. BRIEF the live call. The portal read finishes about a minute into a call
 *      the AI answered four seconds after the alert, so a `voice_brief` step
 *      hands those client notes to the conversation in progress; the AI works
 *      them in and acknowledges they arrived rather than making the seller
 *      repeat themselves.
 *
 * Requires the AI-first engine support (answerFirst + the voice_brief step)
 * deployed on the ai-flow-worker and the voice functions before --apply: an old
 * worker would fail the unknown step type.
 *
 * Validates the patched definition through parseAiFlowDefinition before
 * writing; dry-run by default; records the apply in applied_oneshots.
 *
 * Usage:
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/homelight-ai-call-referral-patch.ts            # dry run
 *   npx tsx scripts/oneshot/homelight-ai-call-referral-patch.ts --apply    # write
 *
 * Required env: NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY.
 * Business id: --business-id <uuid> or AIFLOW_SEED_BUSINESS_ID (defaults to Amy's).
 * Optional: AIFLOW_HOMELIGHT_FLOW_NAME (default "HomeLight Referral")
 *           HOMELIGHT_VOICE_FROM       (default "+14159851909")
 *           AIFLOW_HOMELIGHT_CLAIM_BUTTON_TEXT (default "Call me to claim referral")
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

type Step = Record<string, unknown> & { id?: string; type?: string };
type Definition = { steps?: Step[] } & Record<string, unknown>;

/** Step ids this patch adds, so a re-run recognizes its own work. */
export const CLICK_STEP_ID = "claim_click";
export const BRIEF_STEP_ID = "brief_call";

/**
 * The line that tells the roster the AI is already handling the call. Doubles as
 * the idempotency marker for edit 1.
 */
export const AI_ON_CALL_LINE =
  "Our AI coworker answered HomeLight's call and is talking to them now.";

/** The old first line, replaced because nobody needs to claim the CALL anymore. */
const OLD_CLAIM_LINE_PREFIX = "Tap to claim and click button to have homelight call you";

/**
 * Edit 1: reword the offer so it asks who OWNS the follow-up instead of who
 * claims the call. Pure and idempotent (a second run returns false).
 */
export function rewordOffer(def: Definition): boolean {
  let changed = false;
  for (const step of def.steps ?? []) {
    if (step.type !== "route_to_team") continue;
    const offer = typeof step.offerTemplate === "string" ? step.offerTemplate : "";
    if (!offer || offer.includes(AI_ON_CALL_LINE)) continue;
    // Drop the now-wrong "tap to claim so HomeLight calls you" instruction and
    // lead with what actually happened, keeping every reply-digit line intact.
    const lines = offer
      .split("\n")
      .filter((line) => !line.startsWith(OLD_CLAIM_LINE_PREFIX))
      .map((line) =>
        line.startsWith("Reply 1 to claim or 2 to pass")
          ? line.replace(
              "Reply 1 to claim or 2 to pass",
              "Reply 1 to take the follow-up or 2 to pass"
            )
          : line
      );
    // The AI-on-the-call line goes directly under the lead summary (line 1), so
    // it is the first thing read after who the lead is.
    lines.splice(1, 0, AI_ON_CALL_LINE, "Portal: {{vars.leadUrl}}");
    step.offerTemplate = lines.join("\n");
    changed = true;
    // The owner fallback still told Amy to claim it so HomeLight would call
    // HER, which would now trigger a SECOND call on a referral the AI already
    // took. Point at the portal instead.
    if (typeof step.ownerFallbackTemplate === "string") {
      const fixed = step.ownerFallbackTemplate.replace(
        "Tap to claim and have it call you:",
        "Portal:"
      );
      if (fixed !== step.ownerFallbackTemplate) step.ownerFallbackTemplate = fixed;
    }
  }
  return changed;
}

/**
 * Edit 2: click the claim button, gated on the already_claimed sentinel the
 * pre-claim browse now produces. Inserted immediately after that browse (the
 * step holding the sentinel) and before the route step, so the referral is ours
 * before anyone is asked about the follow-up.
 */
export function addClaimClick(def: Definition, buttonText: string): boolean {
  const steps = def.steps ?? [];
  if (steps.some((s) => s.id === CLICK_STEP_ID)) return false;
  const openIndex = steps.findIndex(
    (s) =>
      s.type === "browse_extract" &&
      Array.isArray(s.fields) &&
      (s.fields as Array<{ name?: string }>).some((f) => f?.name === "already_claimed")
  );
  if (openIndex === -1) return false;
  const open = steps[openIndex]!;
  const auth = open.auth;
  steps.splice(openIndex + 1, 0, {
    id: CLICK_STEP_ID,
    type: "browse_action",
    urlVar: "leadUrl",
    ...(auth ? { auth } : {}),
    actions: [{ kind: "click_text", target: buttonText }],
    // HomeLight assigns the referral on this click and then calls us. Skipping a
    // referral that is already claimed keeps us from asking for a second call.
    when: { var: "already_claimed", equals: "no" }
  });
  return true;
}

/**
 * Edit 3a: extract the client notes. The portal shows "Client notes /
 * Motivation" (e.g. "Looking for cash offer"), which is the one genuinely
 * useful thing on the page for a live conversation and the flow never read it.
 * Pure and idempotent.
 */
export function addLeadNotesField(def: Definition): boolean {
  const card = (def.steps ?? []).find((s) => s.id === "card");
  if (!card || !Array.isArray(card.fields)) return false;
  const fields = card.fields as Array<{ name?: string; description?: string }>;
  if (fields.some((f) => f?.name === "lead_notes")) return false;
  fields.push({
    name: "lead_notes",
    description:
      "The client notes / motivation shown on the referral (e.g. 'Looking for cash offer'), " +
      "plus the home type and timeframe if the page shows them. Answer 'none' if the page " +
      "shows no client notes."
  });
  return true;
}

/**
 * Edit 3b: brief the live call with what the portal read produced. Inserted
 * right after the post-claim card read, the first step with anything worth
 * saying, and gated on the same claim the read is.
 */
export function addCallBrief(def: Definition, fromE164: string): boolean {
  const steps = def.steps ?? [];
  if (steps.some((s) => s.id === BRIEF_STEP_ID)) return false;
  const cardIndex = steps.findIndex((s) => s.id === "card");
  if (cardIndex === -1) return false;
  steps.splice(cardIndex + 1, 0, {
    id: BRIEF_STEP_ID,
    type: "voice_brief",
    fromE164,
    // Only the details the AI could not have known from the alert text. The
    // engine skips the step when not one of these rendered, so a dry read never
    // dilutes what it already knows.
    noteTemplate:
      "Client notes from the HomeLight portal: {{vars.lead_notes}}. " +
      "Property address: {{vars.lead_address}}. " +
      "Their name on file: {{vars.lead_name}}.",
    withinMinutes: 30,
    when: { var: "claimed_agent", notEquals: "none" }
  });
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
  const fromE164 = process.env.HOMELIGHT_VOICE_FROM ?? "+14159851909";
  const buttonText =
    process.env.AIFLOW_HOMELIGHT_CLAIM_BUTTON_TEXT ?? "Call me to claim referral";

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

  const reworded = rewordOffer(def);
  const clicked = addClaimClick(def, buttonText);
  const notesAdded = addLeadNotesField(def);
  const briefed = addCallBrief(def, fromE164);
  if (!clicked) {
    // Either already patched, or the already_claimed sentinel is missing, which
    // means homelight-late-contact-retry.ts has not been applied here yet. Say
    // which so it is not mistaken for a silent success.
    const hasClick = (def.steps ?? []).some((s) => s.id === CLICK_STEP_ID);
    if (!hasClick) {
      console.error(
        "Could not find the pre-claim browse step carrying the already_claimed " +
          "sentinel, so the claim click has nothing to gate on. Apply " +
          "homelight-late-contact-retry.ts first."
      );
      process.exit(2);
    }
  }
  if (!reworded && !clicked && !notesAdded && !briefed) {
    console.log("Flow already patched, nothing to do.");
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
  console.log(`  offer reworded      : ${reworded ? "yes" : "already"}`);
  console.log(`  claim click added   : ${clicked ? "yes" : "already"}`);
  console.log(`  client-notes field  : ${notesAdded ? "yes" : "already"}`);
  console.log(`  live-call brief     : ${briefed ? "yes" : "already"}`);
  console.log(`  trunk steps         : ${(def.steps ?? []).length}`);
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
    scriptPath: process.argv[1] ?? "homelight-ai-call-referral-patch.ts",
    businessId,
    details: {
      flow_id: flow.id,
      flow_name: flow.name,
      offer_reworded: reworded,
      claim_click_added: clicked,
      lead_notes_field_added: notesAdded,
      call_brief_added: briefed
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
