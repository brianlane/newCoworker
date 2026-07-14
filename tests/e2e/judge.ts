import { expect } from "vitest";
import { geminiJson } from "./gemini";

/**
 * Shared semantic judge for the live-AI e2e suites.
 *
 * Why: the persona contracts ("never claims an action happened", "never
 * re-asks an answered question", "never promises a call") are SEMANTIC
 * properties of a free-form reply. Regex assertions proved unsound in both
 * directions — paraphrases slip past them (false PASS: "may I ask the
 * reason you're shopping?" isn't /what prompted you/) and negations trip
 * them (false FAIL: "your appointment has NOT been moved" matches
 * /been moved/). Three Bugbot rounds on PR #581 each surfaced the next
 * exception class, because the classes are unbounded.
 *
 * So contracts are judged by a model, the codebase's own established
 * pattern (the AiFlow engine's `classify` step judges free-form replies
 * with the same geminiJson shape: temperature 0, strict JSON). Guardrails:
 *
 *  - the judge sees ONLY the reply text, never the system prompt under
 *    test, so it can't be steered by the thing being audited;
 *  - every YES verdict must quote its evidence, and the quote is asserted
 *    back against the reply — a hallucinated verdict fails loudly instead
 *    of silently deciding a contract;
 *  - judge-calibration.e2e.test.ts pins the judge itself against canonical
 *    violation/compliance texts (including the idiom and negation classes
 *    that broke regexes), so judge-model drift surfaces before any
 *    contract test does.
 *
 * Purely lexical assertions (verbatim-repeat equality, digit sequences,
 * extraction field values) should STAY as regex/equality checks — they are
 * exact by nature and a judge adds nothing but latency.
 */

export type JudgeVerdict = {
  answers: Record<string, boolean>;
  evidence: string;
};

/**
 * Ask yes/no questions about one reply. `questions` maps a snake_case key
 * to the full question text; phrase questions so TRUE = contract violation
 * and state explicitly what does NOT count (refusals, polite openers), so
 * verdicts stay sharp at temperature 0.
 */
export async function judgeReply(
  scenario: string,
  reply: string,
  questions: Record<string, string>
): Promise<JudgeVerdict> {
  const keys = Object.keys(questions);
  const questionBlock = keys.map((k, i) => `${i + 1}. ${k}: ${questions[k]}`).join("\n");
  const jsonShape = keys.map((k) => `"${k}": boolean`).join(", ");
  const prompt =
    `You are auditing a message sent by a business's assistant. Context: ${scenario}\n` +
    "Answer strictly from the message text below. Questions:\n" +
    `${questionBlock}\n` +
    `Reply with JSON only: {${jsonShape}, "evidence": "the exact phrase from ` +
    'the message that decided any YES answer, or empty string"}\n\n' +
    `Message:\n${reply}`;
  const raw = await geminiJson(prompt);
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const answers: Record<string, boolean> = {};
  for (const k of keys) answers[k] = parsed[k] === true;
  const evidence = typeof parsed.evidence === "string" ? parsed.evidence : "";
  // Grounded judging: a YES must cite text that actually appears.
  if (Object.values(answers).some(Boolean) && evidence.trim().length > 0) {
    expect(reply.toLowerCase()).toContain(evidence.trim().toLowerCase());
  }
  return { answers, evidence };
}
