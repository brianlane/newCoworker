import { beforeAll, describe, expect, it } from "vitest";
import {
  REASONING_PROMPT_INSTRUCTION,
  shouldEscalateToHuman,
  splitReplyReasoning,
  type ReplyReasoning
} from "../../supabase/functions/_shared/reply_reasoning";
import { geminiChatReply, type ChatTurn } from "./gemini";

/**
 * The Truly Insurance human-handoff test (2026-07-20, replayed live): their
 * tester texted "I would like to speak to a representative" six times and
 * the escalation shipped in PR #534 never fired — every turn came back
 * intent=request_human_agent with handoff:false because the model judged
 * its "schedule a call with a broker" offer to have handled the request.
 *
 * This suite sends the REAL production instruction to the REAL model with
 * Truly-shaped turns and asserts the WORKER'S escalation decision
 * (shouldEscalateToHuman over the parsed trailer) is true for every
 * person-request scenario. The decision is what production acts on: it
 * passes when the sharpened instruction makes the model say handoff:true,
 * AND when the model still says false but names the human-request intent —
 * the deterministic backstop that closes the live gap. A run only fails
 * when a person-request turn yields a decision a human would call wrong.
 */

/** Persona in the spirit of Truly's SMS assistant (see reply-reasoning.e2e). */
const SYSTEM_PROMPT =
  [
    "You are Emma, the SMS assistant for Truly Insurance, a Toronto insurance",
    "brokerage. You are texting with a customer. Keep replies concise and",
    "natural for text messaging (1-3 sentences). You can help schedule calls",
    "with licensed brokers. Current texter phone: +16476876791."
  ].join(" ") + REASONING_PROMPT_INSTRUCTION;

type Scenario = { name: string; turns: ChatTurn[] };

/**
 * Every scenario ends on a turn where the texter is asking for a person.
 * The first three are the live Jul 20 conversation, verbatim from
 * sms_inbound_jobs; the last two vary the phrasing.
 */
const SCENARIOS: Scenario[] = [
  {
    name: "the live turn: 'I would like to speak to a representative'",
    turns: [{ role: "user", text: "I would like to speak to a representative " }]
  },
  {
    name: "repeated request after the schedule-a-call offer (the live loop)",
    turns: [
      { role: "user", text: "I want to call someone " },
      {
        role: "model",
        text: "I can help with that. Would you like to schedule a call with one of our licensed brokers?"
      },
      { role: "user", text: "I would like to speak to a representative " },
      {
        role: "model",
        text: "I can help with that. Would you like to schedule a call with one of our licensed brokers?"
      },
      { role: "user", text: "I would like to speak with a customer service rep" }
    ]
  },
  {
    name: "terse variant: 'I want to speak w a rep'",
    turns: [
      { role: "user", text: "hi " },
      { role: "model", text: "Thanks for contacting Truly Insurance! How can I help you today?" },
      { role: "user", text: "I want to speak w a rep" }
    ]
  },
  {
    name: "explicit human request: 'can I talk to a real person please'",
    turns: [{ role: "user", text: "can I talk to a real person please" }]
  },
  {
    name: "frustrated: 'stop texting me a robot, I need a human'",
    turns: [
      { role: "user", text: "how much is auto insurance" },
      {
        role: "model",
        text: "Rates vary by driver and vehicle — a licensed broker can quote you exactly. Want me to set that up?"
      },
      { role: "user", text: "stop texting me a robot, I need a human" }
    ]
  }
];

describe("Truly human-handoff: person-requests must produce an escalation decision", () => {
  const results = new Map<string, ReplyReasoning | null>();

  beforeAll(async () => {
    // Serial: one live call at a time (rate-limit footprint).
    for (const scenario of SCENARIOS) {
      const raw = await geminiChatReply(SYSTEM_PROMPT, scenario.turns);
      expect(raw.trim(), `${scenario.name}: model returned an empty reply`).not.toBe("");
      results.set(scenario.name, splitReplyReasoning(raw).reasoning);
    }
  }, 600_000);

  for (const scenario of SCENARIOS) {
    it(`escalates: ${scenario.name}`, () => {
      const reasoning = results.get(scenario.name)!;
      // The trailer itself must be present on a single-topic turn like these —
      // without it the worker can neither store a decision nor escalate.
      expect(
        reasoning,
        `${scenario.name}: model emitted no parseable reasoning trailer`
      ).not.toBeNull();
      expect(
        shouldEscalateToHuman(reasoning!),
        `${scenario.name}: intent=${reasoning!.intent} handoff=${reasoning!.escalated} — ` +
          "a person-request turn produced no escalation decision (the Truly 2026-07-20 gap)"
      ).toBe(true);
    });
  }
});
