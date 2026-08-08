/**
 * Pure builders for Amy Laidlaw's seller auto-call ladder.
 *
 * Today two lead sources still wait on a human picking up the phone. Clever
 * "Lead - Accept" never contacts the seller at all, and "ReferralExchange
 * Lead" only texts them; in both, the actual dial is Dave Lane's job, pinned
 * by `route_to_team`. About 85 seller leads a month land, get filed, and sit.
 * Roughly a third are never claimed.
 *
 * This inverts first contact: the AI calls the seller within a minute and
 * pitches Amy for the listing, and only then does the flow continue to Dave
 * (who still owns the follow-up) and on to Amy. The `route_to_team` chain is
 * deliberately KEPT, because `claimed_agent` unlocks the whole downstream
 * pipeline that the QT email and both bad-phone tails read.
 *
 * No env, no `main()`, no I/O: every export here is a pure function over a
 * definition object, so the tests can pin exact output. The applier lives in
 * `amy-seller-ai-call-patch.ts`, the same split
 * `clever-spoke-check-definition.ts` uses.
 *
 * SCRIPT CONTENT IS AMY'S, APPROVED 2026-08-06. Do not reword the pitch
 * without her: the four talking points, the Clever cash-offer angle, and the
 * "never ask when to call back" rule are her instructions, not style choices.
 */
import type { AiFlowDefinition } from "@/lib/ai-flows/schema";

type Definition = AiFlowDefinition;
type Step = Definition["steps"][number];

/** Which lead source a ladder is being built for. Their scripts differ. */
export type SellerCallVariant = "clever" | "referral_exchange";

/** Amy's team, resolved from `ai_flow_team_members` by name at apply time. */
export const DAVE_NAME = "Dave Lane";
export const AMY_NAME = "Amy Laidlaw";
export const GABRIELLE_NAME = "Gabrielle Mota";

/** The callback number Amy wants spoken and texted. Her own line. */
export const CALLBACK_E164 = "+16026951142";
export const CALLBACK_SPOKEN = "602 695 1142";

/**
 * The retry ladder's shape, in ONE place. The offer copy below is generated
 * from these same constants rather than hand-typed, because a hand-typed "in
 * about 2 hours" silently becomes a lie the first time someone tunes the
 * sleep. Attempt 1 is immediate and ungated; 2 and 3 obey the calling window.
 */
export const ATTEMPT_2_DELAY_MINUTES = 120;
export const ATTEMPT_3_TIME = "08:30";

/**
 * Redials stay inside plausible hours. `businesses.business_hours` is null on
 * this account, so these are its own convention, and `outside: "skip"` is the
 * whole point: the flow-level window would DEFER, parking the entire run and
 * holding Dave's offer overnight along with the call.
 */
export const CALL_WINDOW = {
  timezone: "America/Phoenix",
  start: "08:30",
  end: "21:00",
  outside: "skip" as const
};

/** How long the run parks waiting on a call outcome. Bounds Dave's offer. */
export const CALL_WAIT_MINUTES = 20;

/**
 * What the AI already knows, so it never re-asks. Decision 9: this call is a
 * listing pitch, not an intake. That is also why no step here carries
 * `captureFields` at all: asking the model to collect fields is precisely what
 * turns a pitch into an interview.
 */
export const PITCH_CONTEXT = [
  "You already know all of this. NEVER ask for any of it:",
  "- Their name: {{vars.lead_name}}",
  "- Their phone: {{vars.lead_phone}} (you are calling it right now, never ask for it)",
  "- The property: {{vars.lead_address}}",
  "- Estimated value: {{vars.price}}"
].join("\n");

/** The four talking points, shared by both variants, in Amy's order. */
const TALKING_POINTS = [
  "1. We have a licensed appraiser on our team, so we price the home precisely and stop buyers from lowballing you.",
  "2. Our commissions are low and flexible, and we start from your bottom line rather than ours.",
  "3. We will pull neighborhood comparables and email them over so you can see what your home is really worth."
].join("\n");

/**
 * Rules the persona must enforce. Two of these are Amy's explicit
 * instructions and one of them CONTRADICTS a flow already live on this
 * account: New Lead Intake asks for "best time to reach them". Amy does not
 * want an appointment, she wants to call back fast.
 */
