import { beforeAll, describe, expect, it } from "vitest";
import { systemInstructionForBusiness } from "../../vps/voice-bridge/src/system-instruction";
import { formatVoiceFlowContext } from "../../vps/voice-bridge/src/flow-run-context";
import { geminiChatReply } from "./gemini";

/**
 * Voice persona against the LIVE model: the bridge's REAL system
 * instruction (production builder, production flow-context formatter), a
 * realistic first exchange, and the behavioral invariants the instruction
 * exists to enforce. Gemini Live's audio channel can't run in CI — this is
 * the text-mode stand-in using the identical instruction string, so a
 * prompt edit that breaks the persona contract fails here before it ships
 * to the fleet.
 *
 * Assertions are the instruction's HARD rules only (never self-identify as
 * an AI; never re-ask for the number they're calling from; use the flow
 * context instead of restarting intake) — not phrasing, which is model
 * freedom.
 */

/** The exact caller state after the Truly incident's flow ended. */
const FLOW_CONTEXT = formatVoiceFlowContext(
  [
    {
      flowName: "Lead intake & follow-up (Privyr)",
      status: "done",
      updatedAt: "2026-07-11T12:39:05Z",
      vars: {
        lead_name: "Dwight Colclough",
        lead_phone: "+14168775223",
        product: "auto_insurance",
        reply_text: "No-fault accident; insurers refusing coverage; truck parked since April 17."
      }
    }
  ],
  "Thanks for sharing that - Approximately when does your current policy renew?"
)!;

const SYSTEM = systemInstructionForBusiness(
  "Truly Insurance",
  false, // no transfer configured
  false, // no tools (hard rules only — tool calls can't run here)
  undefined,
  "Dwight Colclough; auto-insurance lead; no-fault accident dispute.",
  "America/New_York",
  { kind: "customer" },
  false,
  FLOW_CONTEXT
);

/** The instruction's hard behavioral rules, as text patterns. */
const SELF_IDENTIFIES_AS_AI = /\b(i'?m|i am) (an? )?(ai|artificial|language model|bot|virtual)/i;
const ASKS_FOR_PHONE_NUMBER =
  /(what('| i)s|can i (get|have)|could you (give|read|confirm)).{0,40}\b(phone|number)\b|\bbest number\b/i;

let reply = "";

describe("voice persona live (bridge system instruction, text-mode stand-in)", () => {
  beforeAll(async () => {
    reply = await geminiChatReply(SYSTEM, [
      {
        role: "user",
        text:
          "Hi, I got your text asking when my policy renews — it was supposed to renew " +
          "April 17th but they refused to renew it. That's why I'm calling."
      }
    ]);
  }, 60_000);

  it("answers substantively", () => {
    expect(reply.trim().length).toBeGreaterThan(20);
  });

  it("never self-identifies as an AI/bot (identity discipline)", () => {
    expect(reply).not.toMatch(SELF_IDENTIFIES_AS_AI);
  });

  it("never asks for the number they are calling from", () => {
    expect(reply).not.toMatch(ASKS_FOR_PHONE_NUMBER);
  });

  it("continues the automation's thread instead of restarting intake", () => {
    // The flow context marks their name and product as KNOWN; restarting
    // intake ("can I get your name?") is the exact failure this exists to
    // prevent on voice.
    expect(reply).not.toMatch(/(what('| i)s|can i (get|have)|may i have) your (full )?name/i);
  });
});
