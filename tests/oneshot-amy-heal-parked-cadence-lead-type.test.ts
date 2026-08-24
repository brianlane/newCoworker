/**
 * Healing the parked cadence runs that were filed as sellers
 * (scripts/oneshot/amy-heal-parked-cadence-lead-type.ts).
 *
 * The companion to the note fix: that one repairs the future, this one repairs
 * runs already sitting in a three-day `wait_for_reply` with a `lead_type` the
 * flow could not know. A wrong value there is not history, it decides which
 * half of the roster hears about the lead when they answer.
 *
 * The rule is evidence-only, and these tests pin the refusals as hard as the
 * corrections: guessing a type would just relocate the bug being fixed.
 */
import { describe, expect, it } from "vitest";
import {
  EVIDENCE_VAR,
  LEAD_TYPES,
  decideHeal,
  runMentionsPhone,
  type TypeEvidence
} from "../scripts/oneshot/amy-heal-parked-cadence-lead-type";

const ev = (flowName: string, leadType: string): TypeEvidence => ({ flowName, leadType });

describe("decideHeal", () => {
  it("corrects a run whose filing flow established a different type", () => {
    // Sandy Baldwin, Aug 23 2026: ReferralExchange extracted buyer, the
    // cadence wrote seller, and her run was parked until Aug 26.
    expect(decideHeal("seller", [ev("ReferralExchange Lead", "buyer")])).toEqual({
      outcome: "correct",
      from: "seller",
      to: "buyer",
      sources: ["ReferralExchange Lead"]
    });
    // Frank Demarco, the other live mismatch: both, not seller.
    expect(decideHeal("seller", [ev("ReferralExchange Lead", "both")])).toMatchObject({
      outcome: "correct",
      to: "both"
    });
  });

  it("reports an unset value as unset rather than as an empty string", () => {
    expect(decideHeal(undefined, [ev("New Lead Intake", "buyer")])).toMatchObject({
      outcome: "correct",
      from: "(unset)",
      to: "buyer"
    });
    expect(decideHeal(42, [ev("New Lead Intake", "buyer")])).toMatchObject({ from: "(unset)" });
  });

  it("leaves a run alone when the evidence agrees with it", () => {
    // Four of the parked ReferralExchange runs are genuinely sellers. The
    // script must report nothing for them, which is also what makes it
    // idempotent: a corrected run lands here on the next pass.
    expect(decideHeal("seller", [ev("ReferralExchange Lead", "seller")])).toEqual({
      outcome: "already_right",
      leadType: "seller"
    });
  });

  it("skips a lead nothing established a type for, which is every Clever run", () => {
    // "Clever Lead - Accept" extracts no lead_type, so it offers no evidence.
    // Their seller is correct on its own merits: Clever Offers is a seller
    // program whose referral text says "Seller" outright.
    expect(decideHeal("seller", [])).toEqual({ outcome: "no_evidence" });
    // A non-answer from a flow that CAN say "none" is not evidence either.
    expect(decideHeal("seller", [ev("ReferralExchange Lead", "none")])).toEqual({
      outcome: "no_evidence"
    });
    expect(decideHeal("seller", [ev("X", ""), ev("Y", "SELLER")])).toEqual({
      outcome: "no_evidence"
    });
  });

  it("REFUSES when two flows disagree, rather than picking one", () => {
    // The Aug 8 2026 case this account already has form for: the same person
    // arrived as two leads seconds apart, one seller and one buyer. Choosing
    // between them here would relocate the misrouting, not fix it.
    expect(
      decideHeal("seller", [ev("ReferralExchange Lead", "buyer"), ev("Realtor.com Lead", "seller")])
    ).toEqual({ outcome: "conflicting", found: ["buyer", "seller"] });
  });

  it("treats repeated agreement from many runs as one source", () => {
    const many = [
      ev("ReferralExchange Lead", "buyer"),
      ev("ReferralExchange Lead", "buyer"),
      ev("New Lead Intake", "buyer")
    ];
    expect(decideHeal("seller", many)).toEqual({
      outcome: "correct",
      from: "seller",
      to: "buyer",
      sources: ["New Lead Intake", "ReferralExchange Lead"]
    });
  });

  it("accepts exactly the three routable answers and nothing else", () => {
    expect([...LEAD_TYPES]).toEqual(["buyer", "seller", "both"]);
    for (const t of LEAD_TYPES) {
      expect(decideHeal("seller", [ev("f", t)]).outcome).toBe(
        t === "seller" ? "already_right" : "correct"
      );
    }
  });
});

describe("EVIDENCE_VAR", () => {
  it("reads lead_type ONLY, never the lookalike route_lead_type", () => {
    // Two different traps behind one name on this account:
    //  - "Follow Up Requested" defines route_lead_type as `... when it does
    //    not say, "seller"`, the identical default this heal exists to
    //    overturn. Reading it would launder that guess into evidence: it
    //    either blesses a wrongly-parked seller as already_right, or collides
    //    with a real answer and forces a conflicting refusal. Both leave a
    //    fixable misroute alone.
    //  - "ReferralExchange Lead" defines it by REACHABILITY, answering "none"
    //    when the lead is email-only. That is a routing decision keyed on
    //    contact channel, not a statement about the person.
    expect(EVIDENCE_VAR).toBe("lead_type");
  });
});

describe("runMentionsPhone", () => {
  it("matches a lead's number wherever a flow spells it", () => {
    const ctx = { vars: { route_lead_phone: "+13202931236", lead_name: "Sandy" } };
    expect(runMentionsPhone(ctx, "+13202931236")).toBe(true);
    expect(runMentionsPhone(ctx, "+16025550000")).toBe(false);
  });

  it("never matches on an empty phone, which would pull in every run", () => {
    // Two parked runs carry no lead_phone at all. Treating "" as a match
    // would make every other run in the business their evidence.
    expect(runMentionsPhone({ vars: { a: 1 } }, "")).toBe(false);
    expect(runMentionsPhone(null, "")).toBe(false);
  });

  it("tolerates a null or absent context", () => {
    expect(runMentionsPhone(null, "+13202931236")).toBe(false);
    expect(runMentionsPhone(undefined, "+13202931236")).toBe(false);
  });
});
