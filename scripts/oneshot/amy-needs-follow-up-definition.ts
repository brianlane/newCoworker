/**
 * Pure builder for Amy Laidlaw's "Needs Follow Up" cadence.
 *
 * WHAT IT DOES. A lead tagged "Needs Follow Up" (by a teammate texting "F",
 * by the dashboard tag editor, or by any other tagger) gets called by the AI
 * every three days. When nobody picks up, the AI leaves a voicemail and then
 * texts. It stops the moment the lead replies or books, or a teammate claims
 * them.
 *
 * THE THREE RULES THIS FLOW EXISTS TO HONOR, in Amy's words:
 *
 *   1. "Follow up once every three days with a call along with an SMS if they
 *      don't answer / it goes to voicemail. The AI should leave the voicemail
 *      then send the SMS." Hence the rung shape: sleep, call, and a text sent
 *      ONLY on a no-answer. A lead who actually spoke to the AI does not also
 *      get a text saying we could not reach them.
 *   2. "For claimed leads the employee should only receive the update from the
 *      lead, otherwise broadcast the update as an alert." Hence
 *      `notify_lead_owner` after the goal, which resolves the owner AT RUN
 *      TIME so a lead claimed mid-cadence reaches the right person. See the
 *      note on that step for the half of this rule that is not yet expressible.
 *   3. "Nothing to notify if the lead is cold and not responding." Hence the
 *      notice being gated on the lead having actually said something. A lead
 *      who ignores all eight rounds ends the cadence with `lead_reply` still
 *      "no_reply" and nobody is paged.
 *
 * WHY THE COPY VARIES PER ROUND. Eight identical texts and eight identical
 * voicemails from one number over three and a half weeks reads as a
 * malfunction. Each round says something a little different, the later ones
 * are shorter, and the last says it is the last.
 *
 * WHAT THE MESSAGES REFERENCE. Amy asked for the lead's source site and city
 * plus whether they are buying or selling. All three are extracted from the
 * contact event, and all three carry an explicit "none" fallback, because SMS
 * bodies render with collapseEmpty but the voicemail script does not: an
 * absent var would otherwise be spoken as a gap mid-sentence.
 *
 * Pure: no I/O, no Supabase. The applier owns reading, validating and writing.
 */

/** The tag that starts the cadence. Written by the "F" reply and the tag editor. */
export const FOLLOW_UP_TAG = "Needs Follow Up";

/** Amy's line, given in every message. */
const CALLBACK = "602-695-1142";

/** Three days between rounds, in minutes. */
export const ROUND_GAP_MINUTES = 3 * 24 * 60;

/** How many rounds before the AI stops. Eight rounds is a little over 3 weeks. */
export const ROUNDS = 8;

/**
 * Calling hours, Phoenix. `outside: "skip"` rather than "defer" is deliberate:
 * a round that comes due at 2am should drop its call and let the rest of the
 * cadence stay on schedule, not park the whole run until morning and push
 * every later round back with it.
 */
const CALL_WINDOW = {
  timezone: "America/Phoenix",
  start: "08:30",
  end: "20:00",
  outside: "skip" as const
};

/** What the AI says when a person picks up, per round. */
function persona(round: number): string {
  const opener =
    round === 1
      ? "Hi, is this {{vars.lead_name.first}}? I'm calling from Amy Laidlaw's office at HomeSmart."
      : "Hi {{vars.lead_name.first}}, Amy Laidlaw's office at HomeSmart again.";
  return (
    `${opener} We're following up on your enquiry through {{vars.lead_site}} about ` +
    "{{vars.lead_intent}} in {{vars.lead_city}}. Is now a good moment? " +
    "If they are still interested, find out what they need next and offer to connect them with " +
    "Amy or one of her agents. If they are not interested any more, thank them warmly and say " +
    "we will stop calling. Never ask them when to call back."
  );
}

/**
 * Voicemail per round. Short, because nobody can reply to it and recordings
 * cut off, and varied, because eight identical ones read as a fault.
 */
