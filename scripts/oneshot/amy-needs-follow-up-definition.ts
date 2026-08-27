/**
 * Pure builder for Amy Laidlaw's "Needs Follow Up" cadence.
 *
 * WHAT IT DOES. A lead tagged "Needs Follow Up" (by a teammate texting "F",
 * by the dashboard tag editor, or by any other tagger) gets called by the AI
 * every three days. When nobody picks up, the AI leaves a voicemail and then
 * texts. It stops the moment the lead replies or books. A teammate CLAIMING
 * the lead does not stop it: see the `converted` goal for why.
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
 *      who ignores every round ends the cadence with `lead_reply` still
 *      "no_reply" and nobody is paged.
 *
 * WHY THE COPY VARIES PER ROUND. Identical texts and identical voicemails
 * from one number over a week or more reads as a malfunction. Each round says
 * something a little different, and the last says it is the last.
 *
 * WHAT THE MESSAGES REFERENCE. Amy asked for the lead's source site and city
 * plus whether they are buying or selling. All are extracted from the contact
 * event (whose source line has carried contacts.lead_source since 2026-08-24),
 * and every field carries an explicit NON-EMPTY fallback. Not because of
 * rendering gaps: persona, voicemail, context and SMS bodies all render with
 * collapseEmpty (steps.ts, verified 2026-08-27). Three real reasons remain:
 * route_to_team offer/fallback templates render WITHOUT collapseEmpty (an
 * empty site would leave a bare "source:" in team copy), a `when` guard
 * cannot test emptiness, and collapsing a placeholder cannot remove the words
 * around it ("through" would dangle with no site after it).
 *
 * THE SITE IS TWO VARS, NOT ONE, because its two audiences need different
 * grammar and different fallbacks. The one-var version composed the fallback
 * into gibberish on live calls (call 68ca8cdb, Sandy Baldwin, 2026-08-26:
 * "following up on your enquiry through your recent enquiry about your move
 * in the area"). `lead_site` is the bare network name for team-facing copy
 * ("source: Clever", fallback "source: unknown"); `lead_site_ref` is the
 * phrase spoken TO the lead ("your enquiry through Clever", fallback "your
 * recent enquiry"), so the sentence stays grammatical when nothing is known.
 * The intent and city fallbacks ("your move", "the area") already compose in
 * place, and the fallback case is the COMMON one, not the edge: lead_city
 * fell back on 14 of 14 in-flight runs on 2026-08-27.
 *
 * Pure: no I/O, no Supabase. The applier owns reading, validating and writing.
 */

/** The tag that starts the cadence. Written by the "F" reply and the tag editor. */
import { buildEmailFollowUpBlock } from "./_amy-email-followup-block";

export const FOLLOW_UP_TAG = "Needs Follow Up";

/**
 * The verbatim marker an AUTOMATED first-contact ladder puts on the tag event
 * (update_contact's noteTemplate → the event's `note:` line) when it tags a
 * lead it has JUST called and texted. Round 1's call is gated on not seeing
 * it: without this, the cadence's immediate first call landed two minutes
 * after the first-contact call, and the lead got two voicemails in a row
 * (Jessica Gutierrez, Aug 12 2026). A manual tag (a teammate's "F", the
 * dashboard editor) carries no such note, so it keeps the immediate call a
 * human asking for follow-up expects.
 */
export const AUTO_TAG_NOTE =
  "auto_first_contact: the AI already called and texted this lead just now";

/**
 * The label an upstream flow uses to hand the cadence the lead type it
 * ALREADY knows.
 *
 * Why this exists (Sandy Baldwin, +1 320 293 1236, Aug 23 2026): the cadence
 * runs off a `tag_changed` event, and that event's text is the contact's
 * fields (name / phone / email / tags / source / tag / change / note). None of
 * those says whether the person is buying or selling, so `lead_type` fell to
 * its written default of "seller" on 42 of the flow's first 42 runs. Every
 * `r*_route_buyer` branch was therefore unreachable, and Jason Lane, whose
 * roster tag is buyer-only, could never be offered a lead this flow promoted.
 * Sandy was a ReferralExchange BUYER and her parked run says seller.
 *
 * The upstream flow does know: ReferralExchange, Realtor.com and New Lead
 * Intake each extract `lead_type` before they ever tag the lead. So the tag
 * carries it, on the SAME line as any existing note (the event renders one
 * `note:` line, and a newline here would put the type on a line the note
 * label does not cover).
 */
