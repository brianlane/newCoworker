import { beforeAll, describe, expect, it } from "vitest";
import {
  SMS_CONVERSATION_QUALITY_LINE,
  SMS_GROUNDED_ACTIONS_LINE,
  SMS_IDENTITY_LINE
} from "../../supabase/functions/_shared/sms_prompt_lines";
import {
  REASONING_PROMPT_INSTRUCTION,
  splitReplyReasoning
} from "../../supabase/functions/_shared/reply_reasoning";
import {
  formatFlowAnswerNote,
  formatFlowRunContext
} from "../../supabase/functions/_shared/ai_flows/run_context";
import { buildCustomerPreambleForEdge } from "../../supabase/functions/_shared/customer_memory_preamble";
import { currentDateTimeLine } from "../../supabase/functions/_shared/datetime_line";
import { geminiChatReply } from "./gemini";
import { judgeReply, type JudgeVerdict } from "./judge";

/**
 * The Bryan replay (Amy Laidlaw Real Estate, 2026-07-14): a Clever lead
 * flow texted Bryan "When is a good time to discuss next steps for your
 * FREE Appraisal & your cash offers?", the flow ended, and Bryan answered
 * "Now is a good time" a day later. The generic AI path — WITH the
 * automation context and the fresh-thread answer anchor in place — still
 * replied "Great! What time works best for you?": it understood the answer
 * but bounced it back into a schedule-for-later negotiation instead of
 * acting on "now".
 *
 * This suite replays Bryan's turn with the production prompt builders and
 * the fleet SMS model, pinning the ACT-on-the-answer contract the
 * formatFlowAnswerNote act-now clause exists to enforce:
 *   - never re-ask the answered question or defer to finding times later;
 *   - move the conversation forward immediately (engage now or arrange a
 *     prompt human follow-up).
 */

const LEAD = "+17572390150";
const BRYAN_REPLY = "Now is a good time";

/** The fleet SMS_CHAT_MODEL default (deploy-client.sh). */
const SMS_MODEL = "gemini-2.5-flash";

/** The Clever flow's outreach text, verbatim from Amy's outbound log. */
const CLEVER_MESSAGE =
  "Hi Bryan.\n\n" +
  "I am an agent partner with Clever Real Estate.\n\n" +
  "I offer a FREE Certified Appraisal to all my sellers from my licensed " +
  "appraiser to give buyers confidence and keep them from lowballing you. " +
  "I'm licensed since 1989, one of the top agents in Arizona and sell homes " +
  "fast! We also have cash buyers on hand.\n\n" +
  "We will be emailing you a market analysis home valuation for your home.\n\n" +
  "When is a good time to discuss next steps for your FREE Appraisal & your " +
  "cash offers?\n\n" +
  "Thanks, Amy Laidlaw ~ HomeSmart 😊";

describe("Amy act-now replay — Bryan 2026-07-14 (generic path, real builders)", () => {
  let reply = "";
  let verdict: JudgeVerdict;

  beforeAll(async () => {
    const dateLine = currentDateTimeLine(
      new Date("2026-07-14T22:41:59Z"),
      "America/Phoenix"
    );
    const phoneLine =
      `Current texter phone: ${LEAD}. When calling customer tools ` +
      `(customer_lookup_by_phone, customer_set_display_name, ` +
      `customer_append_pinned_note), pass this exact value as the phone ` +
      `argument unless the texter explicitly refers to a different number.`;
    const memoryPreamble = buildCustomerPreambleForEdge({
      customer_e164: LEAD,
      display_name: "Bryan",
      summary_md: null,
      pinned_md: null,
      total_interaction_count: 1,
      last_channel: "sms",
      last_interaction_at: "2026-07-13T22:41:03+00:00"
    });
    const flowContext = formatFlowRunContext(
      [
        {
          flowName: "Clever Update Leads",
          status: "done",
          updatedAt: "2026-07-13T22:41:03+00:00",
          vars: { lead_name: "Bryan", lead_phone: LEAD }
        }
      ],
      [CLEVER_MESSAGE]
    )!;
    const system =
      [
        `${SMS_IDENTITY_LINE}\n\n${SMS_GROUNDED_ACTIONS_LINE}\n\n${SMS_CONVERSATION_QUALITY_LINE}\n\n${dateLine}\n\n${phoneLine}`,
        memoryPreamble,
        flowContext
      ]
        .filter((part): part is string => Boolean(part))
        .join("\n\n") + REASONING_PROMPT_INSTRUCTION;

    const note = formatFlowAnswerNote(CLEVER_MESSAGE);
    const raw = await geminiChatReply(
      system,
      [{ role: "user", text: `${note}\n\n[SMS] ${BRYAN_REPLY}` }],
      SMS_MODEL
    );
    reply = splitReplyReasoning(raw).reply;
    verdict = await judgeReply(
      "an automated outreach asked the seller lead 'when is a good time to " +
        "discuss next steps for your free appraisal and cash offers?', the " +
        "automation has ended, and the lead just answered that NOW is a good time",
      reply,
      {
        defers_to_scheduling:
          "Does the message ask the customer to pick or agree on a LATER time — " +
          "asking what time works best, offering to check available times, or " +
          "proposing to book a future slot? Saying a person will reach out / call " +
          "them now, shortly, or right away is NOT scheduling and counts as false; " +
          "continuing the discussion in this conversation right away is also false.",
        reasks_answered_question:
          "Does the message re-ask, in any phrasing, when the customer would be " +
          "available or what time is good — the exact question they just answered?",
        acts_now:
          "Does the message act on the customer's immediate availability — either " +
          "continuing the substantive conversation right now (asking about their " +
          "property/needs, discussing next steps) OR telling them a person will " +
          "contact them now / shortly / right away (immediate human follow-up " +
          "counts as acting now)?"
      }
    );
  }, 120_000);

  it("answers substantively", () => {
    expect(reply.trim().length).toBeGreaterThan(0);
  });

  it("acts on 'now' instead of deferring to a scheduling negotiation (the Bryan miss)", () => {
    if (verdict.answers.defers_to_scheduling || !verdict.answers.acts_now) {
      console.error("live reply:", reply);
      console.error("judge verdict:", JSON.stringify(verdict));
    }
    expect(verdict.answers.defers_to_scheduling).toBe(false);
    expect(verdict.answers.acts_now).toBe(true);
  });

  it("never re-asks the question the lead just answered", () => {
    if (verdict.answers.reasks_answered_question) {
      console.error("live reply:", reply);
      console.error("judge verdict:", JSON.stringify(verdict));
    }
    expect(verdict.answers.reasks_answered_question).toBe(false);
  });
});
