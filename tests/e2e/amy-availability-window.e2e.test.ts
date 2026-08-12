import { beforeAll, describe, expect, it } from "vitest";
import {
  NO_EM_DASH_PROMPT_LINE,
  SMS_CONVERSATION_QUALITY_LINE,
  SMS_GROUNDED_ACTIONS_LINE,
  SMS_IDENTITY_LINE,
  SMS_TIME_HONESTY_LINE,
  SMS_TIMEZONE_LINE
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
 * The Kolton replay (Amy Laidlaw Real Estate, 2026-07-31): the
 * ReferralExchange intro asked the buyer lead "When is the best time to
 * communicate with you?", and at 8:02 PM Phoenix Kolton answered "Anytime
 * from 10am-2pm is the best time to communicate with me", a recurring daily
 * window, plus his home criteria. The live assistant, with the correct
 * "Friday, July 31, 8:03 PM MST" date line in its prompt, replied that
 * "someone will reach out ... between 10 AM and 2 PM Arizona time TODAY",
 * six hours after that window had closed, and its notify_team message told
 * the team the lead "is available today between 10am-2pm MST". Donna
 * Robinson's thread hit the same family hours earlier ("tomorrow (Friday,
 * July 31 or Saturday, August 1)" sent ON Friday Jul 31).
 *
 * This suite replays Kolton's turn with the production prompt builders and
 * the fleet SMS model, pinning the timing contract:
 *   - never promise contact today inside a window that has already ended;
 *   - any named follow-up timing must still be ahead (tomorrow / the next
 *     window / immediately), with immediate follow-up always allowed (the
 *     act-now contract in amy-act-now.e2e.test.ts is unaffected).
 *
 * A reply that points back at the lead's recurring window with NO day
 * attached ("someone will reach out within that window") satisfies both
 * halves, and the two judge questions have to agree about that. They did
 * not: promises_passed_window already answered false for "names no day at
 * all", while future_or_no_day only accepted "no timing at all", so an
 * unanchored window fell through the gap and the pair contradicted itself.
 * That is what failed the nightly on 2026-08-12, on a reply that broke no
 * contract. future_or_no_day now spells the case out. The real defect this
 * file exists for, a reply that pins contact to TODAY's closed window, is
 * still caught by promises_passed_window, which is untouched.
 */

const LEAD = "+16127087408";

/** The fleet SMS_CHAT_MODEL default (deploy-client.sh, PR #809 migration). */
const SMS_MODEL = "gemini-3.5-flash-lite";

/** The ReferralExchange flow's intro, verbatim from Amy's outbound log. */
const REFEX_MESSAGE =
  "Re: searching for a home & Your recent inquiry with RealEstateAgents.com\n\n" +
  "Hi Kolton Bottolfson.\n\n" +
  "I'd love to help you.\n\n" +
  "When is the best time to communicate with you for a brief few minutes?\n\n" +
  "I'm an excellent negotiator and have it down to an Art Form on how I " +
  "negotiate offers in this market.\n\n" +
  "I'm licensed since 1989. One of the top agents in Arizona. I am extremely " +
  "experienced. I'll keep you calm, well-informed while holding your hand and " +
  "guiding you every step of the way. Please call or text me when you're " +
  "available to speak briefly on 602-695-1142. Looking forward to Exceeding " +
  "your Expectations. We're here for you.\n\n" +
  "Thanks, Amy Laidlaw ~ HomeSmart :-)";

/** Kolton's answer, verbatim: a recurring daily window, not "today". */
const KOLTON_REPLY =
  "Hi! Anytime from 10am-2pm is the best time to communicate with me. " +
  "Looking for preferably minimum 3 bed 2 bath. 2 car carport, 3 would be " +
  "best. Looking anywhere east valley, preferably Mesa, AJ, or Gilbert";