const PITCH_RULES = [
  "Hard rules:",
  "- NEVER ask when a good time to call back would be, and never propose a callback time. Not once.",
  "- Never ask for their phone number or their address. You already have both.",
  "- Do not interview them. This call is about winning the listing, not collecting information.",
  `- If they ask for Amy or anyone on the team, offer to get someone on the line right now, then call the transfer tool.`,
  "- After the points above, if they have nothing further, offer to connect them to the team. If they decline, thank them, wish them a good day, and end the call.",
  "- Keep it warm and brief. Do not use em dashes."
].join("\n");

/** Clever's variant. The cash-offer framing is Clever's own instruction to Amy. */
export const PITCH_CLEVER = [
  "You are calling on behalf of the Amy Laidlaw Team with HomeSmart, a real estate team in the Phoenix area.",
  "",
  "Open with: \"Hi {{vars.lead_name}}, this is the Amy Laidlaw Team with HomeSmart, calling about your request through Clever about selling your home on {{vars.lead_address}}. Is now a good time?\"",
  "",
  "Then work through these points naturally, in your own warm voice:",
  "",
  "0. Clever offered you a cash offer program, and the offers on your file are {{vars.cash_offers}}. Acknowledge it, then make the case plainly: listing the home almost always nets more than a quick cash sale, and we will show you the numbers rather than ask you to take our word for it.",
  TALKING_POINTS,
  "",
  PITCH_RULES
].join("\n");

/** ReferralExchange's variant. No cash-offer angle: that is Clever's alone. */
export const PITCH_REFERRAL_EXCHANGE = [
  "You are calling on behalf of the Amy Laidlaw Team with HomeSmart, a real estate team in the Phoenix area.",
  "",
  "Open with: \"Hi {{vars.lead_name}}, this is the Amy Laidlaw Team with HomeSmart, calling about your visit to {{vars.web_source}} about selling your home on {{vars.lead_address}}. Is now a good time?\"",
  "",
  "Then work through these points naturally, in your own warm voice:",
  "",
  TALKING_POINTS,
  "",
  PITCH_RULES
].join("\n");

/**
 * The SMS that goes to the teammate as the transfer starts. Worded as the
 * callback request Amy describes, because by the time the AI says "I have let
 * them know", this text has ALREADY gone out, which is what makes that line
 * true rather than a comfortable fiction.
 */
export const CALLBACK_REQUEST_SMS = [
  "Seller on the line NOW: {{vars.lead_name}} ({{vars.lead_phone}})",
  "Property: {{vars.lead_address}}",
  "The AI is connecting them to you. Pick up if you can.",
  "If you miss it, call them straight back."
].join("\n");

/**
 * The forward-looking half of the team offer. Generated from the ladder
 * constants above so the copy and the schedule can never drift apart.
 */
export function nextStepsLine(): string {
  const hours = ATTEMPT_2_DELAY_MINUTES / 60;
  return [
    `Next, unless you take it: the AI calls again in about ${hours} hours, then once more tomorrow morning.`,
    "It stops the moment they reply or book."
  ].join(" ");
}

/**
 * Decision 7: the offer says what the AI already DID and what it will do
 * NEXT. Two thirds of that is engine-maintained and free. `actions_taken` is
 * appended at every side-effecting step, and `call_outcome_label` is the human
 * phrase ("left them a voicemail"), not the raw `no_answer` token that texting
 * Dave "Result: no_answer" would produce.
 */
export function withAiCallLines(template: string, outcomeVar = "call_outcome"): string {
  if (template.includes("The AI already:")) return template;
  const block = [
    "",
    "The AI already: {{vars.actions_taken}}",
    `The call: {{vars.${outcomeVar}_label}}`,
    "",
    nextStepsLine(),
    ""
  ].join("\n");
  // Insert ahead of the claim instruction so the reply mechanics stay last,
  // which is where a skimming reader looks for them.
  const idx = template.indexOf("Reply 1");
  if (idx < 0) return `${template}\n${block}`;
  return `${template.slice(0, idx)}${block}\n${template.slice(idx)}`;
}

/**
 * A saved employee, resolved at APPLY time from `ai_flow_team_members` by
 * name. Never a hardcoded phone number and never a bare "Dave Lane" string:
 * this account's dossier lists that as a sharp edge, and a literal would
 * silently stop routing the day someone edits the roster.
 */
export type Ref = { id: string; label: string; source: "employee" };

/** How long each teammate's phone rings before the ladder moves on. */
export const REACH_RING_SECONDS = 20;

/** Build the immediate first-contact call step. No calling window: a lead at
 *  22:40 still gets called, which is the entire point of first contact. */
