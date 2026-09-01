import { describe, expect, it } from "vitest";
import {
  SMS_CONVERSATION_QUALITY_LINE,
  SMS_GROUNDED_ACTIONS_LINE,
  SMS_IDENTITY_LINE,
  SMS_STAFF_CLAIM_LINE
} from "../supabase/functions/_shared/sms_prompt_lines";

/**
 * Pins the load-bearing phrases of the SMS worker's always-injected prompt
 * lines. Each maps to a production incident; deleting or rewording the
 * covering sentence should fail here first (the live replay in
 * tests/e2e/sms-call-promise.e2e.test.ts then re-verifies model behavior).
 */

describe("SMS prompt lines", () => {
  it("identity: never self-identify as software", () => {
    expect(SMS_IDENTITY_LINE).toContain("never as an AI");
    expect(SMS_IDENTITY_LINE).toContain("don't claim to be human");
  });

  it("grounded actions: the no-phantom-phone-calls rule (Derek Schultz, 2026-07-09)", () => {
    expect(SMS_GROUNDED_ACTIONS_LINE).toContain("cannot place or receive phone calls");
    expect(SMS_GROUNDED_ACTIONS_LINE).toContain("NEVER tell the texter that you will call");
    // The escape hatch: a human calls, and only after notify_team succeeds.
    expect(SMS_GROUNDED_ACTIONS_LINE).toContain(
      "call notify_team with their number and preferred time"
    );
    // The incident quoted a number the lead should expect a call from.
    expect(SMS_GROUNDED_ACTIONS_LINE).toContain("never quote a different callback number");
    // Tools-unavailable worst case: no call promise in ANY person.
    expect(SMS_GROUNDED_ACTIONS_LINE).toContain("do not promise a call AT ALL");
  });

  it("grounded actions: no promised future texts without schedule_text (R V / KYP Ads, 2026-08-28)", () => {
    // R V asked for a reminder 30 minutes before his Monday call and was
    // told "I'll make sure you get a reminder text at 6:30 PM Eastern".
    // Nothing was queued: the texting coworker had no way to send later.
    expect(SMS_GROUNDED_ACTIONS_LINE).toContain("NEVER promise a reminder");
    expect(SMS_GROUNDED_ACTIONS_LINE).toContain("unless schedule_text returned success");
    // The tools-off / tool-refused worst case, mirroring the call rule.
    expect(SMS_GROUNDED_ACTIONS_LINE).toContain("do not promise a later text AT ALL");
    // Measured gap: without this, the model keeps the promise and just
    // reassigns it ("someone on the team will make sure you get a nudge at
    // 6:30 PM Eastern"), which is the Derek Schultz shape again. Naming the
    // TIME is what makes it a promise, so that is what the rule bans:
    // scored over 20 draws (10 per temperature) the softer wording still
    // delegated a timed promise 4 times, this one 0.
    expect(SMS_GROUNDED_ACTIONS_LINE).toContain(
      "never name a time at which they will hear from anyone"
    );
    // The queue is bound to the person being texted, and holds exactly one.
    expect(SMS_GROUNDED_ACTIONS_LINE).toContain("never a third party");
    expect(SMS_GROUNDED_ACTIONS_LINE).toContain("MOVES that one");
  });

  it("grounded actions: the booking honesty rules (Truly booking incident)", () => {
    expect(SMS_GROUNDED_ACTIONS_LINE).toContain(
      "An appointment exists ONLY if calendar_book_appointment returned success"
    );
    expect(SMS_GROUNDED_ACTIONS_LINE).toContain("booking_link_created");
    expect(SMS_GROUNDED_ACTIONS_LINE).toContain("Never invent or guess email addresses");
  });

  it("conversation quality: the anti-repetition rule (Derek's verbatim repeat)", () => {
    expect(SMS_CONVERSATION_QUALITY_LINE).toContain("Vary your acknowledgements");
    expect(SMS_CONVERSATION_QUALITY_LINE).toContain(
      "rather than restating your previous message"
    );
    expect(SMS_CONVERSATION_QUALITY_LINE).toContain("never ask for information you already have");
  });

  it("staff claims: never promise a lead is theirs (Jason Lane, 2026-08-31)", () => {
    expect(SMS_STAFF_CLAIM_LINE).toContain("you cannot assign a lead");
    expect(SMS_STAFF_CLAIM_LINE).toContain("Never say a lead is theirs");
    expect(SMS_STAFF_CLAIM_LINE).toContain("reply 1");
    expect(SMS_STAFF_CLAIM_LINE).toContain("1, the lead's first name");
  });
});