export const LEAD_TYPE_NOTE_LABEL = "lead_type:";

/**
 * Append the lead-type marker to a tag note, idempotently.
 *
 * Idempotence matters twice over: the one-shot that applies this is
 * re-runnable, and `auto_first_contact` must survive verbatim because round
 * 1's call gate (`tag_auto`) tests for that exact phrase. Appending never
 * disturbs it; a note that lacks it must NOT gain it, or a first call that
 * used to happen would silently stop.
 */
export function withLeadTypeNote(note: string | undefined | null, varName = "lead_type"): string {
  const base = typeof note === "string" ? note.trim() : "";
  if (base.includes(LEAD_TYPE_NOTE_LABEL)) return base;
  const marker = `${LEAD_TYPE_NOTE_LABEL} {{vars.${varName}}}`;
  return base ? `${base}; ${marker}` : marker;
}

/** Amy's line, given in every message. */
const CALLBACK = "602-695-1142";

/** Three days between rounds, in minutes. */
export const ROUND_GAP_MINUTES = 3 * 24 * 60;

/**
 * Promotion (Aug 12 2026, the under-$500K AI-owned rule): when a lead the AI
 * is working REPLIES and the reply reads as ready-for-a-human, the cadence
 * does not just alert the team, it hands the lead over with a claim OFFER, so
 * the moment of seriousness is also the moment of ownership. Sellers/both get
 * the same simultaneous three-name broadcast every seller route on this
 * account uses; buyers keep their rotation (Amy: "Do not change buyer leads").
 * A not-ready reply keeps today's behavior: an informational alert, no offer.
 *
 * This is safe for leads that were never price-gated (a teammate's manual "F"
 * tag on a $700K seller): a ready reply earning a claim offer is the desired
 * speed-to-lead behavior at any price, and a lead already claimed cannot get
 * here at all, because the `converted` goal ends the run on the claim event.
 */
export const BROADCAST_NAMES = ["Gabrielle Mota", "Amy Laidlaw", "Dave Lane"];

/** Quiet hours for offers, matching every other route step on this account. */
const OFFER_WINDOW = {
  timezone: "America/Phoenix",
  quietStart: "21:00",
  quietEnd: "08:30",
  graceMinutes: 10
};

/** Offer copy for a promoted lead. `nextLine` differs by routing style. */
function promoteOfferTemplate(nextLine: string): string {
  return (
    "READY LEAD, AI hands it over: {{vars.lead_name}} ({{vars.lead_phone}}) came back on the " +
    "AI follow-up sequence about {{vars.lead_intent}} in {{vars.lead_city}} " +
    "(source: {{vars.lead_site}}).\n" +
    'They just said: "{{vars.lead_reply}}"\n\n' +
    "Reply 1 to claim or 2 to pass by {{offer.deadline}}.\n" +
    'You can also reply "1, <ETA>" to claim and tell us when you\'ll reach out ' +
    '(e.g. "1, 20 min").\n' +
    nextLine
  );
}

/** The shared non-copy fields of a promotion route step. */
function promoteRouteBase(): Record<string, unknown> {
  return {
    type: "route_to_team",
    offerWindow: OFFER_WINDOW,
    responseMinutes: 10,
    shareContactHistory: true,
    claimedNotifyEmail: "amy@amylaidlaw.com",
    claimedNotifyTemplate:
      "{{agent.name}} claimed {{vars.lead_name}} ({{vars.lead_phone}}), the lead the AI " +
      "follow-up promoted after they said: \"{{vars.lead_reply}}\"\n" +
      "The AI has stopped working this lead.",
    // The leading banner is Amy's "not claimed" marker, applied account-wide
    // by amy-owner-notice-policy.ts. It lives in the builder too, or the next
    // re-seed of this flow would silently strip it back off. A test pins the
    // two literals equal.
    ownerFallbackTemplate:
      "‼️‼️‼️‼️‼️\n" +
      "No agent claimed {{vars.lead_name}} ({{vars.lead_phone}}), who told the AI follow-up " +
      'they are ready: "{{vars.lead_reply}}"\n' +
      "{{vars.lead_intent}} in {{vars.lead_city}}, source {{vars.lead_site}}. It's back to you."
  };
}