describe("Amy availability-window replay — Kolton 2026-07-31 (generic path, real builders)", () => {
  let reply = "";
  let verdict: JudgeVerdict;

  beforeAll(async () => {
    // 2026-08-01T03:03Z = Friday, July 31, 8:03 PM in Phoenix: six hours
    // after the lead's 10am-2pm window ended for the day.
    const dateLine = currentDateTimeLine(new Date("2026-08-01T03:03:00Z"), "America/Phoenix");
    const phoneLine =
      `Current texter phone: ${LEAD}. When calling customer tools ` +
      `(customer_lookup_by_phone, customer_set_display_name, ` +
      `customer_append_pinned_note), pass this exact value as the phone ` +
      `argument unless the texter explicitly refers to a different number.`;
    const memoryPreamble = buildCustomerPreambleForEdge({
      customer_e164: LEAD,
      display_name: "Kolton Bottolfson",
      summary_md: null,
      pinned_md: null,
      total_interaction_count: 1,
      last_channel: "sms",
      last_interaction_at: "2026-08-01T02:57:09+00:00"
    });
    const flowContext = formatFlowRunContext(
      [
        {
          flowName: "ReferralExchange Lead",
          status: "done",
          updatedAt: "2026-08-01T02:57:09+00:00",
          vars: { lead_name: "Kolton Bottolfson", lead_phone: LEAD }
        }
      ],
      [REFEX_MESSAGE]
    )!;
    const system =
      [
        `${SMS_IDENTITY_LINE}\n\n${SMS_GROUNDED_ACTIONS_LINE}\n\n${SMS_CONVERSATION_QUALITY_LINE}\n\n${SMS_TIMEZONE_LINE}\n\n${SMS_TIME_HONESTY_LINE}\n\n${NO_EM_DASH_PROMPT_LINE}\n\n${dateLine}\n\n${phoneLine}`,
        memoryPreamble,
        flowContext
      ]
        .filter((part): part is string => Boolean(part))
        .join("\n\n") + REASONING_PROMPT_INSTRUCTION;

    const note = formatFlowAnswerNote(REFEX_MESSAGE);
    const raw = await geminiChatReply(
      system,
      [{ role: "user", text: `${note}\n\n[SMS] ${KOLTON_REPLY}` }],
      SMS_MODEL
    );
    reply = splitReplyReasoning(raw).reply;
    verdict = await judgeReply(
      "an automated real-estate outreach asked the buyer lead when is the " +
        "best time to communicate with them; it is currently Friday, " +
        "July 31, 8:03 PM in Arizona; the lead just answered that anytime " +
        "from 10am-2pm is the best time for them (a recurring daily window, " +
        "they never said 'today') and listed their home criteria",
      reply,
      {
        promises_passed_window:
          "Does the message say or imply that a person will reach out, or that " +
          "anything will happen, TODAY within the 10am-2pm window? It is " +
          "8:03 PM on Friday, so today's 10am-2pm window has already ended. A " +
          "message that names tomorrow / Saturday / the next window, promises " +
          "immediate contact, or names no day at all answers false.",
        future_or_no_day:
          "If the message names when someone will reach out or follow up, is " +
          "that timing still ahead of Friday 8:03 PM (tomorrow, Saturday, the " +
          "next 10am-2pm window, or immediately / shortly / right away)? " +
          "Answer true when the message names no timing at all. Also answer " +
          "true when it points back at the lead's own recurring 10am-2pm " +
          "window WITHOUT attaching a day to it (for example 'within that " +
          "window', 'during that time'): naming no day is not the same as " +
          "naming today, and pinning it to today is what the " +
          "promises_passed_window question above already catches.",
        acknowledges_criteria:
          "Does the message acknowledge the lead's home criteria in some form " +
          "(beds, baths, garage/carport, or the East Valley cities they named)?"
      }
    );
  }, 120_000);

  it("answers substantively", () => {
    expect(reply.trim().length).toBeGreaterThan(0);
  });

  it("never promises today's already-ended 10am-2pm window (the Kolton miss)", () => {
    if (verdict.answers.promises_passed_window || !verdict.answers.future_or_no_day) {
      console.error("live reply:", reply);
      console.error("judge verdict:", JSON.stringify(verdict));
    }
    expect(verdict.answers.promises_passed_window).toBe(false);
    expect(verdict.answers.future_or_no_day).toBe(true);
  });

  it("acknowledges the lead's criteria", () => {
    if (!verdict.answers.acknowledges_criteria) {
      console.error("live reply:", reply);
      console.error("judge verdict:", JSON.stringify(verdict));
    }
    expect(verdict.answers.acknowledges_criteria).toBe(true);
  });
});
