#!/usr/bin/env tsx
/**
 * One-shot: give Amy's AI email as a follow-up vehicle.
 *
 * Brian, 2026-08-18, on a ReferralExchange team offer that read "A
 * ReferralExchange lead arrived with NO phone number, so the AI cannot text
 * or call them. Somebody has to work this one by hand.": "Add email as a
 * vehicle for follow ups for ai."
 *
 * WHAT AN EMAIL-ONLY LEAD GETS TODAY. Traced against Valerie Marino's live
 * run (89d9025e, ReferralExchange, 2026-08-18): the flow offers her to the
 * team, emails her ONCE, tells Amy nobody could be texted, and stops. Every
 * SMS and call step skipped, because `sms_lead_type` and `route_lead_type`
 * both read "none" for a lead with no phone option. There is no follow-up of
 * any kind after that single email.
 *
 * WHY THIS CANNOT JUST REUSE THE EXISTING CADENCE. "Needs Follow Up (AI
 * cadence)" is triggered by a TAG on a contact, and `update_contact` takes a
 * `phoneVar`. Contacts are keyed `(business_id, customer_e164)`, so an
 * email-only lead has no contact row at all (confirmed: Valerie has none) and
 * cannot be tagged. Every round of that cadence is also call + text +
 * wait_for_reply, and `wait_for_reply` takes a phoneVar. So the email cadence
 * has to live inside the flow that already holds the lead, where
 * {{vars.lead_email}} is in scope.
 *
 * SHAPE. Appended to the END of each flow's top-level steps, which is a pure
 * append: the flattened id list keeps its existing prefix, so no parked run
 * changes meaning. Runs already in flight reach the new block on their way
 * out, which is deliberate. Valerie's run is parked at index 36 and will get
 * the cadence.
 *
 *   no phone?  ->  has email?  ->  wait a day
 *                                  read the mailbox
 *                                  still nothing?  ->  send, wait, read again
 *                                                      still nothing? -> send, wait, read
 *                                                                        still nothing? -> send
 *
 * The rounds NEST rather than sit flat, so a reply on day one both stops the
 * remaining sends and alerts the owner exactly once. Flat steps gated on the
 * stop var would have re-alerted on every later round, because the var is
 * sticky by design.
 *
 * READING REPLIES. `wait_for_reply` is SMS-only, so the reply check is an
 * `email_extract` poll of Amy's connected Outlook, the same mechanism the
 * bad-phone branch already uses for bounce detection (bp_bounce_check). It
 * deliberately carries NO `fromContains`: a bounce notice comes from a
 * postmaster, not from the lead, so matching on the lead's ADDRESS APPEARING
 * in the message catches both a real reply and a delivery failure, and one
 * Gemini field says which. `lookbackMinutes` maxes at 1440, which is exactly
 * the gap between rounds.
 *
 * `noMatchVars` is not optional polish here. Without it the step writes
 * nothing when no mail matches, the stop var never exists, and every gate
 * reading it sits inert. Amy's HomeLight reveal ladder failed exactly that
 * way on 2026-08-16.
 *
 * NOT INCLUDED, and why:
 *  - Leads WITH a phone are untouched. Brian chose email-only rather than
 *    adding email to every round, so a lead getting calls and texts keeps
 *    getting exactly those.
 *  - HomeLight Referral is left alone: it already runs its own three-rung
 *    email ladder to the lead (lead_email, late_lead_email, late2_lead_email).
 *  - A claim does NOT stop the cadence, matching Amy's standing rule that a
 *    claim is a teammate saying they will work the lead, not evidence anyone
 *    was reached (PR #1438). Valerie's run is claimed by Gabrielle Mota and
 *    still gets the emails.
 *
 * Usage:
 *   npx tsx scripts/oneshot/amy-email-followup-cadence.ts            # dry run
 *   npx tsx scripts/oneshot/amy-email-followup-cadence.ts --apply
 *   npx tsx scripts/oneshot/amy-email-followup-cadence.ts --revert --apply
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { loadEnv } from "../../debug/_shared";
import { recordOneshotApplied } from "./_ledger";
import {
  AMY_BUSINESS_ID,
  EFU,
  ROUND_GAP_MINUTES,
  buildEmailFollowUpBlock,
  type Definition
} from "./_amy-email-followup-block";

export {
  AMY_BUSINESS_ID,
  AMY_MAILBOX_CONNECTION_ID,
  EFU,
  FOLLOW_UPS,
  ROUND_GAP_MINUTES,
  buildEmailFollowUpBlock,
  stopVar
} from "./_amy-email-followup-block";

/** Flows that leave an email-only lead with nothing. HomeLight has its own ladder. */
export const TARGET_FLOWS = [
  "ReferralExchange Lead",
  "Realtor.com Lead",
  "New Lead Intake",
  "Clever Lead - Accept"
] as const;