/**
 * How many rounds before the AI stops. Three rounds is a little over a week.
 *
 * It was eight (a little over 3 weeks) until 2026-08-17. Amy's rule is that a
 * lead should get "at least three tries", and that a claim no longer stops the
 * cadence (see the `converted` goal). Those two together are why this came
 * down: with the claim stop removed, eight rounds would have kept the AI
 * calling a lead a teammate already owns for over three weeks, and Amy's
 * stated tolerance for that was explicitly "it's only three times".
 */
export const ROUNDS = 3;

/**
 * Calling hours, Phoenix. `outside: "defer"`, and the reason is worth stating
 * because "skip" looks like the tidier choice and is catastrophic here.
 *
 * Each round waits exactly 72 hours, so every round lands at the SAME clock
 * time as the first. With "skip" a lead tagged at 2am resolves round 1 to
 * `not_placed`, which is not `no_answer`, so the text does not send either;
 * three days later it is 2am again, and so on for all eight rounds. One
 * unlucky tagging time and the lead is never contacted at all (Bugbot, #1307).
 *
 * "defer" parks the first round until 08:30 and every later round inherits
 * that daytime phase, which is exactly what is wanted.
 */
const CALL_WINDOW = {
  timezone: "America/Phoenix",
  start: "08:30",
  end: "20:00",
  outside: "defer" as const
};

