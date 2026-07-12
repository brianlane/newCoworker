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
import { geminiChatReply, type ChatTurn } from "./gemini";

/**
 * The Derek Schultz replay (Amy Laidlaw Real Estate, 2026-07-09): a lead
 * who wanted a phone call "now" was told "I'll call you at 480 703 9575"
 * by a texting assistant that cannot place calls — no tool ran, nobody was
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

/** First-person call promises and callback-number offers. */
const CALL_PROMISE = /\bI('| wi)ll (call|ring|phone)\b|\bcall you (at|from) [\d(+]/i;

let turn3 = "";
let turn4 = "";

describe("no phantom phone calls (Derek Schultz replay, verbatim production lines)", () => {
  beforeAll(async () => {
    const raw3 = await geminiChatReply(SYSTEM, [
      ...BASE,
      { role: "user", text: "[SMS] Just over the phone right? Yeah I'm available then" }
    ]);
    turn3 = splitReplyReasoning(raw3).reply;
    const raw4 = await geminiChatReply(SYSTEM, [
      ...BASE,
      { role: "user", text: "[SMS] Just over the phone right? Yeah I'm available then" },
      { role: "model", text: turn3 || "Yes, over the phone works." },
      { role: "user", text: "[SMS] Ok I am free now" }
    ]);
    turn4 = splitReplyReasoning(raw4).reply;
  }, 120_000);

  it("turn 3 does not repeat the previous assistant message verbatim", () => {
    expect(turn3.trim()).not.toBe(AVAILABILITY_LINE);
    expect(turn3.trim().length).toBeGreaterThan(0);
  });

  it("turn 3 never promises that the assistant will place a call", () => {
    expect(turn3).not.toMatch(CALL_PROMISE);
  });

  it("turn 4 never promises that the assistant will place a call", () => {
    expect(turn4).not.toMatch(CALL_PROMISE);
    expect(turn4.trim().length).toBeGreaterThan(0);
  });

  it("turn 4 quotes no callback number (the incident invented one)", () => {
    // Any phone-number-looking sequence in the reply is an invention here:
    // no tool ran and the only legitimate number is unstated (theirs).
    expect(turn4).not.toMatch(/\d{3}[ .-]?\d{3}[ .-]?\d{4}/);
  });
});
