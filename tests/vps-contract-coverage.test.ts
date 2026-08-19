import { describe, expect, it } from "vitest";

import {
  COVERAGE_SLACK_MS,
  assessContractCoverage,
  contractCoverageTargetAt,
  hostingerTermForRemainingMonths,
  isContractBillingPeriod,
  isRefundExposureOpen,
  remainingContractMonths
} from "@/lib/vps/contract-coverage";
import type { SubscriptionRow } from "@/lib/db/subscriptions";
import type { CustomerProfileRow } from "@/lib/db/customer-profiles";

const NOW = new Date("2026-08-14T00:00:00Z");

function subFor(
  billingPeriod: SubscriptionRow["billing_period"],
  periodEnd: string | null
): Pick<SubscriptionRow, "billing_period" | "stripe_current_period_end"> {
  return { billing_period: billingPeriod, stripe_current_period_end: periodEnd };
}

function profileFor(
  firstPaidAt: string | null,
  refundUsedAt: string | null = null
): Pick<CustomerProfileRow, "first_paid_at" | "refund_used_at"> {
  return { first_paid_at: firstPaidAt, refund_used_at: refundUsedAt };
}

describe("isContractBillingPeriod", () => {
  it("counts annual and biennial as prepaid commitments", () => {
    expect(isContractBillingPeriod("annual")).toBe(true);
    expect(isContractBillingPeriod("biennial")).toBe(true);
  });

  it("does not count monthly or an unset period", () => {
    expect(isContractBillingPeriod("monthly")).toBe(false);
    expect(isContractBillingPeriod(null)).toBe(false);
  });
});

describe("contractCoverageTargetAt", () => {
  it("returns the live Stripe period end for a contract", () => {
    const at = contractCoverageTargetAt(subFor("biennial", "2028-07-01T00:00:00Z"));
    expect(at?.toISOString()).toBe("2028-07-01T00:00:00.000Z");
  });

  it("returns null for a monthly tenant (nothing to cover)", () => {
    expect(contractCoverageTargetAt(subFor("monthly", "2026-09-01T00:00:00Z"))).toBeNull();
  });

  it("returns null when the period end is missing or unparseable", () => {
    expect(contractCoverageTargetAt(subFor("annual", null))).toBeNull();
    expect(contractCoverageTargetAt(subFor("annual", "not-a-date"))).toBeNull();
  });
});

describe("remainingContractMonths", () => {
  it("rounds a partial month UP so it still gets funded", () => {
    expect(
      remainingContractMonths(new Date("2026-08-14T00:00:00Z"), new Date("2026-09-01T00:00:00Z"))
    ).toBe(1);
  });

  it("returns 0 when the target has already passed", () => {
    expect(
      remainingContractMonths(new Date("2026-08-14T00:00:00Z"), new Date("2026-08-01T00:00:00Z"))
    ).toBe(0);
    expect(remainingContractMonths(NOW, NOW)).toBe(0);
  });

  // Regression: counting by dividing the gap by an average 30.44-day month
  // read this exact span (731 days across the 2028 leap year) as 24.01
  // months and rounded it up to 25, which pushes term selection a notch too
  // high and buys hardware we do not need.
  it("reads a two-year gap spanning a leap year as exactly 24 months", () => {
    expect(
      remainingContractMonths(new Date("2026-08-14T00:00:00Z"), new Date("2028-08-14T00:00:00Z"))
    ).toBe(24);
  });

  it("reads an exact one-year gap as exactly 12 months", () => {
    expect(
      remainingContractMonths(new Date("2026-08-14T00:00:00Z"), new Date("2027-08-14T00:00:00Z"))
    ).toBe(12);
  });

  // Month arithmetic has to clamp rather than spill: Jan 31 plus one month
  // is Feb 28, not Mar 3, or a month-end anniversary drifts every cycle.
  it("clamps a month-end anniversary instead of spilling into the next month", () => {
    expect(
      remainingContractMonths(new Date("2027-01-31T00:00:00Z"), new Date("2027-02-28T00:00:00Z"))
    ).toBe(1);
  });

  it("counts one extra month for any remainder past a whole month", () => {
    expect(
      remainingContractMonths(new Date("2026-08-14T00:00:00Z"), new Date("2027-08-15T00:00:00Z"))
    ).toBe(13);
  });
});

