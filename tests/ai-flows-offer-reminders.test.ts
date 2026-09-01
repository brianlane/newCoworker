import { describe, expect, it } from "vitest";
import {
  DEFAULT_REMINDER_INTERVAL_MINUTES,
  DEFAULT_REMINDER_ROUNDS,
  FINAL_REMINDER_BANNER,
  nextReminderRound,
  reminderClaimHint,
  reminderText,
  stripEmphasis
} from "../supabase/functions/_shared/ai_flows/offer_reminders";

/**
 * The reminder ladder Amy asked for on 2026-08-10: three nudges to the same
 * offerees, twenty minutes apart, then the owner inherits the lead. The last
 * one trades asterisks for a row of double exclamation marks.
 */

const BASE = {
  leadLabel: "Daniel Villanueva",
  leadPhone: "+14802949456",
  rounds: 3,
  intervalMinutes: 20,
  ownerLabel: "Amy",
  details: "Lead type: seller\nWhat they asked for: comparables by email, then a call Monday",
  claimHint: 'You have *2 unclaimed leads*. Reply "1, Daniel" to claim this one.'
};

describe("defaults", () => {
  it("match the ask: 3 rounds, 20 minutes apart", () => {
    expect(DEFAULT_REMINDER_ROUNDS).toBe(3);
    expect(DEFAULT_REMINDER_INTERVAL_MINUTES).toBe(20);
  });
});

describe("stripEmphasis", () => {
  it("removes matched emphasis pairs", () => {
    expect(stripEmphasis("*bold* and *more*")).toBe("bold and more");
  });

  it("leaves a lone asterisk alone", () => {
    expect(stripEmphasis("2 * 3 = 6")).toBe("2 * 3 = 6");
    expect(stripEmphasis("* bullet")).toBe("* bullet");
  });

  it("does not span lines", () => {
    expect(stripEmphasis("*one\ntwo*")).toBe("*one\ntwo*");
  });
});

describe("reminderText: rounds before the last", () => {
  const text = reminderText({ ...BASE, round: 1 });

  it("counts itself and keeps the asterisks", () => {
    expect(text).toContain("*REMINDER 1 of 3*");
    expect(text).toContain("*still unclaimed*");
  });

  it("names the lead with its phone", () => {
    expect(text).toContain("Daniel Villanueva (+14802949456)");
  });

  it("carries the flow's compact details and the claim hint", () => {
    expect(text).toContain("Lead type: seller");
    expect(text).toContain('Reply "1, Daniel" to claim this one.');
  });

  it("promises the next round rather than the handover", () => {
    expect(text).toContain("Another reminder in 20 minutes.");
    expect(text).not.toContain("Amy");
    expect(text).not.toContain(FINAL_REMINDER_BANNER);
  });
});

describe("reminderText: the final round", () => {
  const text = reminderText({ ...BASE, round: 3 });

  it("leads with the banner row", () => {
    expect(text.startsWith(`${FINAL_REMINDER_BANNER}\n`)).toBe(true);
    expect(text).toContain("FINAL REMINDER: Daniel Villanueva (+14802949456) is still unclaimed.");
  });

  it("carries no asterisk emphasis at all, including from the claim hint", () => {
    expect(text).not.toContain("*");
    expect(text).toContain('You have 2 unclaimed leads. Reply "1, Daniel" to claim this one.');
  });

  it("names who inherits the lead and when", () => {
    expect(text).toContain("No answer in 20 minutes and this goes to Amy.");
  });

  it("falls back to 'the owner' when no owner name is known", () => {
    expect(reminderText({ ...BASE, round: 3, ownerLabel: "" })).toContain("goes to the owner.");
  });
});

describe("reminderText: degraded lead facts", () => {
  it("uses the name alone when there is no phone", () => {
    expect(reminderText({ ...BASE, round: 1, leadPhone: "" })).toContain(
      "Daniel Villanueva is *still unclaimed*"
    );
  });

  it("uses the phone alone when there is no name", () => {
    expect(reminderText({ ...BASE, round: 1, leadLabel: "" })).toContain("+14802949456 is");
  });

  it("degrades to a generic subject when the flow captured neither", () => {
    expect(reminderText({ ...BASE, round: 1, leadLabel: "", leadPhone: "" })).toContain(
      "This lead is *still unclaimed*"
    );
  });

  it("omits the detail block entirely when there is none", () => {
    const text = reminderText({ ...BASE, round: 1, details: undefined });
    expect(text).not.toContain("Lead type");
    expect(text).not.toContain("\n\n\n");
  });
});

describe("reminderClaimHint", () => {
  it("names the lead when the teammate holds more than one", () => {
    expect(reminderClaimHint(2, "Daniel")).toBe(
      'You have *2 unclaimed leads*. Reply "1, Daniel" to claim this one.'
    );
  });

  it("keeps the bare digit when there is only one lead to claim", () => {
    expect(reminderClaimHint(1, "Daniel")).toBe("Reply 1 to claim it.");
    expect(reminderClaimHint(0, "Daniel")).toBe("Reply 1 to claim it.");
  });

  it("does not promise a name reply when no name was captured", () => {
    expect(reminderClaimHint(2, "")).toBe("Reply 1 to claim it.");
  });
});

describe("nextReminderRound", () => {
  it("walks the ladder then hands over", () => {
    const config = { rounds: 3, intervalMinutes: 20 };
    expect(nextReminderRound(0, config)).toBe(1);
    expect(nextReminderRound(1, config)).toBe(2);
    expect(nextReminderRound(2, config)).toBe(3);
    // Round 3 already sent: the next timeout is the owner's.
    expect(nextReminderRound(3, config)).toBeNull();
    expect(nextReminderRound(9, config)).toBeNull();
  });

  it("hands over immediately when the ladder is switched off", () => {
    expect(nextReminderRound(0, { rounds: 0, intervalMinutes: 20 })).toBeNull();
  });
});

describe("no em dashes in any reminder copy", () => {
  it("holds for every round", () => {
    for (const round of [1, 2, 3]) {
      expect(reminderText({ ...BASE, round })).not.toMatch(/—/);
    }
  });
});