const VOICEMAILS: readonly string[] = [
  "Hi {{vars.lead_name.first}}, this is Amy Laidlaw's office at HomeSmart, following up on your enquiry through {{vars.lead_site}} about {{vars.lead_intent}} in {{vars.lead_city}}. " +
    `We'd love to help. Give us a call back at ${CALLBACK}.`,
  "Hi {{vars.lead_name.first}}, Amy Laidlaw's office at HomeSmart again about {{vars.lead_intent}} in {{vars.lead_city}}. " +
    `Amy has worked this market since 1989 and is happy to answer a question or two with no obligation. ${CALLBACK}.`,
  "Hi {{vars.lead_name.first}}, Amy Laidlaw's team at HomeSmart. " +
    `If the timing is not right, that is completely fine. We can just send you what is happening with prices in {{vars.lead_city}}. ${CALLBACK}.`,
  "Hi {{vars.lead_name.first}}, checking in from Amy Laidlaw's office at HomeSmart about {{vars.lead_intent}}. " +
    `We have an appraiser on the team, so the numbers we give you are real ones. ${CALLBACK}.`,
  "Hi {{vars.lead_name.first}}, Amy Laidlaw's team at HomeSmart. " +
    `The {{vars.lead_city}} market moves, so whatever you were told a few weeks ago may not hold today. Happy to bring you current at ${CALLBACK}.`,
  "Hi {{vars.lead_name.first}}, Amy Laidlaw's office at HomeSmart. " +
    `Still here whenever {{vars.lead_intent}} is back on your mind. ${CALLBACK}.`,
  "Hi {{vars.lead_name.first}}, Amy Laidlaw's team at HomeSmart. " +
    `We will stop after one more message. If you would like to talk before then, we are at ${CALLBACK}.`,
  "Hi {{vars.lead_name.first}}, this is our last call from Amy Laidlaw's office at HomeSmart. " +
    `We will leave you be now. If anything changes we would be glad to hear from you at ${CALLBACK}.`
];

/** The text that follows a voicemail, per round. Mirrors it without repeating it. */
const TEXTS: readonly string[] = [
  "Hi {{vars.lead_name.first}}, Amy Laidlaw's office at HomeSmart. We just left you a voicemail about your enquiry through {{vars.lead_site}} regarding {{vars.lead_intent}} in {{vars.lead_city}}. " +
    `Reply here any time, or call ${CALLBACK}.`,
  "Hi {{vars.lead_name.first}}, following up again on {{vars.lead_intent}} in {{vars.lead_city}}. " +
    "Even if you are months away, we can tell you what to expect. Just reply here.",
  "Hi {{vars.lead_name.first}}, Amy Laidlaw's team. Want us to send recent {{vars.lead_city}} sales so you can see where prices are? Reply yes and we will send them over.",
  "Hi {{vars.lead_name.first}}, still happy to help with {{vars.lead_intent}} whenever you are ready. We have an appraiser on the team, so our numbers are real ones.",
  "Hi {{vars.lead_name.first}}, quick check in from Amy Laidlaw's office. Has anything changed with your plans in {{vars.lead_city}}?",
  "Hi {{vars.lead_name.first}}, Amy Laidlaw's team at HomeSmart. Still here whenever {{vars.lead_intent}} is back on your mind.",
  "Hi {{vars.lead_name.first}}, we will stop after one more message. If you would like to talk before then, just reply here.",
  "Hi {{vars.lead_name.first}}, this is our last message. We will stop reaching out now, and we would be glad to hear from you any time at " +
    `${CALLBACK}. All the best with your move.`
];

/** Fields read off the contact-event text that starts the run. */
export const READ_FIELDS = [
  { name: "lead_name", description: "The lead's full name from the name line" },
  { name: "lead_phone", description: "The lead's phone number from the phone line, in E.164" },
  {
    name: "lead_site",
    description:
      "Which site or service this lead came from, from the tags or text (e.g. Clever, " +
      "HomeLight, Realtor.com, RealEstateAgents.com). If it does not say, answer exactly: " +
      "your recent enquiry"
  },
  {
    name: "lead_city",
    description:
      "The city the lead is buying or selling in, from the text (e.g. Mesa). If it does not " +
      "say, answer exactly: the area"
  },
  {
    name: "lead_intent",
    description:
      "What the lead wants, as a short phrase that fits after 'about': answer exactly " +
      "'buying a home' or 'selling your home', or 'your move' when the text does not say which"
  }
];

type Step = Record<string, unknown>;

/**
 * One round: call (leaving a voicemail), text only if nobody answered, then
 * wait up to three days for the lead to say something.
 *
 * The wait IS the gap between rounds, which is what makes the whole cadence
 * gateable. A `goal` step would have been the obvious way to stop on a reply,
 * but its reached-marker (`__goal_<id>`) is underscore-prefixed and a `when`
 * guard's var must start with a letter, so nothing downstream can branch on
 * it. `wait_for_reply`'s saveAs is an ordinary var: "no_reply" after a
 * timeout, the lead's words otherwise.
 */
