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

export const AMY_BUSINESS_ID = "621a5b0d-c2ad-449f-9d74-9d50e7b27fa3";

/** Amy's connected Outlook, the same one every send_email in these flows uses. */
export const AMY_MAILBOX_CONNECTION_ID = "9ddd5344-14f2-46df-a89d-dddc2d50e944";

/** Prefix for every step this script adds, so a revert can find them. */
export const EFU = "efu";

/** One day between rounds, and the widest lookback email_extract allows. */
export const ROUND_GAP_MINUTES = 1440;

type Step = Record<string, unknown> & {
  id: string;
  type: string;
  steps?: Step[];
  branches?: Array<{ id: string; label?: string; condition?: unknown; steps?: Step[] }>;
  else?: Step[];
};
type Definition = { version: number; trigger: unknown; steps: Step[]; options?: unknown };

/**
 * What the mailbox poll is asked to decide. One field with three answers
 * rather than two fields, because a step `when` carries exactly one
 * condition, so a single var keeps each gate to one comparison.
 *
 * PER ROUND, not one shared var. A shared var is sticky once it reads
 * "replied", so a flat cadence gated on it would re-alert the owner on every
 * later round for a single reply. Giving each round its own var makes each
 * alert fire at most once, and lets round N+1's steps gate on round N's
 * answer, which is what carries the "stop everything" cascade without
 * nesting a branch per round (the schema caps branch nesting at 3 levels).
 */
export function stopVar(round: number): string {
  return `efu_stop_${round}`;
}

const STOP_FIELD_DESCRIPTION =
  "Answer exactly one lowercase word. replied: a genuine reply written by the lead " +
  "themselves. bounced: a delivery failure or undeliverable notice (postmaster, address " +
  "not found, mailbox full). none: anything else, including out-of-office auto-replies " +
  "and any message that merely mentions this person.";

/** The three follow-ups, in order. Amy's voice, and short enough to read on a phone. */
export const FOLLOW_UPS: ReadonlyArray<{ subject: string; body: string }> = [
  {
    subject: "Following up on your home search, {{vars.lead_name}}",
    body:
      "Hi {{vars.lead_name}},\n\n" +
      "I reached out yesterday and wanted to make sure my note did not get buried.\n\n" +
      "I do not have a phone number for you, so email is the best way for us to start. " +
      "If you just reply to this message with a good time and a number, I will call you myself.\n\n" +
      "A few things I can send over in the meantime, whichever is useful:\n" +
      "- what homes like yours have actually sold for nearby, not the online estimate\n" +
      "- what it would take to get yours ready, and what is not worth spending on\n" +
      "- a straight answer on timing in this market\n\n" +
      "Amy Laidlaw\nLicensed since 1989 | Phoenix, AZ\n602-695-1142"
  },
  {
    subject: "Still happy to help, {{vars.lead_name}}",
    body:
      "Hi {{vars.lead_name}},\n\n" +
      "Checking in once more. I know an inquiry can be a passing thought, and that is completely fine.\n\n" +
      "If you are still looking, replying with one line is enough and I will take it from there. " +
      "If the timing has moved out to later this year, tell me roughly when and I will simply " +
      "check back then instead of filling your inbox.\n\n" +
      "Either answer is genuinely useful to me.\n\n" +
      "Amy Laidlaw\n602-695-1142"
  },
  {
    subject: "Last note from me, {{vars.lead_name}}",
    body:
      "Hi {{vars.lead_name}},\n\n" +
      "This is my last note, so I am not cluttering your inbox.\n\n" +
      "If anything changes, whether that is next month or next year, just reply to this email " +
      "and it comes straight to me. I will keep your details on file and nothing further will " +
      "be sent automatically.\n\n" +
      "Wishing you the best with it either way.\n\n" +
      "Amy Laidlaw\nLicensed since 1989 | Phoenix, AZ\n602-695-1142"
  }
];

