import { beforeAll, describe, expect, it } from "vitest";
import {
  REASONING_PROMPT_INSTRUCTION,
  splitReplyReasoning
} from "../../supabase/functions/_shared/reply_reasoning";
import { geminiChatReply, type ChatTurn } from "./gemini";

/**
 * The live contract behind the Truly Insurance leak (2026-07-11): the SMS
 * worker asks the REAL model to end each reply with a reasoning trailer, and
 * splitReplyReasoning must (a) capture a parsed record and (b) leave ZERO
 * trailer debris in the customer-facing text. The original bug was invisible
 * to unit tests — we only ever parsed trailers we wrote ourselves, while the
 * model reproduced the exotic ⟦reasoning⟧ marker imperfectly and the exact
 * matcher missed it. This suite sends realistic conversations to the actual
 * model with the actual instruction and asserts the round trip.
 */

/** Marker debris that must never survive into a customer-facing reply. */
const LEAK_PATTERNS = [
  /[⟦[]{1,2}\s*reasoning/i, // any bracket variant of the marker
  /\{\s*"intent"\s*:/, // the trailer JSON itself
  /"handoff"\s*:/
];

/**
 * A representative customer-path system prompt: persona + grounding lines in
 * the spirit of the SMS worker's preamble, ending with the REAL
 * REASONING_PROMPT_INSTRUCTION (imported, not copied — if the instruction
 * changes, this suite re-verifies the new wording against the live model).
 */
const SYSTEM_PROMPT =
  [
    "You are the SMS assistant for Truly Insurance, a Toronto insurance brokerage.",
    "You are texting with a customer. Keep replies concise and natural for text",
    "messaging (1-3 sentences). Never ask for information you already have from",
    "this conversation (their name, phone, or details they've shared) — reuse it.",
    "Current texter phone: +14168775223."
  ].join(" ") + REASONING_PROMPT_INSTRUCTION;

type Scenario = { name: string; turns: ChatTurn[] };

const SCENARIOS: Scenario[] = [
  {
    // The production incident turns, verbatim: the model's answer to this is
    // exactly the message that leaked "[reasoning]{...}" to Dwight. (Turns
    // start with the user, per the Gemini contents contract — a leading
    // model turn makes replies erratic.)
    name: "renewal answer (the leaked production turn)",
    turns: [
      {
        role: "user",
        text:
          "I'm tired of insurance refusing to I've me insurance because of this no fault " +
          "accident crappie now because now I have to take a bus to work which cost to much " +
          "money.Now my truck has been parked since April 17th and I still have to make " +
          "payments on it. DWIGHT"
      },
      {
        role: "model",
        text:
          "Thanks for sharing that - I've made a note for your broker. " +
          "Approximately when does your current policy renew?"
      },
      { role: "user", text: "Was supposed to of been Apil 17th but they would not Renew it" }
    ]
  },
  {
    name: "booking request",
    turns: [{ role: "user", text: "Can I book a call with a broker tomorrow at 2pm?" }]
  },
  {
    name: "long frustrated multi-sentence message",
    turns: [
      {
        role: "user",
        text:
          "I'm tired of insurance refusing to give me insurance because of this no fault " +
          "accident. Now I have to take a bus to work which costs too much money. My truck " +
          "has been parked since April 17th and I still have to make payments on it."
      }
    ]
  },
  {
    name: "terse one-word reply",
    turns: [
      { role: "user", text: "I'd like a quote for auto insurance" },
      { role: "model", text: "Happy to help! Would a quick call this week work for you?" },
      { role: "user", text: "Yes" }
    ]
  },
  {
    name: "pricing question",
    turns: [{ role: "user", text: "Roughly how much is home insurance for a small condo?" }]
  }
];

/**
 * Two-tier contract, mirroring production semantics:
 *
 *  HARD (every scenario): after splitReplyReasoning, the customer-facing
 *  text is non-empty and carries ZERO trailer debris of any variant. This
 *  is the invariant whose violation reached a real customer.
 *
 *  AGGREGATE (capture rate): the model does not emit the trailer on 100%
 *  of turns — live runs show it sometimes omits it in longer multi-turn
 *  chats, which is the SAFE failure (nothing leaks; the ai_reply_reasoning
 *  row is best-effort by design). We assert a floor across the scenario set
 *  so "the instruction stopped working entirely" still fails the build
 *  without turning benign per-turn omissions into flakes.
 */
describe("reply-reasoning trailer live round trip", () => {
  const results = new Map<string, ReturnType<typeof splitReplyReasoning>>();

  beforeAll(async () => {
    // Serial on purpose: one model call at a time keeps the rate-limit
    // footprint negligible.
    for (const scenario of SCENARIOS) {
      const raw = await geminiChatReply(SYSTEM_PROMPT, scenario.turns);
      expect(raw.trim(), `${scenario.name}: model returned an empty reply`).not.toBe("");
      results.set(scenario.name, splitReplyReasoning(raw));
    }
  }, 180_000);

  for (const scenario of SCENARIOS) {
    it(`strips every trailer variant from the customer text: ${scenario.name}`, () => {
      const split = results.get(scenario.name)!;
      expect(split.reply.trim()).not.toBe("");
      for (const pattern of LEAK_PATTERNS) {
        expect(split.reply).not.toMatch(pattern);
      }
    });
  }

  it("captures a parsed reasoning record on most turns (instruction is alive)", () => {
    const captured = SCENARIOS.filter((s) => results.get(s.name)!.reasoning !== null);
    for (const s of captured) {
      const reasoning = results.get(s.name)!.reasoning!;
      expect(reasoning.intent.length).toBeGreaterThan(0);
      expect(reasoning.rationale.length).toBeGreaterThan(0);
    }
    // Floor, not ceiling: single-turn scenarios capture reliably; multi-turn
    // ones occasionally omit the trailer (safe). 3/5 catches a dead
    // instruction while tolerating benign omissions.
    expect(
      captured.length,
      `captured ${captured.length}/${SCENARIOS.length}: ${SCENARIOS.map(
        (s) => `${s.name}=${results.get(s.name)!.reasoning ? "yes" : "no"}`
      ).join(", ")}`
    ).toBeGreaterThanOrEqual(3);
  });
});
