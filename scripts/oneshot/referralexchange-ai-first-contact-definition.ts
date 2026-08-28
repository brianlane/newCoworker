/**
 * Pure builder: put ReferralExchange / RealEstateAgents.com leads on the AI
 * worker for FIRST contact, the way Clever and HomeLight already are.
 *
 * Amy's ask, in her words: "set up RealEstateAgents.com / ReferralExchange
 * leads to be handled completely by AI worker like Clever/HomeLight are in
 * terms of calling the lead before having Amy's employee call. Then if the
 * lead is serious the AI worker will do a live transfer attempt to one of us,
 * and if we're not available then have the lead let us know the next best time
 * to call and route the lead to the team with all the previous info along with
 * the info from the phone call. If the lead doesn't answer it falls into the
 * follow up sequence."
 *
 * FOUR THINGS THAT ARE NOT OBVIOUS:
 *
 * 1. ALL THREE LEAD TYPES, each with its own script. ReferralExchange delivers
 *    buyer, seller and both, unlike Clever and HomeLight which are seller-only,
 *    and a buyer and a seller do not want to hear the same call. The existing
 *    `amy-seller-ai-call-definition.ts` has a ReferralExchange variant but it
 *    is seller-gated, so it could never have covered this.
 *
 * 2. THE CALLBACK-TIME QUESTION IS ALLOWED HERE, AND ONLY HERE. This account's
 *    standing rule is that we never ask a lead when to call back: Amy calls
 *    back fast rather than booking an appointment to call, and
 *    `removeBestTimeCaptureField` swept that capture out of New Lead Intake on
 *    Aug 7. Amy narrowed the rule on Aug 11: the question is fine in the one
 *    moment where the lead ASKED to be connected and nobody picked up. Since
 *    `captureFields` are per step and cannot be conditional, the SCRIPT carries
 *    the condition: the AI is told to ask about timing only after a transfer
 *    attempt fails.
 *
 * 3. NO ANSWER FALLS INTO THE CADENCE VIA THE TAG. Rather than duplicating the
 *    three-day ladder here, a no-answer tags the contact "Needs Follow Up",
 *    which is the same chokepoint the "F" reply and the dashboard tag editor
 *    use, so the cadence flow starts exactly as it would from any other
 *    tagger. One ladder, one place to change it.
 *
 * 4. $1M+ LEADS ARE STILL AMY'S. The call is gated on
 *    `price_band == "under_1m"`, a POSITIVE gate, so a missing band reads as ""
 *    and the call skips: every gate on a dial path fails closed. Same rule the
 *    Clever ladder already follows.
 *
 * The route_to_team chain that follows is untouched: Dave still owns the
 * follow-up, and the offer now carries what the call learned.
 *
 * Pure: no I/O. The applier reads, validates, writes and records.
 */

/** The tag whose flow is the three-day AI cadence. */
export const FOLLOW_UP_TAG = "Needs Follow Up";

/**
 * Marker on the tag event telling the cadence this ladder ALREADY called and
 * texted the lead, so its round 1 starts with the 3-day wait instead of a
 * second call two minutes later. Lockstep copy of AUTO_TAG_NOTE in
 * amy-needs-follow-up-definition.ts (asserted equal in tests); the cadence
 * matches on the `auto_first_contact` prefix.
 */
export const AUTO_TAG_NOTE =
  "auto_first_contact: the AI already called and texted this lead just now";

/** Roster refs the applier resolves by name at apply time, never hardcoded. */
export type Ref = { id: string; label: string; source: "employee" };

type Step = Record<string, unknown>;

/** Lead types ReferralExchange delivers. */
export const LEAD_TYPES = ["buyer", "seller", "both"] as const;
export type LeadType = (typeof LEAD_TYPES)[number];

/**
 * What the AI opens with, per lead type.
 *
 * Every script ends with the same three rules, which is where the transfer
 * behavior and the narrowed callback-time exception live. They are spelled out
 * rather than implied because this is the copy that goes to a stranger
 * unsupervised.
 */
const CLOSING_RULES =
  "If they are serious and want to speak to someone now, use the reach tool to connect them to a " +
  "teammate. If nobody picks up, apologize honestly, say a member of the team will call them " +
  "shortly, and ONLY THEN ask what time of day suits them best for that callback and record it. " +
  "Do not ask about timing at any other point in the call. Never quote a price or a valuation.";