/** The mailbox poll that decides whether the cadence keeps going. */
function checkStep(round: number): Step {
  const step: Step = {
    id: `${EFU}_check_${round}`,
    type: "email_extract",
    connectionId: AMY_MAILBOX_CONNECTION_ID,
    // No fromContains on purpose: a bounce is sent by a postmaster, not by
    // the lead, so match on their ADDRESS APPEARING anywhere in the message.
    matchTemplates: ["{{vars.lead_email}}"],
    lookbackMinutes: ROUND_GAP_MINUTES,
    fields: [{ name: stopVar(round), description: STOP_FIELD_DESCRIPTION }],
    // Load-bearing: without it a quiet mailbox writes nothing, the var never
    // exists, and every gate below reads "" and sits inert.
    noMatchVars: { [stopVar(round)]: "none" }
  } as Step;
  // Rounds after the first only look at all when the previous round found
  // nothing. A skipped check leaves its var unwritten, which reads as "" and
  // fails every gate below it, so one stop cascades through the rest.
  if (round > 1) step.when = { var: stopVar(round - 1), equals: "none" };
  return step;
}

function sleepStep(round: number): Step {
  const step: Step = {
    id: `${EFU}_wait_${round}`,
    type: "sleep",
    minutes: ROUND_GAP_MINUTES
  } as Step;
  if (round > 1) step.when = { var: stopVar(round - 1), equals: "none" };
  return step;
}

function sendStep(round: number): Step {
  const copy = FOLLOW_UPS[round - 1];
  return {
    id: `${EFU}_send_${round}`,
    type: "send_email",
    to: "{{vars.lead_email}}",
    subject: copy.subject,
    body: copy.body,
    fromConnectionId: AMY_MAILBOX_CONNECTION_ID,
    when: { var: stopVar(round), equals: "none" }
  } as Step;
}

/**
 * What happens when the poll comes back with something. A reply goes to
 * whoever owns the lead; a bounce goes to the owner, because an address that
 * does not exist means nobody can reach this lead at all and the team offer
 * they were sent is now pointing at nothing.
 */
function stopSteps(round: number): Step[] {
  return [
    {
      id: `${EFU}_replied_${round}`,
      type: "notify_lead_owner",
      when: { var: stopVar(round), equals: "replied" },
      message:
        `{{vars.lead_name}} REPLIED to the AI follow-up email (round ${round}). ` +
        "They have no phone number on file, so answer them by email at {{vars.lead_email}}. " +
        "No further automated emails will be sent.",
      unownedFallback: "team"
    } as Step,
    {
      id: `${EFU}_bounced_${round}`,
      type: "notify_owner",
      when: { var: stopVar(round), equals: "bounced" },
      message:
        `\u203c\ufe0f\u203c\ufe0f\u203c\ufe0f\u203c\ufe0f\u203c\ufe0f\nEmail to {{vars.lead_name}} BOUNCED at round ${round}: {{vars.lead_email}} is not a working address. ` +
        "This lead had no phone number either, so there is now no way to reach them. " +
        "Nothing further will be sent."
    } as Step
  ];
}

/** One round: wait, read the mailbox, then send or stop. */
function roundSteps(round: number): Step[] {
  return [sleepStep(round), checkStep(round), sendStep(round), ...stopSteps(round)];
}

/**
 * Build the block. Flat rounds inside two gates: the schema caps branch
 * nesting at three levels, and a branch per round would have been five.
 */
export function buildEmailFollowUpBlock(): Step {
  const rounds: Step[] = [1, 2, 3].flatMap((n) => roundSteps(n));

  // Two nested gates rather than one: a step `when` carries exactly one
  // condition, and this needs both "no phone" and "has an email".
  return {
    id: `${EFU}_root`,
    type: "branch",
    question: "Can we reach this lead by phone?",
    branches: [
      {
        id: `${EFU}_has_phone`,
        // The SAME predicate the flows' own no-phone guards use, so the two
        // can never disagree about what "has a phone" means.
        label: "Has a phone: the call and text follow-up already covers them",
        condition: { var: "lead_phone", contains: "+" },
        steps: []
      }
    ],
    else: [
      {
        id: `${EFU}_email_gate`,
        type: "branch",
        question: "Do we at least have an email address for them?",
        branches: [
          {
            id: `${EFU}_has_email`,
            label: "Email only: the AI follows up by email",
            condition: { var: "lead_email", contains: "@" },
            steps: rounds
          }
        ],
        else: []
      } as Step
    ]
  } as Step;
}

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
