import { describe, expect, it } from "vitest";
import {
  CALL_REASON,
  callOutcomeCompanionVars,
  callOutcomeLabel
} from "../supabase/functions/_shared/ai_flows/call_outcome_meta";

/**
 * The outcome/reason/label vocabulary is templated straight into texts a
 * teammate reads and gated on by live tenant flows, so both halves are pinned
 * here: the var NAMES (a rename silently breaks every `when` written against
 * them) and every phrase (a raw token reaching a person is the bug this
 * module exists to prevent).
 */

describe("callOutcomeCompanionVars", () => {
  it("derives both companions from the step's own outcome var", () => {
    expect(callOutcomeCompanionVars("call_outcome")).toEqual([
      "call_outcome_reason",
      "call_outcome_label"
    ]);
  });

  // Two call steps in one flow (a retry ladder) each carry their own saveAs,
  // and their companions must not collide or the second attempt would
  // overwrite the first attempt's reason.
  it("keeps two call steps' companions distinct", () => {
    const [firstReason] = callOutcomeCompanionVars("attempt_1");
    const [secondReason] = callOutcomeCompanionVars("attempt_2");
    expect(firstReason).toBe("attempt_1_reason");
    expect(secondReason).toBe("attempt_2_reason");
    expect(firstReason).not.toBe(secondReason);
  });
});

describe("callOutcomeLabel", () => {
  // A reason always wins over the coarse outcome, because it is the more
  // specific fact and the whole point of carrying it.
  it.each([
    [CALL_REASON.VOICEMAIL_LEFT, "left them a voicemail"],
    [CALL_REASON.VOICEMAIL_NO_MESSAGE, "reached their voicemail"],
    [CALL_REASON.OPTED_OUT, "did not call: they asked us to stop texting"],
    [CALL_REASON.DIAL_CAP, "did not call: already tried them several times today"],
    [CALL_REASON.OUTSIDE_CALL_WINDOW, "did not call: outside calling hours"],
    [CALL_REASON.TIER_BLOCKED, "did not call: outbound calling is not on this plan"],
    [CALL_REASON.NO_CALLEE_PHONE, "did not call: no usable phone number"]
  ])("explains %s", (reason, expected) => {
    expect(callOutcomeLabel("not_placed", reason)).toBe(expected);
  });

  // Both voicemail reasons ride a no_answer outcome (so ladders written
  // before AMD existed keep retrying), and the label still has to say which.
  it("distinguishes the two voicemail endings under one no_answer outcome", () => {
    expect(callOutcomeLabel("no_answer", CALL_REASON.VOICEMAIL_LEFT)).toBe(
      "left them a voicemail"
    );
    expect(callOutcomeLabel("no_answer", CALL_REASON.VOICEMAIL_NO_MESSAGE)).toBe(
      "reached their voicemail"
    );
  });

  it.each([
    ["transferred", "connected you live"],
    ["answered", "spoke with them"],
    ["no_answer", "no answer yet"],
    ["not_placed", "could not place the call"],
    ["failed", "the call failed"]
  ])("falls back to the outcome phrase for %s", (outcome, expected) => {
    expect(callOutcomeLabel(outcome)).toBe(expected);
    expect(callOutcomeLabel(outcome, null)).toBe(expected);
    expect(callOutcomeLabel(outcome, "")).toBe(expected);
  });

  // A stored definition can outlive the deploy that understands its outcome.
  // Saying nothing confident beats rendering a raw token into a teammate's
  // text, which is the failure this whole module exists to prevent.
  it("stays vague rather than leaking an unknown token to a person", () => {
    expect(callOutcomeLabel("some_future_outcome")).toBe("call outcome unknown");
    expect(callOutcomeLabel("")).toBe("call outcome unknown");
  });

  // An unrecognized reason must not swallow the outcome we DO understand.
  it("ignores an unknown reason and still explains the outcome", () => {
    expect(callOutcomeLabel("answered", "something_new")).toBe("spoke with them");
  });
});
