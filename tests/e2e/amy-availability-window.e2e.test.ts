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
 * There used to be a second judged question here, future_or_no_day, as the
 * positive counterpart: "is any named timing still ahead?". It is gone, and
 * the timing contract now rests on promises_passed_window alone.
 *
 * Two reasons. It was redundant: measured over 8 draws, promises_passed_window
 * on its own still flags the real incident reply ("reach out between 10 AM
 * and 2 PM Arizona time today") 8 out of 8, and flags 0 out of 6 on every
 * good reply shape, including the unanchored "within that window" one that
 * failed the 2026-08-12 nightly. And it was unreliable: TRUE = good property
 * is the question shape the judge is least sharp on, and it kept returning
 * false on replies that named a plainly future day ("tomorrow, Saturday,
 * August 1"), which is how it broke the 2026-08-14 nightly.
 *
 * The remaining judged question is phrased TRUE = violation, which is what
 * judge.ts asks for, and the criteria check below is now lexical.
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

describe("Amy availability-window replay, Kolton 2026-07-31 (generic path, real builders)", () => {
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
        // Phrased so the TRUE case is the narrow one: only a message that
        // ties contact to TODAY violates. The previous wording listed what
        // answers false but never said "only today answers true", and the
        // judge read a reply that merely REPEATED the lead's window with its
        // clock times ("during your preferred window of 10:00 AM to 2:00 PM
        // daily") as meaning today. Measured over 6 draws per reply on the
        // real nightly replies: that wording false-flagged them 3/6 and 6/6,
        // this one 0/6 and 0/6, while both still catch the actual incident
        // reply 6/6.
        promises_passed_window:
          "Does the message tie the contact to TODAY, inside the 10am-2pm " +
          "window that has already ended? It is 8:03 PM on Friday. Answer " +
          "TRUE only when the message says or clearly implies the contact " +
          "happens TODAY. Answer FALSE when it names tomorrow, Saturday, or " +
          "the next window; when it promises immediate contact; and when it " +
          "names no day at all. Repeating the lead's own recurring window, " +
          "with or without its clock times ('within that window', 'during " +
          "your preferred window of 10:00 AM to 2:00 PM daily'), names no " +
          "day, so it answers FALSE.",
      }
    );
  }, 120_000);

  it("answers substantively", () => {
    expect(reply.trim().length).toBeGreaterThan(0);
  });

  it("never promises today's already-ended 10am-2pm window (the Kolton miss)", () => {
    if (verdict.answers.promises_passed_window) {
      console.error("live reply:", reply);
      console.error("judge verdict:", JSON.stringify(verdict));
    }
    expect(verdict.answers.promises_passed_window).toBe(false);
  });

  /**
   * Lexical, not judged. The judge's own contract says to keep exact-by-
   * nature checks as string checks, and this is one: acknowledging the
   * criteria means echoing one of the things Kolton actually named. Asked
   * as a judge question it was a TRUE = good-property question, the shape
   * the judge is least sharp on, and it produced false negatives on replies
   * that plainly listed all four criteria. This regex is checked against
   * the real replies from the 2026-08-12 and 2026-08-14 nightlies plus a
   * paraphrase ("three bed two bath with a carport around Mesa"), and
   * separates them correctly with no model call at all.
   */
  it("acknowledges the lead's criteria", () => {
    // Echoing a criterion outright.
    const specific =
      /\b(beds?|bedrooms?|baths?|bathrooms?|carport|garage|mesa|apache junction|gilbert|east valley)\b/i;
    // Or referring to what he shared without repeating it, which the lead
    // reads as being heard just the same ("I will share those preferences",
    // "homes meeting those criteria"). Requiring a named criterion alone
    // failed those replies, and they are not the miss this pins.
    const generic =
      /\b(?:those|these|your)\s+(?:preferences|details|criteria|requirements|specs|must[- ]haves)\b|\bhomes?\s+(?:meeting|matching|that meet|like that)\b|\bwhat\s+you(?:'re| are)\s+looking\s+for\b/i;
    const acknowledged = specific.test(reply) || generic.test(reply);
    if (!acknowledged) console.error("live reply:", reply);
    expect(acknowledged, `reply acknowledged none of Kolton's criteria: ${reply}`).toBe(true);
  });
});