export function alreadyPatched(def: Definition): boolean {
  return def.steps.some((s) => s.id === `${EFU}_root`);
}

/** Append the block. Returns false when it is already there. */
export function applyEmailFollowUp(def: Definition, notes: string[]): boolean {
  if (alreadyPatched(def)) return false;
  const producesEmail = JSON.stringify(def).includes("lead_email");
  const producesPhone = JSON.stringify(def).includes("lead_phone");
  if (!producesEmail || !producesPhone) {
    throw new Error(
      "flow does not produce lead_email/lead_phone; the gates would be rejected by the validator"
    );
  }
  def.steps.push(buildEmailFollowUpBlock());
  notes.push(`appended ${EFU}_root (3 email rounds, ${ROUND_GAP_MINUTES}min apart)`);
  return true;
}

export function revertEmailFollowUp(def: Definition, notes: string[]): boolean {
  const before = def.steps.length;
  def.steps = def.steps.filter((s) => s.id !== `${EFU}_root`);
  if (def.steps.length === before) return false;
  notes.push(`removed ${EFU}_root`);
  return true;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const revert = process.argv.includes("--revert");
  loadEnv();
  const db: SupabaseClient = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL as string,
    process.env.SUPABASE_SERVICE_ROLE_KEY as string
  );

  const { data, error } = await db
    .from("ai_flows")
    .select("id,name,definition")
    .eq("business_id", AMY_BUSINESS_ID)
    .is("deleted_at", null);
  if (error) throw new Error(`read flows: ${error.message}`);

  const touched: Array<Record<string, unknown>> = [];
  for (const name of TARGET_FLOWS) {
    const row = (data ?? []).find((f) => f.name === name);
    if (!row) {
      console.log(`SKIP  ${name}: not found`);
      continue;
    }
    const def = JSON.parse(JSON.stringify(row.definition)) as Definition;
    const previous = row.definition;
    const notes: string[] = [];
    const changed = revert ? revertEmailFollowUp(def, notes) : applyEmailFollowUp(def, notes);
    if (!changed) {
      console.log(`SKIP  ${name}: already in the desired state`);
      continue;
    }
    console.log(`${apply ? "APPLY" : "DRY  "} ${name}: ${notes.join("; ")}`);
    if (!apply) continue;
    const { error: upErr } = await db
      .from("ai_flows")
      .update({ definition: def, edit_source: "oneshot", edit_actor: "amy-email-followup-cadence.ts" })
      .eq("business_id", AMY_BUSINESS_ID)
      .eq("id", row.id)
      .select("id")
      .single();
    if (upErr) throw new Error(`update ${name}: ${upErr.message}`);
    touched.push({ flow_id: row.id, name, notes, previous_definition: previous });
  }

  if (apply && touched.length > 0) {
    await recordOneshotApplied(db, {
      scriptPath: process.argv[1],
      businessId: AMY_BUSINESS_ID,
      details: { revert, flows: touched }
    });
  }
  console.log(apply ? `\nDone: ${touched.length} flow(s) updated.` : "\nDry run. Re-run with --apply.");
}

if (process.argv[1]?.endsWith("amy-email-followup-cadence.ts")) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