export const PERSONAS: Record<LeadType, string> = {
  buyer:
    "You are calling for the Amy Laidlaw Team at HomeSmart, a real estate team in the Phoenix area. " +
    'Open with: "Hi {{vars.lead_name.first}}, this is the Amy Laidlaw Team with HomeSmart, calling about your ' +
    'home search through {{vars.web_source}}. Is now a good time?" Find out what they are looking for: ' +
    "area, bedrooms, budget, and how soon they want to move. " +
    CLOSING_RULES,
  seller:
    "You are calling for the Amy Laidlaw Team at HomeSmart, a real estate team in the Phoenix area. " +
    'Open with: "Hi {{vars.lead_name.first}}, this is the Amy Laidlaw Team with HomeSmart, calling about ' +
    'selling your home, which you inquired about through {{vars.web_source}}. Is now a good time?" Find out ' +
    "their timeline, whether they have listed before, and whether they are also buying. Amy has an " +
    "appraiser on the team and prices with precision, which is worth mentioning. " +
    CLOSING_RULES,
  both:
    "You are calling for the Amy Laidlaw Team at HomeSmart, a real estate team in the Phoenix area. " +
    'Open with: "Hi {{vars.lead_name.first}}, this is the Amy Laidlaw Team with HomeSmart, calling about your ' +
    'move, which you inquired about through {{vars.web_source}}. Is now a good time?" They are both selling ' +
    "and buying, so cover the sale first (timeline, whether they have listed before) and then what they " +
    "want to buy. " +
    CLOSING_RULES
};

/** Voicemail per lead type. Short: nobody can reply to it and recordings cut off. */
export const VOICEMAILS: Record<LeadType, string> = {
  buyer:
    "Hi {{vars.lead_name.first}}, this is the Amy Laidlaw Team with HomeSmart, calling about your home search " +
    "through {{vars.web_source}}. We would love to help you find the right place. Call us back at 602-695-1142.",
  seller:
    "Hi {{vars.lead_name.first}}, this is the Amy Laidlaw Team with HomeSmart, calling about selling your home " +
    "through {{vars.web_source}}. We would love to help. Call us back at 602-695-1142.",
  both:
    "Hi {{vars.lead_name.first}}, this is the Amy Laidlaw Team with HomeSmart, calling about your move, which " +
    "you inquired about through {{vars.web_source}}. We would love to help with both sides of it. " +
    "Call us back at 602-695-1142."
};

/**
 * The reach ladder. Dave and Gabby take turns ringing first
 * (`rotateFirst: 2`, cursor on ai_flow_team_members.last_reach_first_at) and
 * Amy stays the last resort, matching the Clever ladder exactly so one
 * account does not have two different ideas of who gets rung first.
 */
function reach(refs: { dave: Ref; gabby: Ref; amy: Ref }): Record<string, unknown> {
  return {
    refs: [refs.dave, refs.gabby, refs.amy],
    ringSeconds: 20,
    rotateFirst: 2,
    preSmsTemplate:
      "LIVE TRANSFER incoming, pick up!\n{{vars.lead_type}} lead {{vars.lead_name}} ({{vars.lead_phone}}) " +
      "from {{vars.web_source}} in {{vars.location}}.\nThey are on the line now."
  };
}

/** The call step for one lead type. */
export function buildCall(type: LeadType, refs: { dave: Ref; gabby: Ref; amy: Ref }): Step {
  return {
    id: `ai_call_${type}`,
    type: "place_ai_call",
    toVar: "lead_phone",
    personaTemplate: PERSONAS[type],
    contextTemplate:
      "Their name: {{vars.lead_name}}. They inquired through {{vars.web_source}} and are a " +
      "{{vars.lead_type}} in {{vars.location}}. Do not ask them for anything we already know.",
    voicemailTemplate: VOICEMAILS[type],
    reachTeammate: reach(refs),
    // The post-call summary follows whoever the ladder rang first, so the
    // teammate who nearly took the call is the one who hears how it went.
    notifyFirstReachTarget: true,
    captureFields: ["what they want", "timeline", "best time to call back", "notes"],
    // NO callWindow, deliberately, and matching Clever's attempt-1 dial.
    //
    // This is first contact on a lead that just landed, and speed to lead is
    // the entire point. A window with outside:"skip" resolves an overnight
    // lead to `not_placed`, which is not `no_answer`, so the follow-up tag
    // never fires either: the lead would miss BOTH the AI call and the cadence
    // (Bugbot, #1308). Only the RETRY rungs elsewhere carry windows, because a
    // redial is the thing that must not land at 3am.
    saveAs: "call_outcome",
    // Amy keeps $1M+ leads herself, so the AI never dials one. Positive gate:
    // a missing price_band reads as "" and the call SKIPS.
    when: { var: "price_band", equals: "under_1m" }
  };
}