describe("hostingerTermForRemainingMonths", () => {
  it("buys monthly for a month or less", () => {
    expect(hostingerTermForRemainingMonths(0)).toBe("1m");
    expect(hostingerTermForRemainingMonths(1)).toBe("1m");
  });

  it("buys a year for anything up to twelve months", () => {
    expect(hostingerTermForRemainingMonths(2)).toBe("1y");
    expect(hostingerTermForRemainingMonths(12)).toBe("1y");
  });

  // Over-buying is deliberate in this direction: Hostinger sells no 18-month
  // term, surplus runway is consumed by the contract's own renewal, and a 2y
  // box is cheaper PER MONTH than stacking two 1y purchases.
  it("rounds anything over a year up to two years", () => {
    expect(hostingerTermForRemainingMonths(13)).toBe("2y");
    expect(hostingerTermForRemainingMonths(24)).toBe("2y");
    expect(hostingerTermForRemainingMonths(40)).toBe("2y");
  });
});

describe("assessContractCoverage", () => {
  it("treats a monthly tenant as always covered", () => {
    expect(
      assessContractCoverage({
        subscription: subFor("monthly", "2026-09-01T00:00:00Z"),
        boxPaidThrough: null,
        now: NOW
      })
    ).toEqual({ covered: true, reason: "no_contract" });
  });

  // The headline new-strategy case: signup bought a monthly box, the tenant
  // committed for 24 months, so ~23 months are unfunded and a 2y box closes
  // it in one purchase.
  it("sees a monthly box under a 24-month contract as short by ~23 months", () => {
    const result = assessContractCoverage({
      subscription: subFor("biennial", "2028-08-14T00:00:00Z"),
      boxPaidThrough: "2026-09-14T00:00:00Z",
      now: NOW
    });
    expect(result.covered).toBe(false);
    if (result.covered) return;
    expect(result.shortfallMonths).toBe(23);
    expect(result.term).toBe("2y");
    expect(result.termMonths).toBe(24);
  });

  // The case you called out: someone churned mid-contract, their box went to
  // the pool with a year of prepaid runway, and a new 24-month tenant
  // adopted it. That tenant needs only the REMAINING 12 months, so we buy a
  // 1y box, not another 2y.
  it("buys only the shortfall when an adopted box already funds part of the contract", () => {
    const result = assessContractCoverage({
      subscription: subFor("biennial", "2028-08-14T00:00:00Z"),
      boxPaidThrough: "2027-08-14T00:00:00Z",
      now: NOW
    });
    expect(result.covered).toBe(false);
    if (result.covered) return;
    expect(result.shortfallMonths).toBe(12);
    expect(result.term).toBe("1y");
  });

  it("reports covered when the box's runway already reaches the contract end", () => {
    expect(
      assessContractCoverage({
        subscription: subFor("annual", "2027-08-14T00:00:00Z"),
        boxPaidThrough: "2027-09-01T00:00:00Z",
        now: NOW
      })
    ).toEqual({ covered: true, reason: "runway_covers_contract" });
  });

  // Hostinger and Stripe anniversaries drift by hours. Without slack, a box
  // that covers the contract to within a few hours reads as short and we buy
  // an entire extra term to close a gap that does not exist.
  it("tolerates sub-slack drift between the Hostinger and Stripe anniversaries", () => {
    const target = new Date(NOW.getTime() + 365 * 24 * 60 * 60 * 1000);
    const justShort = new Date(target.getTime() - (COVERAGE_SLACK_MS - 60_000));
    expect(
      assessContractCoverage({
        subscription: subFor("annual", target.toISOString()),
        boxPaidThrough: justShort.toISOString(),
        now: NOW
      })
    ).toEqual({ covered: true, reason: "runway_covers_contract" });
  });

  it("does not tolerate a gap wider than the slack", () => {
    const target = new Date(NOW.getTime() + 365 * 24 * 60 * 60 * 1000);
    const shorter = new Date(target.getTime() - (COVERAGE_SLACK_MS + 10 * 24 * 60 * 60 * 1000));
    const result = assessContractCoverage({
      subscription: subFor("annual", target.toISOString()),
      boxPaidThrough: shorter.toISOString(),
      now: NOW
    });
    expect(result.covered).toBe(false);
  });

  // Unknown expiry is the common state for a freshly bought monthly box.
  // Treating it as covered would strand a contract tenant on monthly
  // hardware forever, so it reads as "not covered" and the sweep's renewal
  // window is what stops it acting prematurely.
  it("treats an unknown paid-through as not covering the contract", () => {
    const result = assessContractCoverage({
      subscription: subFor("biennial", "2028-08-14T00:00:00Z"),
      boxPaidThrough: null,
      now: NOW
    });
    expect(result.covered).toBe(false);
    if (result.covered) return;
    expect(result.shortfallMonths).toBe(24);
    expect(result.term).toBe("2y");
  });

  it("treats an unparseable paid-through the same as an unknown one", () => {
    const result = assessContractCoverage({
      subscription: subFor("annual", "2027-08-14T00:00:00Z"),
      boxPaidThrough: "garbage",
      now: NOW
    });
    expect(result.covered).toBe(false);
    if (result.covered) return;
    expect(result.term).toBe("1y");
  });

  // A box whose paid time already lapsed must be measured from NOW, not from
  // its expiry in the past, or the shortfall comes out larger than the
  // contract itself and we over-buy.
  it("measures from now when the box's paid time has already lapsed", () => {
    const result = assessContractCoverage({
      subscription: subFor("annual", "2027-02-14T00:00:00Z"),
      boxPaidThrough: "2026-01-01T00:00:00Z",
      now: NOW
    });
    expect(result.covered).toBe(false);
    if (result.covered) return;
    expect(result.shortfallMonths).toBe(6);
    expect(result.term).toBe("1y");
  });

  it("reports covered for a contract whose period end is unreadable", () => {
    expect(
      assessContractCoverage({
        subscription: subFor("annual", null),
        boxPaidThrough: null,
        now: NOW
      })
    ).toEqual({ covered: true, reason: "no_contract" });
  });
});

describe("isRefundExposureOpen", () => {
  it("is open inside the 30-day money-back window", () => {
    expect(isRefundExposureOpen(profileFor("2026-08-01T00:00:00Z"), NOW)).toBe(true);
  });

  it("is closed once the window has elapsed", () => {
    expect(isRefundExposureOpen(profileFor("2026-06-01T00:00:00Z"), NOW)).toBe(false);
  });

  // A customer who already spent their lifetime-once refund is not exposed
  // at all, so they are eligible for term hardware immediately, a day-count
  // rule would have made them wait 30 days for nothing.
  it("is closed when the lifetime refund was already used", () => {
    expect(
      isRefundExposureOpen(profileFor("2026-08-01T00:00:00Z", "2026-08-05T00:00:00Z"), NOW)
    ).toBe(false);
  });

  it("is closed for a profile that has never paid", () => {
    expect(isRefundExposureOpen(profileFor(null), NOW)).toBe(false);
  });

  // Fail toward NOT buying non-refundable hardware: with no profile we
  // cannot prove the refund right is spent.
  it("is open when there is no profile to verify against", () => {
    expect(isRefundExposureOpen(null, NOW)).toBe(true);
  });
});
