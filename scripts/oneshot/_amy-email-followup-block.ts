/**
 * The AI's email follow-up sequence for a lead it cannot text or call.
 *
 * Shared by BOTH places that need it, so the copy and the timing cannot drift
 * apart:
 *
 *   - scripts/oneshot/amy-email-followup-cadence.ts appends it to the
 *     lead-source flows (ReferralExchange, Realtor.com, New Lead Intake,
 *     Clever Accept), where an email-only lead never reaches the tag-triggered
 *     cadence at all;
 *   - scripts/oneshot/amy-needs-follow-up-definition.ts places it in the
 *     "Needs Follow Up (AI cadence)" flow, for a lead that DOES reach the
 *     cadence with an email and no phone.
 *
 * Templates here may only reference `lead_name` and `lead_email`, because
 * those are the two vars every host flow produces. Reaching for a richer var
 * (lead_site, lead_city) would validate in the cadence and be rejected in the
 * lead flows, whose extractors do not produce it.
 */
export const AMY_BUSINESS_ID = "621a5b0d-c2ad-449f-9d74-9d50e7b27fa3";

/** Amy's connected Outlook, the same one every send_email in these flows uses. */
export const AMY_MAILBOX_CONNECTION_ID = "9ddd5344-14f2-46df-a89d-dddc2d50e944";

/** Prefix for every step this script adds, so a revert can find them. */
export const EFU = "efu";

/** One day between rounds, and the widest lookback email_extract allows. */
export const ROUND_GAP_MINUTES = 1440;

export type Step = Record<string, unknown> & {
  id: string;
  type: string;
  steps?: Step[];
  branches?: Array<{ id: string; label?: string; condition?: unknown; steps?: Step[] }>;
  else?: Step[];
};
export type Definition = { version: number; trigger: unknown; steps: Step[]; options?: unknown };

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
    subject: "About your home search, {{vars.lead_name}}",
    body:
      "Hi {{vars.lead_name}},\n\n" +
      "I saw your enquiry come through and wanted to reach out personally.\n\n" +
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

/**
 * The mailbox poll that decides whether the cadence keeps going.
 *
 * KNOWN BOUND, shared with every other email_extract in this account: the
 * fetch returns at most EMAIL_FETCH_MAX_MESSAGES (25) inbox messages in the
 * window, newest first, and `fromContains` filters AFTER that fetch rather
 * than narrowing it. On a mailbox taking more than 25 messages a day (Amy's
 * takes lead alerts from four portals) a reply can sit outside those 25 and
 * read as "none".
 *
 * The consequence is bounded and deliberately accepted here: the cadence
 * sends one more email than it should, and the owner does not get the
 * proactive alert. The reply itself is not lost, because it is sitting in the
 * inbox this poll just read. The same exposure already applies to the bounce
 * check the bad-phone branch has been running for months.
 *
 * If it does bite, the fix belongs in src/lib/ai-flows/email-fetch.ts (raise
 * the cap, or push the sender filter into the Gmail/Graph query so the 25
 * applies to candidates rather than to all mail), not in this flow.
 */
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
  if (round > 0) step.when = { var: stopVar(round - 1), equals: "none" };
  return step;
}

function sleepStep(round: number): Step {
  const step: Step = {
    id: `${EFU}_wait_${round}`,
    type: "sleep",
    minutes: ROUND_GAP_MINUTES
  } as Step;
  // Every sleep waits only while the previous read found nothing, so a reply
  // stops the cadence instead of parking it for another day first.
  step.when = { var: stopVar(round - 1), equals: "none" };
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
      // Resolve the owner by NAME. This step keys on a phone var first and a
      // name var second, and an email-only lead has no phone to key on, so
      // without this every reply would take the unowned fallback and go to
      // the team even when a teammate has claimed the lead.
      nameVar: "lead_name",
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
 * The read that happens BEFORE any waiting.
 *
 * Round one sleeps a full day and then looks back a day, so its window opens
 * where the sleep began, not where the flow's own intro email went out. The
 * block runs at the END of the flow, after a team offer and a park that can
 * last hours, so a lead who answered the intro promptly would fall outside
 * round one's window entirely: the cadence would send three more emails to
 * someone who had already replied.
 *
 * This read covers the day leading up to the block instead, and its answer
 * gates the first sleep, so an early reply stops everything before it starts.
 */
function openingCheck(): Step[] {
  return [checkStep(0), ...stopSteps(0)];
}

/** Prefix for the TAG block that replaced the inline rounds in the lead flows. */
export const EFU_TAG = "efu_tag";

/**
 * The tag this puts on an email-only lead: the same one every other automated
 * ladder uses, because it is what starts "Needs Follow Up (AI cadence)".
 */
export const FOLLOW_UP_TAG = "Needs Follow Up";

/**
 * Why the tag was applied, carried into the cadence as {{trigger.note}}.
 *
 * Deliberately NOT the shared AUTO_TAG_NOTE. That one reads "the AI already
 * called and texted this lead just now", which is false here: this lead has no
 * phone, which is the entire reason they are being tagged. It also gates the
 * cadence's round-1 call (tag_auto), and that call is a harmless no-op for a
 * lead with no number, so there is nothing to suppress and no reason to lie.
 */
export const EMAIL_ONLY_TAG_NOTE =
  "email_only_lead: no phone number on file, so the AI emailed them and could not call or text";

/**
 * The lead-flow half of the split: TAG an email-only lead instead of running
 * the rounds inline.
 *
 * The rounds live in "Needs Follow Up (AI cadence)" and only there. Before
 * this, both places carried them, so tagging a lead would have sent six emails
 * instead of three, which is exactly why tagging was never switched on. One
 * copy, one place to edit the copy, and the cadence reached the way every
 * other follow-up reaches it.
 *
 * The gates are the SAME two predicates {@link buildEmailFollowUpBlock} uses,
 * from this same module, so "email only" can never come to mean two things.
 */
export function buildEmailOnlyTagBlock(): Step {
  return {
    id: `${EFU_TAG}_root`,
    type: "branch",
    question: "Can we reach this lead by phone?",
    branches: [
      {
        id: `${EFU_TAG}_has_phone`,
        label: "Has a phone: the call and text follow-up already covers them",
        condition: { var: "lead_phone", contains: "+" },
        steps: []
      }
    ],
    else: [
      {
        id: `${EFU_TAG}_email_gate`,
        type: "branch",
        question: "Do we at least have an email address for them?",
        branches: [
          {
            id: `${EFU_TAG}_has_email`,
            label: "Email only: hand them to the follow-up cadence",
            condition: { var: "lead_email", contains: "@" },
            steps: [
              {
                id: EFU_TAG,
                type: "update_contact",
                // The contact exists by now: the flow emailed this lead
                // earlier, and an email send files the lead as a contact
                // (PR #1486). emailVar is what lets the tag land on a contact
                // that has no phone to be keyed by.
                phoneVar: "lead_phone",
                emailVar: "lead_email",
                addTags: [FOLLOW_UP_TAG],
                noteTemplate: EMAIL_ONLY_TAG_NOTE
              } as Step
            ]
          }
        ],
        else: []
      } as Step
    ]
  } as Step;
}

/**
 * Build the block. Flat rounds inside two gates: the schema caps branch
 * nesting at three levels, and a branch per round would have been five.
 */
export function buildEmailFollowUpBlock(): Step {
  const rounds: Step[] = [...openingCheck(), ...[1, 2, 3].flatMap((n) => roundSteps(n))];

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

