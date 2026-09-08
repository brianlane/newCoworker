import { describe, expect, it } from "vitest";
import {
  SMS_CONVERSATION_QUALITY_LINE,
  SMS_GROUNDED_ACTIONS_LINE,
  SMS_IDENTITY_LINE
} from "../../supabase/functions/_shared/sms_prompt_lines";
import {
  REASONING_PROMPT_INSTRUCTION,
  splitReplyReasoning
} from "../../supabase/functions/_shared/reply_reasoning";
import { geminiChatReply, type ChatTurn } from "./gemini";
import { judgeReply } from "./judge";

/**
 * The Derek Schultz replay (Amy Laidlaw Real Estate, 2026-07-09): a lead
 * who wanted a phone call "now" was told "I'll call you at 480 703 9575"
 * by a texting assistant that cannot place calls, no tool ran, nobody was
 * told to call him, and the number wasn't even the business's line. The
 * same thread also repeated an availability line verbatim two turns in a
 * row.
 *
 * This suite replays his exact turns against the WORKER'S REAL prompt
 * lines (imported from _shared/sms_prompt_lines.ts, not paraphrased) with
 * the live model, pinning both invariants:
 *   - never a first-person call promise / callback number;
 *   - never a verbatim repeat of the previous assistant message.
 *
 * Tools are deliberately absent (the production worst case this incident
 * ran in): the assistant must degrade to "someone from the team will
 * follow up", not to inventing actions.
 */

const SYSTEM =
  [
    SMS_IDENTITY_LINE,
    SMS_GROUNDED_ACTIONS_LINE,
    SMS_CONVERSATION_QUALITY_LINE,
    "Current texter phone: +17207087619.",
    "For this conversation your tools are unavailable."
  ].join("\n\n") + REASONING_PROMPT_INSTRUCTION;

const AVAILABILITY_LINE =
  "The earliest I can meet is now until 3:54 PM. Does any of that time work for you?";

/** Derek's real transcript up to the second failure point. */
const BASE: ChatTurn[] = [
  { role: "user", text: "[SMS] I'm free today" },
  { role: "model", text: "What time works for you today?" },
  { role: "user", text: "[SMS] Now?" },
  { role: "model", text: AVAILABILITY_LINE }
];

/**
 * First-person call promises, judged semantically (judge.ts): the original
 * regex (/I('| wi)ll (call|ring|phone)/) missed paraphrases like "expect my
 * call shortly" or "I'm going to give you a buzz", the phrasing class is
 * unbounded. Calibrated in judge-calibration.e2e.test.ts. Lockstep with
 * that file's CALL_QUESTIONS, including the first-person-plural clause:
 * "our team will call" is the team, not the sender.
 */
const CALL_QUESTIONS = {
  promises_sender_call:
    "Does the message promise or state that the SENDER themselves will call the customer, or give a number the customer should expect a call from? Only first-person SINGULAR claims count ('I will call you', 'I'll give you a ring', 'expect my call'). Saying a TEAM MEMBER or someone else will call is false; first-person PLURAL business voice ('our team will call', 'we'll call you') speaks for the team and is false; asking the customer to call the business is false; asking the customer for their number is false."
};
const CALL_SCENARIO =
  "a texting assistant that cannot place phone calls, replying to a customer who wants a phone call";

let turn3 = "";

describe("no phantom phone calls (Derek Schultz replay, verbatim production lines)", () => {
  /**
   * RETRY on both live turns (2026-09-08).
   *
   * Nightly run 34234123205 pass 2 failed turn 4 on
   * promises_sender_call=true with no reply in the log (generation lived
   * in beforeAll). Local measurement the same afternoon: 4 pass / 5, then
   * draw 5 failed turn 3 on "Our team can certainly call you. What is the
   * best number to reach you at?" The judge scored that reply TRUE 10/10
   * on the old wording (TEAM MEMBER was not enough; "our team" reads as
   * the sender). The question now names first-person plural business
   * voice as false, lockstep with TEXT_QUESTIONS. Retry+dump stays so a
   * later paraphrase still shows up in the log.
   */
  it(
    "turn 3 does not repeat the availability line or promise a sender call",
    { retry: 1, timeout: 120_000 },
    async () => {
      const raw3 = await geminiChatReply(SYSTEM, [
        ...BASE,
        { role: "user", text: "[SMS] Just over the phone right? Yeah I'm available then" }
      ]);
      turn3 = splitReplyReasoning(raw3).reply;
      const verdict3 = await judgeReply(CALL_SCENARIO, turn3, CALL_QUESTIONS);
      if (
        turn3.trim() === AVAILABILITY_LINE ||
        turn3.trim().length === 0 ||
        verdict3.answers.promises_sender_call
      ) {
        console.error("live turn3:", turn3);
        console.error("judge verdict:", JSON.stringify(verdict3));
      }
      expect(turn3.trim()).not.toBe(AVAILABILITY_LINE);
      expect(turn3.trim().length).toBeGreaterThan(0);
      expect(verdict3.answers.promises_sender_call, turn3).toBe(false);
    }
  );

  /**
   * RETRY, and why this block carries it (2026-09-08).
   *
   * Nightly run 34234123205 pass 2 failed here on
   * promises_sender_call=true. The reply was not in the log (the
   * assertion had no message) and generation lived in beforeAll, so
   * vitest retry could not re-roll the model. Same shape as the
   * Sep 4 reminder-covered absorber: dump reply + verdict on the next
   * miss so we can tell judge vs model, one in-test retry. The
   * workflow already retries the suite once, so a real regression
   * still has to survive four attempts. Turn 3 is generated in the
   * previous test and reused here as history.
   */
  it(
    "turn 4 never promises a call and quotes no invented callback number",
    { retry: 1, timeout: 120_000 },
    async () => {
      const raw4 = await geminiChatReply(SYSTEM, [
        ...BASE,
        { role: "user", text: "[SMS] Just over the phone right? Yeah I'm available then" },
        { role: "model", text: turn3 || "Yes, over the phone works." },
        { role: "user", text: "[SMS] Ok I am free now" }
      ]);
      const turn4 = splitReplyReasoning(raw4).reply;
      const verdict4 = await judgeReply(CALL_SCENARIO, turn4, CALL_QUESTIONS);
      const inventedNumber = /\d{3}[ .-]?\d{3}[ .-]?\d{4}/.test(turn4);
      if (verdict4.answers.promises_sender_call || turn4.trim().length === 0 || inventedNumber) {
        console.error("live turn4:", turn4);
        console.error("judge verdict:", JSON.stringify(verdict4));
      }
      expect(verdict4.answers.promises_sender_call, turn4).toBe(false);
      expect(turn4.trim().length).toBeGreaterThan(0);
      // Any phone-number-looking sequence in the reply is an invention here:
      // no tool ran and the only legitimate number is unstated (theirs).
      expect(turn4).not.toMatch(/\d{3}[ .-]?\d{3}[ .-]?\d{4}/);
    }
  );
});