/**
 * The whole insert: one branch choosing the script by lead type, then a
 * no-answer tag that hands the lead to the three-day cadence.
 *
 * Returned as a list so the applier can splice it in front of the existing
 * route chain without knowing its shape.
 */
export function buildAiFirstContactSteps(refs: { dave: Ref; gabby: Ref; amy: Ref }): Step[] {
  return [
    {
      id: "ai_first_contact",
      type: "branch",
      question: "Which script should the AI open with?",
      branches: LEAD_TYPES.map((t) => ({
        id: `ai_call_${t}_arm`,
        label: `${t} lead`,
        // route_lead_type, NOT lead_type. Both exist on this flow and only one
        // says anything about REACHABILITY: route_lead_type is "the page shows
        // a text or call option, meaning the lead has a real phone number, and
        // here is the type", answering "none" for an email-only lead. Gating a
        // DIAL on lead_type would have validated fine and selected an arm, and
        // then tried to call leads with no phone (Bugbot, #1308). It is also
        // the field the three route steps already gate on.
        condition: { var: "route_lead_type", equals: t },
        steps: [buildCall(t, refs)]
      })),
      else: []
    },
    {
      // No answer hands the lead to the cadence rather than repeating its
      // ladder here: same chokepoint the "F" reply uses, so there is one
      // follow-up sequence and one place to change it.
      id: "ai_no_answer_followup",
      type: "update_contact",
      phoneVar: "lead_phone",
      addTags: [FOLLOW_UP_TAG],
      // Tell the cadence we already called and texted, so its round 1 starts
      // at the 3-day wait rather than dialing again two minutes later.
      noteTemplate: AUTO_TAG_NOTE,
      when: { var: "call_outcome", equals: "no_answer" }
    }
  ];
}

/** Step ids this builder owns, so the applier can detect a prior run. */
export const INSERTED_STEP_IDS = ["ai_first_contact", "ai_no_answer_followup"] as const;

/** True when the flow already carries this change. */
export function hasAiFirstContact(def: { steps?: Step[] }): boolean {
  return (def.steps ?? []).some((s) => s.id === "ai_first_contact");
}

/**
 * Splice the AI-first-contact steps in immediately before the first
 * route_to_team step, so the AI talks to the lead BEFORE the team is offered
 * it, and the offer that follows can quote what the call learned.
 *
 * Throws rather than guessing when there is no route step: the live flow would
 * have changed shape, and inserting a dial ladder into a definition we no
 * longer recognize is exactly the wrong response to that.
 */
export function insertAiFirstContact(
  def: { steps?: Step[] },
  refs: { dave: Ref; gabby: Ref; amy: Ref }
): boolean {
  if (hasAiFirstContact(def)) return false;
  const steps = def.steps ?? [];
  const routeIdx = steps.findIndex((s) => s.type === "route_to_team");
  if (routeIdx < 0) {
    throw new Error(
      "no route_to_team step found; the live flow changed shape, re-read it before patching"
    );
  }
  steps.splice(routeIdx, 0, ...buildAiFirstContactSteps(refs));
  def.steps = steps;
  return true;
}

/**
 * Add what the call produced to every team-facing offer on the flow.
 *
 * ONLY the outcome vars appear here, and that is a constraint rather than a
 * choice: `place_ai_call` produces its outcome var and the two companions
 * (`_reason`, `_label`) and NOTHING else. `captureFields` are not flow vars.
 * They are collected by the AI and delivered in the POST-CALL SUMMARY text,
 * which `notifyFirstReachTarget` sends to whoever the ladder rang first, so
 * the detail does reach a person: it just cannot be templated into an offer.
 * Referencing {{vars.timeline}} here would have been rejected by the authoring
 * validator, and would have rendered empty if it had not been.
 */
export const CALL_RESULT_BLOCK =
  "\nThe AI already called them: {{vars.call_outcome_label}}.\n" +
  "Whoever the AI rang first has the full call summary with what they want, " +
  "their timeline, and when they asked to be called back.";

export function withCallResult(template: string): string {
  return template.includes("The AI already called them") ? template : template + CALL_RESULT_BLOCK;
}
