#!/usr/bin/env tsx
/**
 * One-shot: give every AI call on Amy Laidlaw's account something to say when
 * it reaches a voicemail.
 *
 * Until PR #1297 the AI hung up on a machine, so a lead who never picked up
 * heard from us only by text. Every `place_ai_call` step on this account now
 * gets a `voicemailTemplate`.
 *
 * WHICH FLOWS. Clever Lead - Accept (3 rungs), Clever Spoke Check (8 weekly
 * rungs), and New Lead Intake (English + Spanish). HomeLight Referral is NOT
 * here and is not an omission: it places no outbound AI call at all. Its AI
 * involvement is ANSWERING HomeLight's inbound live-transfer call, which by
 * definition has a person on the line. ReferralExchange gets its scripts when
 * it gets its call steps.
 *
 * WHY EVERY RUNG IS WORDED DIFFERENTLY. A ladder that redials leaves a message
 * each time. Three identical recordings from the same number reads as a
 * malfunction, and by the last rung the honest thing to say is that it is the
 * last one. So each rung acknowledges where in the sequence it is.
 *
 * COPY RULES THIS ACCOUNT ALREADY HAS, all of which these obey:
 *   - Never ask when is a good time to call back (Amy: she calls back fast,
 *     she does not book an appointment to call). Leaving her number is not the
 *     same question and is the whole point of a voicemail.
 *   - No em dashes anywhere, including spoken copy.
 *   - "AI coworker", never "AI receptionist".
 *   - No price. The figure is the referral network's estimate, and lead-facing
 *     copy on this account deliberately does not quote it back at a seller
 *     (see amy-price-every-lead-notice.ts).
 *
 * Kept short on purpose: nobody can reply to a voicemail, it has no
 * turn-taking, and recordings cut off. Every script here is comfortably inside
 * the schema's 600-character cap.
 *
 * Read-modify-write against the LIVE definitions, validated through the same
 * parseAiFlowDefinition the dashboard uses, idempotent, dry-run by default.
 *
 * Usage:
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/amy-voicemail-scripts.ts          # dry run
 *   npx tsx scripts/oneshot/amy-voicemail-scripts.ts --apply
 *
 * Exit codes: 0 patched/no-op/dry-run - 1 Supabase error - 2 bad env or shape.
 */
import { pathToFileURL } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { AiFlowValidationError, parseAiFlowDefinition } from "@/lib/ai-flows/schema";
import { findStep } from "./amy-lead-price-in-notices";
import { recordOneshotApplied } from "./_ledger";

/** Amy Laidlaw Real Estate. */
const DEFAULT_BUSINESS_ID = "621a5b0d-c2ad-449f-9d74-9d50e7b27fa3";

/** Amy's own line, the number every message asks them to call. */
const CALLBACK = "602-695-1142";

/**
 * Clever's seller ladder: first contact, a couple of hours later, then next
 * morning. The angle is the cash offer they asked for, because that is what
 * they filled in on Clever.
 */
export const CLEVER_ACCEPT_VOICEMAILS: Record<string, string> = {
  ai_call_1:
    "Hi {{vars.lead_name.first}}, this is the Amy Laidlaw Team with HomeSmart, calling about the cash offer you asked about through Clever. " +
    "We can show you what those offers usually come in at and what your home would bring on the open market, so you can compare the two. " +
    `Give us a call back at ${CALLBACK}. Thanks.`,
  ai_call_2:
    "Hi {{vars.lead_name.first}}, the Amy Laidlaw Team with HomeSmart again about your Clever request. " +
    "Most sellers are surprised by the gap between a cash offer and what the market pays, and we are happy to walk you through both with no obligation. " +
    `We are at ${CALLBACK}.`,
  ai_call_3:
    "Good morning {{vars.lead_name.first}}, Amy Laidlaw's team with HomeSmart. This is our last message about the Clever request. " +
    "If you would still like to know what your home is worth before you decide anything, we would love to help. " +
    `${CALLBACK}, any time.`
};

/**
 * The weekly spoke check runs for two months on a lead nobody reached. Each
 * message says something a little different so the sequence reads as a person
 * following up rather than a machine repeating itself, and the later ones are
 * shorter, because by week six a long message is not going to be the thing
 * that wins them over.
 */
export const SPOKE_CHECK_VOICEMAILS: Record<string, string> = {
  week_1_call:
    "Hi {{vars.lead_name.first}}, this is Amy Laidlaw's team with HomeSmart following up on the cash offers for your home through Clever. " +
    `Whenever you are ready to talk numbers, we are at ${CALLBACK}.`,
  week_2_call:
    "Hi {{vars.lead_name.first}}, Amy Laidlaw's team with HomeSmart again. " +
    "We have an appraiser on our team, so we can tell you what your home is actually worth before you accept any offer. " +
    `${CALLBACK}.`,
  week_3_call:
    "Hi {{vars.lead_name.first}}, Amy Laidlaw's office with HomeSmart. " +
    "If the timing is not right yet, that is completely fine, we can just send you what homes near you are selling for. " +
    `Call or text ${CALLBACK}.`,
  week_4_call:
    "Hi {{vars.lead_name.first}}, checking in from Amy Laidlaw's team at HomeSmart about your home. " +
    `Amy has been selling in the Phoenix area since 1989, and she is happy to answer one question or twenty. ${CALLBACK}.`,
  week_5_call:
    "Hi {{vars.lead_name.first}}, Amy Laidlaw's team with HomeSmart. " +
    `The market moves, so the offer you were quoted a while back may not be the number today. We can bring you current at ${CALLBACK}.`,
  week_6_call:
    "Hi {{vars.lead_name.first}}, Amy Laidlaw's office at HomeSmart. " +
    `Still here whenever selling is back on your mind. ${CALLBACK}.`,
  week_7_call:
    "Hi {{vars.lead_name.first}}, Amy Laidlaw's team with HomeSmart. " +
    `We will stop after one more message. If you want a free valuation before then, call ${CALLBACK}.`,
  week_8_call:
    "Hi {{vars.lead_name.first}}, this is our last call from Amy Laidlaw's team at HomeSmart. " +
    `We will leave you be now. If anything changes, we would be glad to hear from you at ${CALLBACK}.`
};