export function buildCallStep(
  id: string,
  variant: SellerCallVariant,
  refs: { dave: Ref; gabby: Ref; amy: Ref },
  opts: { attempt: 1 | 2 | 3 }
): Step {
  const step: Record<string, unknown> = {
    id,
    type: "place_ai_call",
    toVar: "lead_phone",
    personaTemplate: variant === "clever" ? PITCH_CLEVER : PITCH_REFERRAL_EXCHANGE,
    contextTemplate: PITCH_CONTEXT,
    // The second-leg ladder: Dave and Gabby take turns ringing first
    // (rotateFirst 2, speed-to-lead decision of 2026-08-08), Amy is always
    // the last resort, and the AI keeps the seller engaged throughout.
    reachTeammate: {
      refs: [refs.dave, refs.gabby, refs.amy],
      ringSeconds: REACH_RING_SECONDS,
      rotateFirst: 2,
      preSmsTemplate: CALLBACK_REQUEST_SMS
    },
    // The summary follows whoever actually rang first on this call.
    notifyFirstReachTarget: true,
    waitMinutes: CALL_WAIT_MINUTES,
    saveAs: "call_outcome"
  };
  // Attempts 2 and 3 are redials, so they obey quiet hours and SKIP rather
  // than defer. Attempt 1 deliberately carries no window at all.
  if (opts.attempt !== 1) step.callWindow = { ...CALL_WINDOW };
  return step as Step;
}

export const SELLER_CALL_STEP_IDS = ["ai_call_1", "call_followups", "lead_reached"] as const;

/** True when the ladder is already present, which makes the patch a no-op. */
export function hasSellerCallLadder(def: Definition): boolean {
  const present = new Set<string>();
  const walk = (steps: readonly Step[]): void => {
    for (const st of steps as readonly Record<string, unknown>[]) {
      present.add(String(st.id));
      if (st.type === "branch") {
        for (const arm of (st.branches as { steps: Step[] }[]) ?? []) walk(arm.steps);
        walk((st.else as Step[]) ?? []);
      }
    }
  };
  walk(def.steps as Step[]);
  return SELLER_CALL_STEP_IDS.every((id) => present.has(id));
}

/**
 * The follow-up tree, ONE trunk step. Everything after attempt 1 nests here
 * because the ReferralExchange trunk had 2 free slots under the old step cap
 * and goals must stay top-level (the engine skips nested goals: a jump onto
 * an unevaluated branch path is unsafe).
 *
 * Gate polarity matters in every rung:
 * - Arms select the STOP cases with `notEquals`, which fails open on a
 *   missing var: a broken `claimed_agent` reads as "", does not equal
 *   "none", so the arm matches and the rung does NOTHING. A data problem
 *   suppresses a redial rather than causing one.
 * - The dial path is always the `else`, reached only when every stop case
 *   failed to match.
 */
