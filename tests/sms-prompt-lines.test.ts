import { describe, expect, it } from "vitest";
import {
  SMS_CONVERSATION_QUALITY_LINE,
  SMS_GROUNDED_ACTIONS_LINE,
  SMS_IDENTITY_LINE
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
});
