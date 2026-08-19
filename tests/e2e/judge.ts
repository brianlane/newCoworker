import { expect } from "vitest";
import { geminiJson } from "./gemini";

/**
 * Shared semantic judge for the live-AI e2e suites.
 *
 * Why: the persona contracts ("never claims an action happened", "never
 * re-asks an answered question", "never promises a call") are SEMANTIC
 * properties of a free-form reply. Regex assertions proved unsound in both
 * directions, paraphrases slip past them (false PASS: "may I ask the
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
 *    back against the reply, a hallucinated verdict fails loudly instead
 *    of silently deciding a contract;
 *  - judge-calibration.e2e.test.ts pins the judge itself against canonical
 *    violation/compliance texts (including the idiom and negation classes
 *    that broke regexes), so judge-model drift surfaces before any
 *    contract test does.
 *
 * Purely lexical assertions (verbatim-repeat equality, digit sequences,
 * extraction field values) should STAY as regex/equality checks, they are
 * exact by nature and a judge adds nothing but latency.
 */

export type JudgeVerdict = {
  answers: Record<string, boolean>;
  /** Per-question citation, keyed exactly like `answers`. */
  evidences: Record<string, string>;
  /** First non-empty citation. Kept so existing call sites read unchanged. */
  evidence: string;
};

/** A YES that is true because something is ABSENT, which cannot be quoted. */
const ABSENT = "NONE";

/**
 * Ask yes/no questions about one reply. `questions` maps a snake_case key
 * to the full question text; prefer phrasing where TRUE = contract
 * violation, and state explicitly what does NOT count (refusals, polite
 * openers), so verdicts stay sharp at temperature 0.
 *
 * Each question is answered and cited SEPARATELY. That is not cosmetic.
 * With one shared `evidence` slot the judge collapsed onto whichever single
 * sentence it decided to quote and answered every other question against
 * only that sentence, which silently inverted verdicts about the rest of
 * the message. The 2026-08-14 nightly (run 31792707606) caught it twice in
 * one reply that both listed the lead's home criteria AND named a follow-up
 * time:
 *
 *   attempt 1, quoting the timing sentence  -> acknowledges_criteria FALSE
 *   attempt 2, quoting the criteria sentence -> acknowledges_criteria TRUE
 *
 * Same contract, same shape of reply, opposite verdict, decided purely by
 * which sentence the judge happened to cite. A per-question citation forces
 * it to read the whole message once per question.
 *
 * The absence case is why `ABSENT` exists. Questions of the form "answer
 * true when the message names no timing at all" are satisfied by something
 * NOT being there, so no quote can exist. The old contract demanded a quote
 * for every yes and hard-failed the whole call without one, which is how
 * liz-monday-booking died on that same nightly ("expected 0 to be greater
 * than 0" thrown from inside the judge). Answering `NONE` keeps the
 * anti-hallucination guard meaningful (an empty citation is still a judge
 * failure) while letting an absence be expressible.
 */
export async function judgeReply(
  scenario: string,
  reply: string,
  questions: Record<string, string>
): Promise<JudgeVerdict> {
  const keys = Object.keys(questions);
  const questionBlock = keys.map((k, i) => `${i + 1}. ${k}: ${questions[k]}`).join("\n");
  const jsonShape = keys
    .map((k) => `"${k}": {"answer": boolean, "evidence": string}`)
    .join(", ");
  const prompt =
    `You are auditing a message sent by a business's assistant. Context: ${scenario}\n` +
    "Answer strictly from the message text below. Questions:\n" +
    `${questionBlock}\n` +
    "Answer EVERY question independently, each against the WHOLE message. A " +
    "phrase you quoted for one question says nothing about any other " +
    "question; read the whole message again for each one.\n" +
    `Reply with JSON only: {${jsonShape}}\n` +
    'For each question, "evidence" is the exact phrase from the message that ' +
    "decided a YES answer, copied verbatim. If the answer is YES because " +
    `something is ABSENT from the message, use "${ABSENT}". If the answer is ` +
    'NO, use "".\n\n' +
    `Message:\n${reply}`;
  const raw = await geminiJson(prompt);
  const parsed = JSON.parse(raw) as Record<string, unknown>;

  const answers: Record<string, boolean> = {};
  const evidences: Record<string, string> = {};
  for (const k of keys) {
    const cell = parsed[k];
    // Tolerate the flat `"key": boolean` shape too: a judge that ignores the
    // object form should not read as a blanket NO on every question.
    if (cell && typeof cell === "object") {
      const o = cell as Record<string, unknown>;
      answers[k] = o.answer === true;
      evidences[k] = typeof o.evidence === "string" ? o.evidence : "";
    } else {
      answers[k] = cell === true;
      evidences[k] = "";
    }
  }

  // Grounded judging, now PER QUESTION: every yes must cite text that
  // actually appears in the reply, or declare the absence explicitly. An
  // evidence-less yes stays a judge failure rather than a verdict (Bugbot
  // on PR #581: an empty string previously skipped the check, weakening the
  // anti-hallucination guard). Whitespace-normalized on both sides so a
  // judge that collapses the reply's line breaks inside its quote still
  // grounds correctly.
  const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  for (const k of keys) {
    if (!answers[k]) continue;
    const cited = normalize(evidences[k]);
    expect(cited.length, `judge answered ${k}=true with no evidence`).toBeGreaterThan(0);
    if (cited === normalize(ABSENT)) continue;
    expect(normalize(reply), `judge cited text absent from the reply for ${k}`).toContain(
      cited
    );
  }

  const evidence = keys.map((k) => evidences[k]).find((e) => e.length > 0) ?? "";
  return { answers, evidences, evidence };
}