function buildFollowups(
  variant: SellerCallVariant,
  refs: { dave: Ref; gabby: Ref; amy: Ref },
  gate?: { var: string; equals: string }
): Step {
  const retry3: Record<string, unknown> = {
    id: "retry_3",
    type: "branch",
    question: "Still unclaimed and unreached after the second miss?",
    branches: [
      {
        id: "retry_3_claimed",
        label: "A human took the lead",
        condition: { var: "claimed_agent", notEquals: "none" },
        steps: []
      },
      // Only an attempt that actually REACHED someone stops the ladder here.
      // "notEquals no_answer" would be wrong: a redial outside the calling
      // window resolves to not_placed, and reading that as "reached" would
      // silently cancel the morning attempt for every evening lead, which is
      // the exact case the window skip exists to serve. not_placed and
      // failed fall through to the morning dial, whose own guards (opt-out,
      // cap, window) re-run and fail closed.
      {
        id: "retry_3_transferred",
        label: "The second call connected them live",
        condition: { var: "call_outcome", equals: "transferred" },
        steps: []
      },
      {
        id: "retry_3_answered",
        label: "The second call reached them",
        condition: { var: "call_outcome", equals: "answered" },
        steps: []
      }
    ],
    else: [
      {
        id: "retry_3_sleep",
        type: "sleep",
        untilTime: ATTEMPT_3_TIME,
        timezone: CALL_WINDOW.timezone
      },
      buildCallStep("ai_call_3", variant, refs, { attempt: 3 })
    ]
  };

  const retry2: Record<string, unknown> = {
    id: "retry_2",
    type: "branch",
    question: "Still unclaimed after the first miss?",
    branches: [
      {
        id: "retry_2_claimed",
        label: "A human took the lead",
        condition: { var: "claimed_agent", notEquals: "none" },
        steps: []
      }
    ],
    else: [
      { id: "retry_2_sleep", type: "sleep", minutes: ATTEMPT_2_DELAY_MINUTES },
      buildCallStep("ai_call_2", variant, refs, { attempt: 2 }),
      retry3
    ]
  };

  // `not_placed` means six different things now; surface the reason var
  // rather than making someone guess. `failed` alerts too, without
  // retrying: a telephony failure retried blindly is how one seller gets
  // six dials.
  const gapAlert = (id: string, headline: string): Record<string, unknown> => ({
    id,
    type: "notify_owner",
    message: [
      `${headline} {{vars.lead_name}} ({{vars.lead_phone}}).`,
      "Reason: {{vars.call_outcome_reason}}",
      "Property: {{vars.lead_address}}",
      "Nobody has been dialed by the AI on this lead. It needs a human call."
    ].join("\n")
  });

  const followups: Record<string, unknown> = {
    id: "call_followups",
    type: "branch",
    question: "Did the AI reach the seller?",
    branches: [
      {
        id: "cf_not_placed",
        label: "The call never went out",
        condition: { var: "call_outcome", equals: "not_placed" },
        steps: [gapAlert("call_gap_alert", "Heads up: the AI did NOT call")]
      },
      {
        id: "cf_failed",
        label: "The call failed mid-flight",
        condition: { var: "call_outcome", equals: "failed" },
        steps: [gapAlert("call_fail_alert", "Heads up: the AI's call to the seller FAILED:")]
      },
      {
        id: "cf_no_answer",
        label: "No answer yet",
        condition: { var: "call_outcome", equals: "no_answer" },
        steps: [retry2]
      }
    ],
    // transferred / answered / empty (call skipped by its gate): nothing to
    // retry and nothing to alert.
    else: []
  };
  if (gate) followups.when = { ...gate };
  return followups as unknown as Step;
}

/**
 * Insert the ladder into a live definition: the call immediately BEFORE the
 * route step (so the offer Dave receives can already say what the call did),
 * the follow-up tree and the stop-goal immediately AFTER it, ahead of the
 * bad-phone tail whose parks would otherwise delay every rung by hours.
 *
 * Returns false when the ladder is already there, so `--apply` is idempotent
 * and a second run is a genuine no-op rather than a duplicate ladder.
 */
export function addSellerCallLadder(
  def: Definition,
  variant: SellerCallVariant,
  refs: { dave: Ref; gabby: Ref; amy: Ref },
  opts: {
    routeStepId: string;
    /**
     * Second required condition for the attempt-1 call. `when` holds exactly
     * one condition, so the price gate rides on the call step itself and
     * this one wraps it in a gate branch (the ReferralExchange seller
     * check).
     */
    callGate?: { var: string; equals: string };
  }
): boolean {
  if (hasSellerCallLadder(def)) return false;
  const steps = def.steps as Step[];
  const routeIdx = steps.findIndex((s) => s.id === opts.routeStepId);
  if (routeIdx < 0) {
    throw new Error(
      `route step "${opts.routeStepId}" not found; the live flow changed shape, re-read it before patching`
    );
  }

  const call = buildCallStep("ai_call_1", variant, refs, { attempt: 1 });
  // Amy keeps $1M+ leads herself, so the AI never dials one. Positive gate:
  // a missing price_band reads as "" and the call SKIPS, per the standing
  // rule that every gate on a dial path fails closed.
  (call as Record<string, unknown>).when = { var: "price_band", equals: "under_1m" };
  const attempt1: Step = opts.callGate
    ? ({
        id: "call_gate",
        type: "branch",
        question: "Is this a seller lead the AI should call?",
        branches: [
          {
            id: "call_gate_yes",
            label: "Seller with a dialable phone",
            condition: { ...opts.callGate },
            steps: [call]
          }
        ],
        else: []
      } as unknown as Step)
    : call;

  const followups = buildFollowups(variant, refs, opts.callGate);
  const goal: Step = {
    id: "lead_reached",
    type: "goal",
    label: "Seller reached",
    // Deliberately NOT `claimed`: a claim already stops the ladder via the
    // rung arms, and a goal on it would end the run the moment Dave taps 1,
    // before the AI has finished trying.
    events: [{ kind: "replied" }, { kind: "appointment_booked" }]
  } as unknown as Step;

  steps.splice(routeIdx, 0, attempt1);
  steps.splice(routeIdx + 2, 0, followups, goal);

  // The offer itself, on every template that carries one.
  const route = steps[routeIdx + 1] as unknown as Record<string, string>;
  for (const key of ["offerTemplate", "ownerFallbackTemplate"]) {
    if (typeof route[key] === "string") route[key] = withAiCallLines(route[key]);
  }
  if (
    typeof route.claimedNotifyTemplate === "string" &&
    !route.claimedNotifyTemplate.includes("stopped calling")
  ) {
    route.claimedNotifyTemplate = `${route.claimedNotifyTemplate}\nThe AI has stopped calling this lead.`;
  }
  return true;
}

