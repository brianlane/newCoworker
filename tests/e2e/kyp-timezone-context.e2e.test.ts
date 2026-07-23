import { describe, expect, it } from "vitest";
import {
  SMS_CONVERSATION_QUALITY_LINE,
  SMS_GROUNDED_ACTIONS_LINE,
  SMS_IDENTITY_LINE,
  SMS_TIMEZONE_LINE
} from "../../supabase/functions/_shared/sms_prompt_lines";
import {
  REASONING_PROMPT_INSTRUCTION,
  splitReplyReasoning
} from "../../supabase/functions/_shared/reply_reasoning";
import {
  formatContactTimeline,
  type ContactTimelineEvent
} from "../../supabase/functions/_shared/contact_context";
import { buildCustomerPreambleForEdge } from "../../supabase/functions/_shared/customer_memory_preamble";
import { currentDateTimeLine } from "../../supabase/functions/_shared/datetime_line";
import { geminiChatReply } from "./gemini";
import { judgeReply, type JudgeVerdict } from "./judge";

/**
 * The timezone-question replay (KYP Ads, 2026-07-20): a Mountain-time lead
 * (+1 780, Alberta) asked "What time zone is that?" after the business
 * confirmed a call for "today at 1:00 PM" with no zone — while an earlier
 * text had promised "11am your time on Monday". The business runs on
 * America/Toronto (Eastern); 1:00 PM Eastern IS 11:00 AM Mountain, so the
 * two messages agree — but only if the assistant does the reconciliation.
 *
 * In production the AI never ran (the contact is sms_reply_mode: suppress
 * and the owner answered by hand). This test pins what the assistant WOULD
 * have said: the exact fresh-thread prompt the sms-inbound-worker builds —
 * the contact timeline (the "11am your time" and "1:00 PM" texts were both
 * inside the 72h lookback), the memory preamble, and the business-local
 * date line — on the fleet's SMS chat model.
 *
 * Contract (semantic, judged — never verbatim): the reply must resolve the
 * zone ambiguity (name the zone and/or give the customer-local
 * equivalent), must not assert a WRONG equivalence, and must answer
 * mid-thread rather than asking which call is meant. If this test fails,
 * the finding is that the context is insufficient for zone inference and
 * the fix is a prompt-line change — proposed separately, not bundled here.
 *
 * Thread lines are the production messages, anonymized (name, links,
 * numbers); the load-bearing facts — the 780 area code, "11am your time",
 * the unlabeled "1:00 PM", America/Toronto — are preserved exactly.
 */

const LEAD = "+17805550142";
/** The moment the real question arrived: Mon Jul 20 2026, 11:04 ET. */
const TURN_AT = new Date("2026-07-20T15:04:07.000Z");
const QUESTION = "What time zone is that?";

/** Fleet SMS chat model (deploy-client.sh SMS_CHAT_MODEL default after the
 * PR #809 migration — same pin, and the same reason, as the Truly
 * renewal-context replay). */
const KYP_SMS_CHAT_MODEL = "gemini-3.5-flash-lite";

const BOOKING_LINK = "calendly.example.com/kyp-strategy";

/** The contact's real 72h window, oldest first (all business-sent: the
 * lead had never texted back before the question). */
const THREAD: ContactTimelineEvent[] = [
  {
    at: "2026-07-18T04:10:05.000Z",
    channel: "sms_out",
    text:
      "Hey Theo Tran, thanks for your interest in KYP Ads! I saw you're in " +
      "Coaching/Consulting and looking to grow your leads. I'd love to map out " +
      "a plan for your business on a quick free strategy call. You can grab a " +
      `time here: ${BOOKING_LINK}`
  },
  {
    at: "2026-07-18T04:20:35.000Z",
    channel: "sms_out",
    text:
      "Looking forward to our call Theo. See you at 11am your time on Monday " +
      "to learn about your business and to see if it fits our 100/week ads " +
      "management program. Have a great weekend!"
  },
  {
    at: "2026-07-18T06:11:02.000Z",
    channel: "sms_out",
    text:
      "Hey Theo Tran, just floating this back up - happy to answer any " +
      `questions whenever you're ready. You can grab a time here: ${BOOKING_LINK}`
  },
  {
    at: "2026-07-19T06:12:02.000Z",
    channel: "sms_out",
    text:
      "Hi Theo Tran, I don't want you to slip through the cracks! Booking " +
      `only takes a minute: ${BOOKING_LINK}`
  },
  {
    at: "2026-07-20T14:14:58.000Z",
    channel: "sms_out",
    text:
      "Hey Theo, James here from KYP Ads.\n\nJust confirming our call today " +
      "at 1:00 PM.\n\nZoom link:\nhttps://zoom.example.com/j/85037807118"
  }
];