/**
 * New Lead Intake is Amy handing the AI a lead by name, so the message says a
 * teammate asked us to reach out. The Spanish one is a translation of the same
 * message, not a different one: the lead's language should not change what
 * they are told.
 */
export const NEW_LEAD_INTAKE_VOICEMAILS: Record<string, string> = {
  call_lead_en:
    "Hi {{vars.lead_name.first}}, I'm calling from Amy Laidlaw's office at HomeSmart. " +
    "Amy asked us to reach out about your real estate plans and we would love to help. " +
    `Give us a call back at ${CALLBACK}. Thank you.`,
  call_lead_es:
    "Hola {{vars.lead_name.first}}, le llamo de la oficina de Amy Laidlaw en HomeSmart. " +
    "Amy nos pidio comunicarnos con usted sobre sus planes de bienes raices y nos encantaria ayudarle. " +
    `Puede llamarnos al ${CALLBACK}. Gracias.`
};

export const VOICEMAIL_PLAN: Record<string, Record<string, string>> = {
  "Clever Lead - Accept": CLEVER_ACCEPT_VOICEMAILS,
  "Clever - Spoke Check & Weekly Call Follow-Up": SPOKE_CHECK_VOICEMAILS,
  "New Lead Intake": NEW_LEAD_INTAKE_VOICEMAILS
};

type AnyStep = Record<string, unknown> & { id?: string; type?: string };
type Definition = { steps?: AnyStep[] };

export type PatchResult = { changed: boolean; touched: string[] };

/**
 * Set each rung's message in place. Throws rather than guessing when a step is
 * gone or is not a call step: a renamed rung means the ladder moved and this
 * script's rung-by-rung wording needs re-checking.
 */
export function patchVoicemails(flowName: string, def: Definition): PatchResult {
  const plan = VOICEMAIL_PLAN[flowName];
  if (!plan) throw new Error(`no voicemail plan for flow "${flowName}"`);
  const touched: string[] = [];
  for (const [stepId, script] of Object.entries(plan)) {
    const step = findStep(def.steps ?? [], stepId);
    if (!step) throw new Error(`${flowName}: step "${stepId}" is missing`);
    if (step.type !== "place_ai_call") {
      throw new Error(`${flowName}: step "${stepId}" is a ${String(step.type)}, not a call`);
    }
    if (step.voicemailTemplate !== script) {
      step.voicemailTemplate = script;
      touched.push(stepId);
    }
  }
  return { changed: touched.length > 0, touched };
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
  const apply = process.argv.includes("--apply");
  const i = process.argv.indexOf("--business-id");
  const businessId = i >= 0 ? (process.argv[i + 1] ?? DEFAULT_BUSINESS_ID) : DEFAULT_BUSINESS_ID;
  const url = requireEnv("NEXT_PUBLIC_SUPABASE_URL", process.env.SUPABASE_URL);
  const key = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  const db = createClient(url, key, { auth: { persistSession: false } });

  const names = Object.keys(VOICEMAIL_PLAN);
  const { data, error } = await db
    .from("ai_flows")
    .select("id,name,definition")
    .eq("business_id", businessId)
    .in("name", names);
  if (error) {
    console.error(`Read failed: ${error.message}`);
    process.exit(1);
  }
  const rows = (data ?? []) as Array<{ id: string; name: string; definition: Definition }>;
  const missing = names.filter((n) => !rows.some((r) => r.name === n));
  if (missing.length > 0) {
    console.error(`Flows not found on ${businessId}: ${missing.join(", ")}`);
    process.exit(2);
  }

  for (const row of rows) {
    const previous = JSON.parse(JSON.stringify(row.definition)) as Definition;
    const def = JSON.parse(JSON.stringify(row.definition)) as Definition;
    let result: PatchResult;
    try {
      result = patchVoicemails(row.name, def);
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(2);
    }
    if (!result.changed) {
      console.log(`${row.name}: every call already has its message.`);
      continue;
    }
    try {
      parseAiFlowDefinition(def);
    } catch (e) {
      console.error(`${row.name} would become INVALID, aborting before any write:`);
      if (e instanceof AiFlowValidationError) for (const s of e.issues) console.error(`  - ${s}`);
      else console.error(e);
      process.exit(2);
    }
    console.log(`${row.name}: ${result.touched.join(", ")}`);
    if (!apply) continue;
    const { error: upErr } = await db
      .from("ai_flows")
      .update({ definition: def })
      .eq("id", row.id);
    if (upErr) {
      console.error(`Update failed for ${row.name}: ${upErr.message}`);
      process.exit(1);
    }
    console.log("  -> updated.");
    await recordOneshotApplied(db, {
      scriptPath: process.argv[1] ?? "amy-voicemail-scripts.ts",
      businessId,
      details: {
        flow_id: row.id,
        flow_name: row.name,
        touched: result.touched,
        previous_definition: previous
      }
    });
  }
  if (!apply) console.log("\n[dry-run] Nothing written. Re-run with --apply.");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