/**
 * The Clever pitch names the cash offer amounts, so `read_details` must
 * extract them. The description is copied VERBATIM from the spoke-check
 * flow's `read_page` step, which already reads the same page through the
 * same integration: identical wording means identical extraction behavior,
 * and this flow was burned once before by perturbing a live extraction
 * step (the phone_lead_type incident).
 */
export const CASH_OFFERS_FIELD = {
  name: "cash_offers",
  description:
    "The cash offer amount(s) shown on the lead page (e.g. \"$412,000\" or \"$400,000 - $425,000\"), or 'none listed' when no cash offer is shown"
} as const;

/** Add cash_offers to the Clever read_details step. False when present. */
export function addCashOffersField(def: Definition): boolean {
  const step = (def.steps as Record<string, unknown>[]).find((st) => st.id === "read_details");
  if (!step) throw new Error("read_details step not found; re-read the live flow before patching");
  const fields = step.fields as { name: string }[] | undefined;
  if (!Array.isArray(fields)) throw new Error("read_details has no fields array");
  if (fields.some((f) => f.name === CASH_OFFERS_FIELD.name)) return false;
  fields.push({ ...CASH_OFFERS_FIELD });
  return true;
}

/**
 * Amy's rule: never ask when is a good time to call back, and never propose
 * a callback time. She wants to call back fast, not to an appointment. New
 * Lead Intake's call steps still ask the model to CAPTURE "best time to
 * reach them", which is the same question with extra steps, so the sweep
 * removes that capture field wherever it appears in the tree.
 */
export const BEST_TIME_CAPTURE_FIELD = "best time to reach them";

export function removeBestTimeCaptureField(def: Definition): boolean {
  let changed = false;
  const walk = (steps: readonly Step[]): void => {
    for (const st of steps as unknown as Record<string, unknown>[]) {
      const cap = st.captureFields as string[] | undefined;
      if (Array.isArray(cap) && cap.includes(BEST_TIME_CAPTURE_FIELD)) {
        // captureFields has min(1): removing the last field means removing
        // the whole key, never leaving an empty array behind.
        const next = cap.filter((f) => f !== BEST_TIME_CAPTURE_FIELD);
        if (next.length > 0) st.captureFields = next;
        else delete st.captureFields;
        changed = true;
      }
      if (st.type === "branch") {
        for (const arm of (st.branches as { steps: Step[] }[]) ?? []) walk(arm.steps);
        walk((st.else as Step[]) ?? []);
      }
    }
  };
  walk(def.steps as Step[]);
  return changed;
}

/**
 * Upgrade an ALREADY-APPLIED ladder from the single-target transfer to the
 * reach ladder, in place. The Clever flow went live with `transfer` (the
 * only shipped mechanism at the time); once reach_teammate deployed, this
 * swap points its three call steps at the Dave-then-Amy second leg. False
 * when every call step already carries the ladder, so re-running is a
 * no-op.
 */
export function upgradeCallsToReachLadder(
  def: Definition,
  refs: { dave: Ref; gabby: Ref; amy: Ref }
): boolean {
  let changed = false;
  const walk = (steps: readonly Step[]): void => {
    for (const st of steps as unknown as Record<string, unknown>[]) {
      if (
        st.type === "place_ai_call" &&
        typeof st.id === "string" &&
        /^ai_call_[123]$/.test(st.id) &&
        !st.reachTeammate
      ) {
        st.reachTeammate = {
          refs: [refs.dave, refs.gabby, refs.amy],
          ringSeconds: REACH_RING_SECONDS,
          rotateFirst: 2,
          preSmsTemplate: CALLBACK_REQUEST_SMS
        };
        delete st.transfer;
        changed = true;
      }
      if (st.type === "branch") {
        for (const arm of (st.branches as { steps: Step[] }[]) ?? []) walk(arm.steps);
        walk((st.else as Step[]) ?? []);
      }
    }
  };
  walk(def.steps as Step[]);
  return changed;
}