async function runTimezoneTurn(): Promise<{
  reply: string;
  reasoningPresent: boolean;
  verdict: JudgeVerdict;
}> {
  // The worker's fresh-thread customer preamble, piece for piece
  // (sms-inbound-worker/index.ts, non-staff path; this contact has no
  // sms_rowboat_threads row, so the timeline block IS injected).
  const dateLine = currentDateTimeLine(TURN_AT, "America/Toronto");
  const phoneLine =
    `Current texter phone: ${LEAD}. When calling customer tools ` +
    `(customer_lookup_by_phone, customer_set_display_name, ` +
    `customer_append_pinned_note), pass this exact value as the phone ` +
    `argument unless the texter explicitly refers to a different number.`;
  const memoryPreamble = buildCustomerPreambleForEdge({
    customer_e164: LEAD,
    display_name: "Theo Tran",
    summary_md: null,
    pinned_md: null,
    total_interaction_count: 5,
    last_channel: "sms",
    last_interaction_at: "2026-07-20T14:14:58.000Z"
  });
  const contactTimeline = formatContactTimeline(THREAD)!;
  // SMS_TIMEZONE_LINE rides between the quality line and the date line,
  // exactly like the worker's customer preamble (sms-inbound-worker
  // dateAndPhoneLines). It was MISSING here until Jul 23 2026 — the line
  // shipped from this very incident (KYP/Ayanna, Jul 20) after this replay
  // was written, and without it the fleet model failed the zone contract
  // on a meaningful share of draws (PR #853's CI run drew "All of our
  // times are set in Mountain Time!"). With the production rule present
  // the test measures what production actually does.
  const system =
    [
      `${SMS_IDENTITY_LINE}\n\n${SMS_GROUNDED_ACTIONS_LINE}\n\n${SMS_CONVERSATION_QUALITY_LINE}\n\n${SMS_TIMEZONE_LINE}\n\n${dateLine}\n\n${phoneLine}`,
      memoryPreamble,
      contactTimeline
    ]
      .filter((part): part is string => Boolean(part))
      .join("\n\n") + REASONING_PROMPT_INSTRUCTION;

  const raw = await geminiChatReply(
    system,
    [{ role: "user", text: `[SMS] ${QUESTION}` }],
    KYP_SMS_CHAT_MODEL
  );
  const split = splitReplyReasoning(raw);
  const reply = split.reply;
  const reasoningPresent = split.reasoning !== null;
  const verdict = await judgeReply(
    "the business (located in Toronto, Eastern Time) texted the customer " +
      "'just confirming our call today at 1:00 PM' without naming a time zone, " +
      "after earlier promising '11am your time on Monday'; the customer's phone " +
      "number is in Alberta (Mountain Time, 2 hours behind Eastern), so the " +
      "correct reading is 1:00 PM Eastern = 11:00 AM Mountain; the customer " +
      "asked what time zone the 1:00 PM is in",
    reply,
    {
      resolves_time_zone:
        "Does the message answer the time zone question — naming the zone the " +
        "1:00 PM is in (e.g. Eastern) and/or giving the customer's local " +
        "equivalent (e.g. 11:00 AM Mountain / their time)? A reply that gives " +
        "neither a zone nor an equivalence is false.",
      states_wrong_time:
        "Does the message assert a time, zone, or equivalence that CONTRADICTS " +
        "1:00 PM Eastern = 11:00 AM Mountain (for example calling the 1:00 PM " +
        "Mountain/Pacific, or telling the customer a local time other than " +
        "11:00 AM)? Merely naming one side correctly without the conversion is " +
        "false.",
      asks_which_call:
        "Does the message ask the customer to clarify which call, appointment, " +
        "or message they are referring to, or say it doesn't have enough " +
        "context to answer — i.e. does it fail to recognize the question is " +
        "about the 1:00 PM confirmation it just sent? A confident direct " +
        "answer is false.",
      restarts_conversation:
        "Does the message greet or introduce the sender as if the conversation " +
        "were just starting (a fresh 'thanks for reaching out' opener, " +
        "introducing themselves by name), rather than continuing mid-thread?"
    }
  );
  return { reply, reasoningPresent, verdict };
}

describe("KYP timezone turn — 'What time zone is that?' (fresh thread, live model)", () => {
  // One retried test instead of beforeAll + four tests (the suite-standard
  // de-flake shape, same restructure as the voice-booking and kyp-operator
  // suites): a single marginal draw — the 2026-07-23 hammer run drew one
  // reply the judge scored as not resolving the zone — must re-roll the
  // WHOLE turn, and vitest retry cannot re-run a beforeAll.
  it(
    "resolves the zone mid-thread, no wrong equivalence, no re-ask, with trailer",
    { retry: 1, timeout: 120_000 },
    async () => {
      const { reply, reasoningPresent, verdict } = await runTimezoneTurn();

      expect(reply.trim().length).toBeGreaterThan(0);

      if (
        !verdict.answers.resolves_time_zone ||
        verdict.answers.states_wrong_time ||
        verdict.answers.asks_which_call ||
        verdict.answers.restarts_conversation
      ) {
        console.error("live reply:", reply);
        console.error("judge verdict:", JSON.stringify(verdict));
      }
      expect(verdict.answers.resolves_time_zone).toBe(true);
      expect(verdict.answers.states_wrong_time).toBe(false);
      expect(verdict.answers.asks_which_call).toBe(false);
      expect(verdict.answers.restarts_conversation).toBe(false);

      expect(reasoningPresent).toBe(true);
    }
  );
});
