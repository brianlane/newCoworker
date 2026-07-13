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
import { formatFlowRunContext } from "../../supabase/functions/_shared/ai_flows/run_context";
import { formatSmsTranscript } from "../../supabase/functions/_shared/sms_transcript";
import { geminiChatReply } from "./gemini";

/**
 * The Juhu replay (Truly Insurance, 2026-07-13): during a Gemini outage the
 * SMS worker's retries and the AiFlow → Coworker handoff made the live model
 *   - re-send the flow's renewal question VERBATIM,
 *   - ask "what prompted you to shop around?" three separate times,
 *   - restart lead intake mid-thread after a stateless reset.
 *
 * This suite replays the incident's exact conversation state against the
 * REAL production prompt builders (formatFlowRunContext with the
 * already-sent flow messages; formatSmsTranscript as the stateless-reset
 * context — both imported, not paraphrased) with the live model, pinning
 * the two hard invariants the fixes exist to enforce:
 *   - never re-send / re-ask an automated message the contact already got;
 *   - a stateless reset with the transcript block continues the thread
 *     instead of restarting intake.
 */

const LEAD = "+15485773546";

/** The three automated texts the flow had ALREADY delivered to Juhu. */
const FLOW_MESSAGES = [
  "Hi Muhammad Fahad Juhu! Thanks for requesting a quote from Truly Insurance. " +
    "I'm Emma and I will help get you connected with one of our licensed brokers. " +
    "What prompted you to shop around today?",
  "Thanks for sharing that - I've made a note for your broker. " +
    "Approximately when does your current policy renew?"
];

/** Real production flow-context block (post-incident shape). */
const FLOW_CONTEXT = formatFlowRunContext(
  [
    {
      flowName: "Lead intake & follow-up (Privyr)",
      status: "awaiting_agent",
      updatedAt: "2026-07-13T15:50:05Z",
      vars: {
        lead_name: "Muhammad Fahad Juhu",
        lead_email: "iamjuhusree@gmail.com",
        lead_phone: LEAD,
        product: "Auto",
        reply_text: "I need auto insurance"
      }
    }
  ],
  FLOW_MESSAGES
)!;

const BASE_LINES = [
  SMS_IDENTITY_LINE,
  SMS_GROUNDED_ACTIONS_LINE,
  SMS_CONVERSATION_QUALITY_LINE,
  `Current texter phone: ${LEAD}.`,
  "For this conversation your tools are unavailable."
];

/** "What prompted you…" in any phrasing close enough to be a repeat. */
const PROMPTED_QUESTION = /what (prompted|made|led) you/i;

describe("no re-sent automation messages (Juhu replay, real flow-context block)", () => {
  const SYSTEM = [...BASE_LINES, FLOW_CONTEXT].join("\n\n") + REASONING_PROMPT_INSTRUCTION;
  let reply = "";

  beforeAll(async () => {
    // The exact turn that produced the verbatim duplicate in production:
    // "I'm looking for auto" arrived right after the flow had already asked
    // both intake questions.
    const raw = await geminiChatReply(SYSTEM, [
      { role: "user", text: "[SMS] I'm looking for auto" }
    ]);
    reply = splitReplyReasoning(raw).reply;
  }, 120_000);

  it("answers substantively", () => {
    expect(reply.trim().length).toBeGreaterThan(0);
  });

  it("never repeats an already-sent automated message verbatim (the production duplicate)", () => {
    for (const sent of FLOW_MESSAGES) {
      expect(reply.trim()).not.toBe(sent);
      // Prefix match catches near-verbatim resends with a trailing tweak.
      expect(reply).not.toContain("I've made a note for your broker. Approximately when does");
    }
  });

  it("never re-asks the flow's opener — it was asked AND answered", () => {
    // vars.reply_text carries the lead's answer ("I need auto insurance"),
    // and the context block marks the question as already delivered.
    expect(reply).not.toMatch(PROMPTED_QUESTION);
  });

  it("never re-asks for identity the automation already collected", () => {
    // lead_name / lead_phone / lead_email are KNOWN vars in the block.
    expect(reply).not.toMatch(/what('| i)s your (name|phone|number|email)/i);
    expect(reply).not.toMatch(/(can|could) (i|you) (get|have|confirm) your (name|phone|number|email)/i);
  });
});

describe("stateless reset continues the thread (transcript block, real formatter)", () => {
  // The incident's mid-booking state, rendered by the REAL transcript
  // formatter the worker passes as statelessContextExtra on a reset.
  const TRANSCRIPT = formatSmsTranscript([
    { inbound: "I need auto insurance", reply: FLOW_MESSAGES[1] },
    {
      inbound: "I want to book a call",
      reply:
        "It looks like you're ready to book a call to discuss your auto insurance. " +
        "I have the following times available:\n\n- Monday, July 13th at 4:00 PM EDT\n" +
        "- Monday, July 13th at 4:30 PM EDT\n- Monday, July 13th at 5:00 PM EDT\n\n" +
        "Do any of these times work for you?"
    }
  ])!;
  const SYSTEM = [...BASE_LINES, FLOW_CONTEXT, TRANSCRIPT].join("\n\n") + REASONING_PROMPT_INSTRUCTION;
  let reply = "";

  beforeAll(async () => {
    // Production failure shape: the stateless retry saw ONLY this line and
    // restarted intake ("Thanks for reaching out… what prompted you…").
    const raw = await geminiChatReply(SYSTEM, [
      { role: "user", text: "[SMS] Please book July 13 4pm" }
    ]);
    reply = splitReplyReasoning(raw).reply;
  }, 120_000);

  it("answers substantively", () => {
    expect(reply.trim().length).toBeGreaterThan(0);
  });

  it("does not restart intake after the reset (the incident's third 'what prompted you')", () => {
    expect(reply).not.toMatch(PROMPTED_QUESTION);
    expect(reply).not.toMatch(/when does your (current )?policy renew/i);
  });

  it("does not re-introduce itself — the conversation is mid-thread", () => {
    expect(reply).not.toMatch(/thanks for (reaching out|contacting|requesting)/i);
    expect(reply).not.toMatch(/\bI('| a)m Emma\b/i);
  });

  it("stays on the booking thread it can see in the transcript", () => {
    // The customer picked one of the offered slots; the reply must engage
    // with the booking (time/booking words), not pivot to fresh intake.
    expect(reply).toMatch(/4:00|4 ?pm|book|appointment|call/i);
  });
});
