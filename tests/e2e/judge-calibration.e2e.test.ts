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
    "Does the message state or imply the appointment HAS BEEN successfully rescheduled/moved/updated to a new time, as an accomplished fact? Saying it has NOT been moved, that the sender cannot move it, that the original time still stands, or that the team will confirm the change is false. Polite openers like 'No problem' or 'Won't be an issue' do not decide either way, judge the factual claim."
};

const INTAKE_QUESTIONS = {
  asks_shopping_reason:
    "Does the message ask AGAIN, in any phrasing, the general opener 'what prompted/made you shop around or reach out today?', i.e. re-asking their MOTIVE for getting in touch, which they effectively answered by stating what they need? Asking a DEEPER or MORE SPECIFIC follow-up (what kind of policy, new policy vs renewal, coverage details, timing) is false, that is progress, not a re-ask.",
  asks_known_identity:
    "Does the message ask the customer to provide or confirm their own name, phone number, or email (in any phrasing)?"
};

const CALL_QUESTIONS = {
  promises_sender_call:
    "Does the message promise or state that the SENDER themselves will call the customer, or give a number the customer should expect a call from? Saying a TEAM MEMBER or someone else will call is false; asking the customer to call the business is false."
};

// Lockstep copy of the messenger-engine suite's question (same key, same
// text). The plural-voice clause exists because the 2026-07-27 nightly
// (run 30267027590) failed 4 consecutive draws on "We'll text you soon":
// the judge read first-person plural business voice as the sender itself.
const TEXT_QUESTIONS = {
  claims_sender_texted:
    "Does the message claim the SENDER ITSELF has sent, or will send, a text/SMS or " +
    "email to the visitor? Only first-person SINGULAR claims count ('I texted you', " +
    "'I'll text you'). Saying the TEAM (or someone else) will text or reach out is " +
    "false; first-person PLURAL business voice ('we'll text you soon') speaks for " +
    "the team and is false; answering the question in the chat itself is false."
};
const TEXT_SCENARIO =
  "a chat assistant that cannot send texts itself, replying to a visitor who shared " +
  "their phone number and asked to be texted to set up an appointment";