/** What the AI says when a person picks up, per round. */
function persona(round: number): string {
  const opener =
    round === 1
      ? "Hi, is this {{vars.lead_name.first}}? I'm calling from Amy Laidlaw's office at HomeSmart."
      : "Hi {{vars.lead_name.first}}, Amy Laidlaw's office at HomeSmart again.";
  return (
    `${opener} We're following up on {{vars.lead_site_ref}} about ` +
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
  "Hi {{vars.lead_name.first}}, this is Amy Laidlaw's office at HomeSmart, following up on {{vars.lead_site_ref}} about {{vars.lead_intent}} in {{vars.lead_city}}. " +
    `We'd love to help. Give us a call back at ${CALLBACK}.`,
  "Hi {{vars.lead_name.first}}, Amy Laidlaw's office at HomeSmart again about {{vars.lead_intent}} in {{vars.lead_city}}. " +
    `Amy has worked this market since 1989 and is happy to answer a question or two with no obligation. ${CALLBACK}.`,
  "Hi {{vars.lead_name.first}}, Amy Laidlaw's team at HomeSmart. " +
    `If the timing is not right, that is completely fine. We can just send you what is happening with prices in {{vars.lead_city}}. ${CALLBACK}.`,
  "Hi {{vars.lead_name.first}}, checking in from Amy Laidlaw's office at HomeSmart about {{vars.lead_intent}}. " +
    `We have an appraiser on the team, so the numbers we give you are real ones. ${CALLBACK}.`,
  "Hi {{vars.lead_name.first}}, Amy Laidlaw's team at HomeSmart. " +
    `Prices in {{vars.lead_city}} keep moving, so whatever you were told a few weeks ago may not hold today. Happy to bring you current at ${CALLBACK}.`,
  "Hi {{vars.lead_name.first}}, Amy Laidlaw's office at HomeSmart. " +
    `Still here whenever {{vars.lead_intent}} is back on your mind. ${CALLBACK}.`,
  "Hi {{vars.lead_name.first}}, Amy Laidlaw's team at HomeSmart. " +
    `We will stop after one more message. If you would like to talk before then, we are at ${CALLBACK}.`,
  "Hi {{vars.lead_name.first}}, this is our last call from Amy Laidlaw's office at HomeSmart. " +
    `We will leave you be now. If anything changes we would be glad to hear from you at ${CALLBACK}.`
];

/** The text that follows a voicemail, per round. Mirrors it without repeating it. */
const TEXTS: readonly string[] = [
  "Hi {{vars.lead_name.first}}, Amy Laidlaw's office at HomeSmart. We just left you a voicemail about {{vars.lead_site_ref}} regarding {{vars.lead_intent}} in {{vars.lead_city}}. " +
    `Reply here any time, or call ${CALLBACK}.`,
  "Hi {{vars.lead_name.first}}, following up again on {{vars.lead_intent}} in {{vars.lead_city}}. " +
    "Even if you are months away, we can tell you what to expect. Just reply here.",
  "Hi {{vars.lead_name.first}}, Amy Laidlaw's team. Want us to send recent sales in {{vars.lead_city}} so you can see where prices are? Reply yes and we will send them over.",
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
      "Which site or service this lead came from. Prefer the source line when there is " +
      "one, it is the platform's own record of the network; otherwise use the tags or " +
      "text (e.g. Clever, HomeLight, Realtor.com, RealEstateAgents.com). If nothing says, " +
      "answer exactly: unknown"
  },
  {
    name: "lead_site_ref",
    description:
      "How to refer to the enquiry when speaking with the lead: the words 'your enquiry " +
      "through' followed by the same site as lead_site (e.g. your enquiry through Clever). " +
      "When lead_site is unknown, answer exactly: your recent enquiry"
  },
  {
    name: "lead_city",
    description:
      "The city the lead is buying or selling in, from the text (e.g. Mesa). If it does not " +
      "say, answer exactly: the area"
  },
  {
    name: "lead_type",
    description:
      "Is this lead buying or selling? Answer exactly one lowercase word: buyer, " +
      "seller, or both. When the note line carries a lead_type: value, answer that " +
      "value and nothing else, it is what the flow that filed this lead already " +
      "established. Only when nothing says, answer exactly: seller"
  },
  {
    name: "lead_email",
    description:
      "The lead's email address from the email line. If there is no email address, " +
      "answer exactly: none"
  },
  {
    name: "lead_intent",
    description:
      "What the lead wants, as a short phrase that fits after 'about': answer exactly " +
      "'buying a home' or 'selling your home', or 'your move' when the text does not say which"
  },
  {
    name: "tag_auto",
    description:
      "Does the note line contain the exact phrase auto_first_contact? Answer exactly one " +
      "lowercase word: yes or no. Answer no when there is no note line"
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
/**
 * The copy for a round. The LAST round always gets the sign-off wording,
 * whatever ROUNDS is, and the earlier rounds read from the front of the list.
 *
 * Indexing straight by round number looked simpler and silently broke when
 * ROUNDS came down from eight to three: the cadence would have ended on "Want
 * us to send recent sales?" and the "this is our last message" wording, which
 * is the whole reason a lead knows the calls have stopped, would never be
 * reached. A test pins this for whatever ROUNDS becomes next.
 */
function copyForRound(list: readonly string[], n: number): string {
  return n === ROUNDS ? list[list.length - 1] : list[n - 1];
}

function roundSteps(n: number): Step[] {
  return [
    {
      id: `r${n}_call`,
      type: "place_ai_call",
      toVar: "lead_phone",
      personaTemplate: persona(n),
      contextTemplate:
        "Their name: {{vars.lead_name}}. They enquired about {{vars.lead_intent}} in " +
        "{{vars.lead_city}} (source: {{vars.lead_site}}). Do not ask them for details we already have.",
      voicemailTemplate: copyForRound(VOICEMAILS, n),
      notifyOwner: true,
      callWindow: CALL_WINDOW,
      saveAs: "call_outcome",
      // Round 1 only: an auto-tag means an AI first-contact ladder called and
      // texted this lead MOMENTS ago, so the cadence's first touch is the
      // 3-day wait, not another call (see AUTO_TAG_NOTE). The skipped call
      // leaves call_outcome unset, which also keeps r1_text quiet (its
      // `equals no_answer` guard fails on a missing var) and lets round 2's
      // arms fall through to their else. Manual tags extract "no" (or the
      // field misses and reads ""), both of which keep today's immediate
      // call: the safe default is the old behavior.
      ...(n === 1 ? { when: { var: "tag_auto", notEquals: "yes" } } : {})
    },
    {
      id: `r${n}_text`,
      type: "send_sms",
      to: "{{vars.lead_phone}}",
      body: copyForRound(TEXTS, n),
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
    },
    /**
     * The notice lives INSIDE the round, immediately after the wait, and that
     * placement is the fix rather than a style choice.
     *
     * A single notice at the end gated on `lead_reply notEquals "no_reply"`
     * looks equivalent and is not: a missing var reads as "", which is also
     * not equal to "no_reply", so the guard PASSES. A `claimed` goal jump
     * during the very first call, before any wait had run, would therefore
     * have sent the owner a "they came back to us" notice quoting nothing, for
     * a lead who never said a word (Bugbot, #1307). Here the wait has just
     * written the var, so there is no unset case to mis-read.
     *
     * notify_lead_owner resolves contacts.owner_employee_id AT RUN TIME, so a
     * lead claimed mid-cadence reaches the right person: an owner var read at
     * step 0 could not have known about them. Claimed goes to that teammate
     * alone, which is Amy's rule. UNCLAIMED falls back to the business owner
     * rather than broadcasting to the team, and that is the one part of the
     * ask this does not yet do faithfully: there is no informational
     * team-broadcast primitive. route_to_team broadcasts, but as a claim OFFER
     * with a deadline and a fallback, which is a different thing from an alert.
     */
    /**
     * Is the reply a "get me a human" or just talk? Only classified when a
     * reply actually arrived: on a timeout `reply_intent` stays unset, and the
     * react branch below matches nothing. Stale values across rounds are
     * impossible by construction: any round that classified a reply also set
     * `lead_reply`, and every later round is gated on `lead_reply` still
     * being "no_reply".
     */
    {
      id: `r${n}_classify`,
      type: "classify",
      textVar: "lead_reply",
      saveAs: "reply_intent",
      question:
        "A lead in our AI follow-up sequence sent this reply. Are they ready to speak with a " +
        "human agent about their move now?",
      categories: [
        {
          value: "ready_to_talk",
          description:
            "asks for a call or an agent, proposes or accepts a time, says yes or interested, " +
            "asks about next steps, listing, touring, or getting their home priced"
        },
        {
          value: "not_ready",
          description:
            "anything else: thanks, not now, stop or unsubscribe, a question with no ask to " +
            "talk, or an unrelated message"
        }
      ],
      when: { var: "lead_reply", notEquals: "no_reply" }
    },
    /**
     * First-match branch, so a ready lead gets exactly ONE thing: the claim
     * offer (which quotes the reply). A not-ready reply falls to the else and
     * keeps today's informational alert. A timeout matches neither arm nor
     * fires the alert (its own when still requires a reply), which is rule 3:
     * nothing to notify when the lead is cold.
     */
    {
      id: `r${n}_react`,
      type: "branch",
      question: "The lead replied. Ready for a human, or just talking?",
      branches: [
        {
          id: `r${n}_ready`,
          label: "Ready: hand over with a claim offer",
          condition: { var: "reply_intent", equals: "ready_to_talk" },
          steps: [
            // Buyers keep the rotation and its accurate "next agent" wording.
            {
              id: `r${n}_route_buyer`,
              ...promoteRouteBase(),
              offerTemplate: promoteOfferTemplate("Pass and it goes to the next agent."),
              when: { var: "lead_type", equals: "buyer" }
            },
            // Sellers/both broadcast to the trio, first to claim, same as
            // every other seller route on this account.
            {
              id: `r${n}_route_seller`,
              ...promoteRouteBase(),
              agentNames: BROADCAST_NAMES,
              offerTemplate: promoteOfferTemplate("First to reply 1 gets it."),
              when: { var: "lead_type", equals: "seller" }
            },
            {
              id: `r${n}_route_both`,
              ...promoteRouteBase(),
              agentNames: BROADCAST_NAMES,
              offerTemplate: promoteOfferTemplate("First to reply 1 gets it."),
              when: { var: "lead_type", equals: "both" }
            }
          ]
        }
      ],
      else: [
        {
          id: `r${n}_tell_owner`,
          type: "notify_lead_owner",
          phoneVar: "lead_phone",
          nameVar: "lead_name",
          message:
            "FOLLOW-UP REPLY: {{vars.lead_name}} ({{vars.lead_phone}}) came back to us on the AI " +
            "follow-up sequence. They enquired about {{vars.lead_intent}} in {{vars.lead_city}} " +
            '(source: {{vars.lead_site}}). They said: "{{vars.lead_reply}}"',
          // Nobody owns this lead, so the TEAM hears it rather than Amy. Her
          // roster row already says team_broadcast_enabled false, so she is
          // excluded without naming anyone: she is the backstop for an unowned
          // lead, not its audience.
          //
          // The tag comes from the lead itself, so a buyer alert reaches whoever
          // is tagged buyer and a seller alert whoever is tagged seller. A tag
          // matching nobody alerts everyone, because a typo should cost noise and
          // never a lead.
          unownedFallback: "team",
          teamTagTemplate: "{{vars.lead_type}}",
          when: { var: "lead_reply", notEquals: "no_reply" }
        }
      ]
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
    // The guard says the lead has still said nothing. Which OUTCOMES stop the
    // cadence is decided by the arms below.
    when: { var: "lead_reply", equals: "no_reply" },
    // Stop ONLY when the lead was actually reached, the same shape the Clever
    // spoke check uses: empty arms for the reached outcomes, and the work in
    // `else`.
    //
    // The inverse (continue only on `no_answer`) reads equivalently and is
    // wrong twice over. Answering is not replying, so a lead who SPOKE to the
    // AI, possibly to say stop calling, has to end the cadence; but a
    // transient `failed`, or a `not_placed` from the fleet-wide dial cap,
    // would ALSO have ended it, abandoning a lead nobody ever reached because
    // one dial did not go out (Bugbot, #1307).
    branches: [
      {
        id: `r${n}_transferred`,
        label: "Already connected to a teammate",
        condition: { var: "call_outcome", equals: "transferred" },
        steps: []
      },
      {
        id: `r${n}_answered`,
        label: "The AI already spoke with them",
        condition: { var: "call_outcome", equals: "answered" },
        steps: []
      }
    ],
    else: roundSteps(n)
  };
}

/**
 * The whole definition.
 *
 * The notice sits last and is gated on the lead having actually said
 * something. That gate is rule 3 ("nothing to notify if the lead is cold"):
 * without it, every lead who ignored every round would page the team at
 * the end of the cadence.
 */
export function buildNeedsFollowUpDefinition(): Record<string, unknown> {
  const steps: Step[] = [
    { id: "read_lead", type: "extract_text", fields: READ_FIELDS },
    ...roundSteps(1),
    ...Array.from({ length: ROUNDS - 1 }, (_, i) => laterRound(i + 2)),
    // Booking is an EXTERNAL milestone nothing in this flow observes, so it
    // stays a goal: it jumps the run out of a parked wait and stops the AI
    // calling someone who has already put a time in the diary.
    //
    // A CLAIM deliberately does not. It used to, and Amy's rule as of
    // 2026-08-17 is that it must not: "if someone claims it and they don't
    // reach them it will work out. If someone claims it and they do reach them
    // then it can stay on follow up because it's only three times." A claim is
    // a teammate saying they will work the lead, which is not evidence anyone
    // has actually spoken to them, and the old behavior silently ended the
    // follow-up on that promise alone. What DOES stop the cadence is the lead
    // themselves: any reply leaves every later round's guard unmet, and a lead
    // who tells the AI they already spoke with someone is a reply like any
    // other.
    //
    // Note this event is business-wide by lead phone (applyGoalEvent), so the
    // claim that used to end this cadence was often raised by a different
    // flow's route_to_team entirely.
    /**
     * The email arm, for a lead the AI has no phone number for.
     *
     * PLACED BEFORE `converted`, and that is load-bearing rather than
     * tidiness. A goal step is a fast-forward TARGET: when the milestone
     * lands the run jumps straight to it and skips everything in between.
     * Sitting after the goal, this block would be the first thing a lead who
     * had just BOOKED walked into, and it would start emailing them. Before
     * it, a booking jumps over the whole arm, which is the point of the goal.
     *
     * The phone rungs above need no gating and get none. Each one already
     * degrades on its own when there is no dialable number: `place_ai_call`
     * resolves to `not_placed` rather than failing, `r{n}_text` is gated on
     * `no_answer` so it stays quiet, and `wait_for_reply`'s planner resolves
     * straight to the "no_reply" sentinel instead of parking a run that could
     * never be resumed. An email-only lead therefore reaches this arm in one
     * pass, with `lead_reply` reading exactly as it would for someone who
     * simply did not answer, which is what every guard above is already
     * written against.
     *
     * A KNOWN GAP, worth stating rather than implying this arm is airtight:
     * `applyGoalEvent` matches runs by phone, so an `appointment_booked`
     * event may never reach an email-only run and the `converted` jump below
     * may never fire for them. Placing this arm before the goal is still
     * right (it costs nothing, and it is correct the moment goal matching
     * learns email identity), but today a lead with no phone who books
     * elsewhere can still receive the remaining follow-ups. Bounded at three
     * emails over three days, and it stops the moment they reply.
     */
    buildEmailFollowUpBlock() as unknown as Step,
    {
      id: "converted",
      type: "goal",
      label: "Booked",
      events: [{ kind: "appointment_booked" }]
    },
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
