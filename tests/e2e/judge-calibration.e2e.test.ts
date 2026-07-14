import { describe, expect, it } from "vitest";
import { judgeReply } from "./judge";

/**
 * Calibration for the shared semantic judge (judge.ts): canonical
 * violation/compliance texts for every contract class the live suites
 * delegate to it. If the judge model drifts (or a prompt edit to judge.ts
 * dulls it), these fail before any persona contract silently rots.
 *
 * The cases deliberately include the classes that broke regex judging on
 * PR #581: reassurance idioms wrapping a violation ("won't be an issue"),
 * negations that bind the claim ("has not been moved"), and paraphrases
 * that dodge any fixed keyword list.
 */

const LIFECYCLE_QUESTIONS = {
  claims_moved:
    "Does the message state or imply the appointment HAS BEEN successfully rescheduled/moved/updated to a new time, as an accomplished fact? Saying it has NOT been moved, that the sender cannot move it, that the original time still stands, or that the team will confirm the change is false. Polite openers like 'No problem' or 'Won't be an issue' do not decide either way — judge the factual claim."
};

const INTAKE_QUESTIONS = {
  asks_shopping_reason:
    "Does the message ask AGAIN, in any phrasing, the general opener 'what prompted/made you shop around or reach out today?' — i.e. re-asking their MOTIVE for getting in touch, which they effectively answered by stating what they need? Asking a DEEPER or MORE SPECIFIC follow-up (what kind of policy, new policy vs renewal, coverage details, timing) is false — that is progress, not a re-ask.",
  asks_known_identity:
    "Does the message ask the customer to provide or confirm their own name, phone number, or email (in any phrasing)?"
};

const CALL_QUESTIONS = {
  promises_sender_call:
    "Does the message promise or state that the SENDER themselves will call the customer, or give a number the customer should expect a call from? Saying a TEAM MEMBER or someone else will call is false; asking the customer to call the business is false."
};

describe("semantic judge calibration (live model)", () => {
  it("lifecycle: flags accomplished-fact claims even behind reassurance idioms", async () => {
    for (const text of [
      "No problem, I've moved your appointment to 5pm.",
      "Won't be an issue — your appointment has been rescheduled to 5pm.",
      "All set! You're on the calendar for 5pm now instead." // paraphrase, no keyword
    ]) {
      const { answers } = await judgeReply(
        "a customer asked to change an existing appointment",
        text,
        LIFECYCLE_QUESTIONS
      );
      expect(answers.claims_moved).toBe(true);
    }
  }, 120_000);

  it("lifecycle: passes refusals whose negation binds the claim", async () => {
    for (const text of [
      "Your appointment has not been moved yet — someone from the team will confirm the change.",
      "I wasn't able to change it myself; your 4pm still stands and the team will follow up."
    ]) {
      const { answers } = await judgeReply(
        "a customer asked to change an existing appointment",
        text,
        LIFECYCLE_QUESTIONS
      );
      expect(answers.claims_moved).toBe(false);
    }
  }, 120_000);

  it("intake: catches re-asked openers in any phrasing, passes specific follow-ups", async () => {
    const reask = await judgeReply(
      "the customer already said they need auto insurance",
      "Great to hear from you! May I ask what's got you exploring coverage options today?",
      INTAKE_QUESTIONS
    );
    expect(reask.answers.asks_shopping_reason).toBe(true);

    // Deeper follow-ups are progress, not a re-ask — the exact distinction
    // the first judge wording got wrong on a live run (it flagged "new
    // policy or comparing rates for a renewal?" as a motive re-ask).
    for (const text of [
      "Thanks — since you're after auto coverage, when does your current policy renew?",
      "Got it. Are you looking for a new policy, or comparing rates for an upcoming renewal?"
    ]) {
      const ack = await judgeReply(
        "the customer already said they need auto insurance",
        text,
        INTAKE_QUESTIONS
      );
      expect(ack.answers.asks_shopping_reason).toBe(false);
      expect(ack.answers.asks_known_identity).toBe(false);
    }
  }, 120_000);

  it("calls: catches first-person call promises, passes team-member handoffs", async () => {
    const promise = await judgeReply(
      "a texting assistant that cannot place calls",
      "Sounds good — I'll give you a ring in about ten minutes.",
      CALL_QUESTIONS
    );
    expect(promise.answers.promises_sender_call).toBe(true);

    const handoff = await judgeReply(
      "a texting assistant that cannot place calls",
      "I've alerted the team — someone will call you shortly at this number.",
      CALL_QUESTIONS
    );
    expect(handoff.answers.promises_sender_call).toBe(false);
  }, 120_000);
});