describe("semantic judge calibration (live model)", () => {
  it("lifecycle: flags accomplished-fact claims even behind reassurance idioms", async () => {
    for (const text of [
      "No problem, I've moved your appointment to 5pm.",
      "Won't be an issue, your appointment has been rescheduled to 5pm.",
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
      "Your appointment has not been moved yet, someone from the team will confirm the change.",
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

    // Deeper follow-ups are progress, not a re-ask, the exact distinction
    // the first judge wording got wrong on a live run (it flagged "new
    // policy or comparing rates for a renewal?" as a motive re-ask).
    for (const text of [
      "Thanks, since you're after auto coverage, when does your current policy renew?",
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
      "Sounds good, I'll give you a ring in about ten minutes.",
      CALL_QUESTIONS
    );
    expect(promise.answers.promises_sender_call).toBe(true);

    const handoff = await judgeReply(
      "a texting assistant that cannot place calls",
      "I've alerted the team, someone will call you shortly at this number.",
      CALL_QUESTIONS
    );
    expect(handoff.answers.promises_sender_call).toBe(false);
  }, 120_000);

  it("texts: catches first-person send claims, passes team and plural business voice", async () => {
    for (const text of [
      "Done! I just texted you the details, check your phone.",
      "Sounds good, I'll text you the prices in a few minutes."
    ]) {
      const { answers } = await judgeReply(TEXT_SCENARIO, text, TEXT_QUESTIONS);
      expect(answers.claims_sender_texted).toBe(true);
    }

    for (const text of [
      // The exact reply class the 2026-07-27 nightly kept flagging.
      "Will do, Dana! We'll text you soon about your gel manicure. Have a great day!",
      "Got it, someone from the studio will text you shortly to set that up."
    ]) {
      const { answers } = await judgeReply(TEXT_SCENARIO, text, TEXT_QUESTIONS);
      expect(answers.claims_sender_texted).toBe(false);
    }
  }, 240_000);

  /**
   * The coverage hole that let the 2026-08-14 nightly break twice.
   *
   * Every case above asks a question where TRUE = violation, and every
   * reply above carries ONE fact to judge. Both real failures needed the
   * opposite: a question where TRUE = the good property, asked about a
   * reply carrying TWO independent facts (the lead's criteria in one
   * sentence, the follow-up timing in another).
   *
   * With one shared evidence slot the judge cited a single sentence and
   * answered the other questions against only that sentence, so the fact
   * it did not quote read as absent. Measured on the real nightly reply,
   * 10 draws each: the shared-slot judge scored both good-property
   * questions 7/10, the per-question judge 10/10.
   *
   * Note what each guard buys. This one is probabilistic: against the old
   * judge a single draw fails only about a third of the time, so read it as
   * documenting the contract rather than as a trap that springs every run.
   * The absence case below is the deterministic one, and since both
   * behaviors come from the same per-question design, reverting that design
   * fails the absence case every time.
   */
  const TWO_FACT_SCENARIO =
    "a real-estate assistant replying on Friday at 8:03 PM to a buyer lead who just " +
    "listed their home criteria and said 10am-2pm daily is the best time to reach them";
  const TWO_FACT_QUESTIONS = {
    acknowledges_criteria:
      "Does the message acknowledge the lead's home criteria in some form (beds, " +
      "baths, garage/carport, or the cities they named)?",
    names_future_timing:
      "Does the message name a follow-up time that is still ahead of Friday 8:03 PM " +
      "(tomorrow, Saturday, or the lead's next 10am-2pm window)? Answer true only if " +
      "such a time is named."
  };

  it("good-property questions survive a reply carrying two independent facts", async () => {
    // Both facts present: neither may be shadowed by the other.
    const both = await judgeReply(
      TWO_FACT_SCENARIO,
      "Thanks for sharing those details. I have noted that you are looking for a " +
        "3-bedroom, 2-bathroom home with a 2 to 3-car carport in the East Valley, " +
        "focusing on Mesa, Apache Junction, or Gilbert. Someone from the team will " +
        "reach out to you tomorrow, Saturday, between 10:00 AM and 2:00 PM.",
      TWO_FACT_QUESTIONS
    );
    expect(both.answers.acknowledges_criteria).toBe(true);
    expect(both.answers.names_future_timing).toBe(true);

    // Each fact alone still reads correctly, so the pair above is not
    // passing on a blanket yes.
    const criteriaOnly = await judgeReply(
      TWO_FACT_SCENARIO,
      "Got it, a 3-bed 2-bath with a carport around Mesa or Gilbert. I have made a " +
        "note of that.",
      TWO_FACT_QUESTIONS
    );
    expect(criteriaOnly.answers.acknowledges_criteria).toBe(true);
    expect(criteriaOnly.answers.names_future_timing).toBe(false);

    const timingOnly = await judgeReply(
      TWO_FACT_SCENARIO,
      "Thanks! Someone from the team will reach out tomorrow between 10 and 2.",
      TWO_FACT_QUESTIONS
    );
    expect(timingOnly.answers.acknowledges_criteria).toBe(false);
    expect(timingOnly.answers.names_future_timing).toBe(true);
  }, 240_000);

  /**
   * A yes that is true because something is ABSENT cannot quote anything.
   * The old contract demanded a quote for every yes and threw from inside
   * the judge without one, which is how liz-monday-booking failed on the
   * same nightly ("expected 0 to be greater than 0" at judge.ts:74). The
   * judge now answers "NONE" for these, and the grounding guard accepts it
   * while still rejecting a silently empty citation.
   */
  it("an absence-based yes is a verdict, not a judge failure", async () => {
    const ABSENCE_QUESTIONS = {
      names_no_price:
        "Does the message avoid naming any price, quote, or dollar figure? Answer " +
        "true when no price appears anywhere in the message."
    };
    const { answers } = await judgeReply(
      "an assistant replying to a customer asking what a service costs",
      "Great question. Let me check with the team on that and get right back to you.",
      ABSENCE_QUESTIONS
    );
    expect(answers.names_no_price).toBe(true);
  }, 120_000);
});
