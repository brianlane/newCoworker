/**
 * Pure builder: the "HomeLight Update Request" flow.
 *
 * THE HOLE THIS CLOSES. HomeLight texts Amy from +1 415-549-1442 asking for
 * referral feedback:
 *
 *   "Great job connecting with Nicole! You have 2 referrals that are pending
 *    your feedback. Let HomeLight know how we can improve your referral
 *    quality. https://hmlt.co/26cefca0"
 *
 * No flow claims that number, so it falls through to the general assistant. On
 * 2026-08-07 that produced a 30-message robot loop over 16 minutes: our AI
 * answered HomeLight's autoresponder, addressed it as "Aaron", and kept going
 * until HomeLight's one-way replies ran out. PR #1239's robot-loop cap is what
 * stopped the Aug 13 nudge doing the same, so the number is still unowned and
 * the cap is the only thing standing between us and a repeat.
 *
 * WHAT THIS FLOW DOES, AND DELIBERATELY DOES NOT DO.
 *
 * It extracts the link and the counts, texts Amy, and replies to nobody
 * (`suppressDefaultReply`). It submits NOTHING to HomeLight.
 *
 * That restraint is the decision, not an omission. HomeLight's feedback prompt
 * asks the agent to rate REFERRAL QUALITY, which is a subjective judgement that
 * shapes the referrals she is sent next. A canned weekly answer from an
 * automation is worth less to her than thirty seconds of her own opinion, and
 * could actively degrade her lead flow. Brian's stated preference was exactly
 * this: if the only surface is a subjective quality rating, build no
 * submission. The separate STAGE update (`Update Referral Stage` on the agent
 * dashboard) is factual and is tracked separately; this flow does not touch it.
 *
 * Two extractions are worth the AI call because they make the alert actionable
 * without Amy opening anything: how many referrals are waiting, and who the
 * text names.
 *
 * Pure: no I/O. The seeder validates, inserts and records the ledger.
 */
import type { AiFlowDefinition } from "@/lib/ai-flows/schema";

/** The number HomeLight sends feedback requests from. */
export const FEEDBACK_SENDER = "4155491442";

/**
 * Smallest stable fragment of the nudge.
 *
 * Anchored on the ask, not on the greeting: "Great job connecting with
 * <Name>!" is templated per lead and the sentence around it has already been
 * reworded once on other HomeLight surfaces. "pending your feedback" is the
 * part that states what the message wants.
 */
export const FEEDBACK_NEEDLE = "pending your feedback";

/** Vars the flow produces. */
export const LINK_VAR = "feedback_url";
export const COUNT_VAR = "pending_feedback_count";
export const NAME_VAR = "feedback_client_name";

export const FLOW_NAME = "HomeLight Update Request";

/** Step ids. Never reuse or rename one on a live flow. */
export const STEP_URL = "url";
export const STEP_DETAILS = "details";
export const STEP_NOTIFY = "notify";

export const ALERT_MESSAGE =
  `HomeLight wants your feedback on {{vars.${COUNT_VAR}}} referral(s)` +
  ` (most recent: {{vars.${NAME_VAR}}}).\n\n` +
  `These ratings shape the referrals HomeLight sends you, so they are worth` +
  ` answering yourself. Your assistant has not replied to them.\n\n` +
  `{{vars.${LINK_VAR}}}`;

export function buildDefinition(
  opts: { sender?: string; needle?: string } = {}
): AiFlowDefinition {
  const sender = opts.sender ?? FEEDBACK_SENDER;
  const needle = opts.needle ?? FEEDBACK_NEEDLE;
  return {
    version: 1,
    trigger: {
      channel: "sms",
      correlationWindowMinutes: 2,
      conditions: [
        { type: "from_matches", value: sender },
        { type: "has_url" },
        { type: "contains", value: needle, caseInsensitive: true }
      ]
    },
    // The whole point: HomeLight's number is an autoresponder, and answering it
    // is what produced the Aug 7 loop.
    options: { suppressDefaultReply: true, captureStepScreenshots: false },
    steps: [
      { id: STEP_URL, type: "extract_url", saveAs: LINK_VAR },
      {
        id: STEP_DETAILS,
        type: "extract_text",
        fields: [
          {
            name: COUNT_VAR,
            description:
              'How many referrals are pending feedback, e.g. "2" from "You have 2 referrals that ' +
              'are pending your feedback". Digits only. If the message states no number, return "1".'
          },
          {
            name: NAME_VAR,
            description:
              'The client first name the message names, e.g. "Nicole" from "Great job connecting ' +
              'with Nicole!". If the message names nobody, return "a recent referral".'
          }
        ]
      },
      { id: STEP_NOTIFY, type: "notify_owner", message: ALERT_MESSAGE }
    ]
  } as unknown as AiFlowDefinition;
}