function roundSteps(n: number): Step[] {
  const i = n - 1;
  return [
    {
      id: `r${n}_call`,
      type: "place_ai_call",
      toVar: "lead_phone",
      personaTemplate: persona(n),
      contextTemplate:
        "Their name: {{vars.lead_name}}. They enquired through {{vars.lead_site}} about " +
        "{{vars.lead_intent}} in {{vars.lead_city}}. Do not ask them for details we already have.",
      voicemailTemplate: VOICEMAILS[i],
      notifyOwner: true,
      callWindow: CALL_WINDOW,
      saveAs: "call_outcome"
    },
    {
      id: `r${n}_text`,
      type: "send_sms",
      to: "{{vars.lead_phone}}",
      body: TEXTS[i],
      // Only when the call did not reach a person. Someone who just spoke to
      // the AI must not also get "we tried to reach you".
      when: { var: "call_outcome", equals: "no_answer" }
    },
    {
      id: `r${n}_wait`,
      type: "wait_for_reply",
      phoneVar: "lead_phone",
      saveAs: "lead_reply",
      timeoutMinutes: ROUND_GAP_MINUTES
    }
  ];
}

/**
 * Rounds 2 and later, each wrapped in a branch that only runs while the lead
 * has still said nothing.
 *
 * FLAT, not nested: the same shape the Clever spoke check uses on this
 * account, and branch nesting is capped at 3 levels anyway. A reply in round 2
 * leaves every later round's guard unmet, so the cadence simply stops.
 */
function laterRound(n: number): Step {
  return {
    id: `r${n}`,
    type: "branch",
    question: `Round ${n}: has the lead said anything yet?`,
    when: { var: "lead_reply", equals: "no_reply" },
    branches: [
      {
        id: `r${n}_go`,
        label: "Still silent, keep following up",
        condition: { var: "lead_reply", equals: "no_reply" },
        steps: roundSteps(n)
      }
    ],
    else: []
  };
}

/**
 * The whole definition.
 *
 * The notice sits last and is gated on the lead having actually said
 * something. That gate is rule 3 ("nothing to notify if the lead is cold"):
 * without it, every lead who ignored all eight rounds would page the team at
 * the end of the cadence.
 */
export function buildNeedsFollowUpDefinition(): Record<string, unknown> {
  const steps: Step[] = [
    { id: "read_lead", type: "extract_text", fields: READ_FIELDS },
    ...roundSteps(1),
    ...Array.from({ length: ROUNDS - 1 }, (_, i) => laterRound(i + 2)),
    // Booked or claimed are EXTERNAL milestones nothing in this flow observes,
    // so they stay a goal: either one jumps the run out of a parked wait and
    // stops the AI calling someone a teammate has already taken.
    {
      id: "converted",
      type: "goal",
      label: "Booked or claimed by a teammate",
      events: [{ kind: "appointment_booked" }, { kind: "claimed" }]
    },
    /**
     * Who hears that the lead came back.
     *
     * `notify_lead_owner` resolves `contacts.owner_employee_id` AT RUN TIME,
     * which is the property that matters: a lead claimed halfway through the
     * cadence is owned by someone the extraction at step 0 could not have
     * known about, so a gate built on an owner var read at the start would
     * notify the wrong person.
     *
     * Claimed goes to that teammate alone, which is Amy's rule. UNCLAIMED
     * falls back to the business owner rather than broadcasting to the whole
     * team, and that is the one part of the ask this does not yet do
     * faithfully: there is no informational team-broadcast primitive.
     * `route_to_team` broadcasts, but as a claim OFFER with a deadline and a
     * fallback, which is a different thing from an alert.
     */
    {
      id: "tell_owner",
      type: "notify_lead_owner",
      phoneVar: "lead_phone",
      nameVar: "lead_name",
      message:
        "FOLLOW-UP REPLY: {{vars.lead_name}} ({{vars.lead_phone}}) came back to us on the AI " +
        "follow-up sequence. They enquired through {{vars.lead_site}} about {{vars.lead_intent}} " +
        'in {{vars.lead_city}}. They said: "{{vars.lead_reply}}"',
      when: { var: "lead_reply", notEquals: "no_reply" }
    }
  ];

  return {
    version: 1,
    trigger: {
      channel: "tag_changed",
      tag: FOLLOW_UP_TAG,
      change: "added",
      conditions: []
    },
    // A lead re-tagged while a cadence is already running must not get two
    // sets of calls. The existing run is the follow-up.
    options: { allowReentry: false },
    steps
  };
}
