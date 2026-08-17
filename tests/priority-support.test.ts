import { describe, it, expect } from "vitest";

import {
  PRIORITY_SUPPORT_CHECKOUT_KIND,
  PRIORITY_SUPPORT_COVERAGE_GRACE_MS,
  PRIORITY_SUPPORT_LINE_NAME,
  PRIORITY_SUPPORT_LOW_DAYS_THRESHOLD,
  PRIORITY_SUPPORT_MONTHLY_CENTS,
  PRIORITY_SUPPORT_SUBSCRIPTION_KIND,
  prioritySupportCoverageUntil,
  prioritySupportDaysLeft,
  prioritySupportPurchasableForTier,
  prioritySupportStatus,
  prioritySupportStatusIsCovered
} from "@/lib/plans/priority-support";

const NOW = new Date("2026-08-17T00:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

/** ISO for a coverage end `days` days from NOW. Negative = already past. */
function untilIn(days: number): string {
  return new Date(NOW.getTime() + days * DAY).toISOString();
}

describe("priority support catalog", () => {
  it("prices at $400/month", () => {
    expect(PRIORITY_SUPPORT_MONTHLY_CENTS).toBe(40_000);
  });

  it("pins the Stripe line name, which other code matches on as a sentinel", () => {
    expect(PRIORITY_SUPPORT_LINE_NAME).toBe("Priority support coverage");
  });

  it("pins the metadata markers the webhook gates on", () => {
    // The subscription marker is what stops a paid priority-support invoice
    // from being attributed to the tenant's MEMBERSHIP subscription.
    expect(PRIORITY_SUPPORT_SUBSCRIPTION_KIND).toBe("priority_support");
    expect(PRIORITY_SUPPORT_CHECKOUT_KIND).toBe("priority_support");
  });

  it("grants three days of slack past each paid period", () => {
    expect(PRIORITY_SUPPORT_COVERAGE_GRACE_MS).toBe(3 * DAY);
  });
});

describe("prioritySupportCoverageUntil", () => {
  it("is the period end plus the grace window", () => {
    const periodEnd = new Date("2026-09-16T12:00:00Z");
    expect(prioritySupportCoverageUntil(periodEnd).toISOString()).toBe(
      "2026-09-19T12:00:00.000Z"
    );
  });
});

describe("prioritySupportDaysLeft", () => {
  it("returns null for enterprise, whose window is permanent", () => {
    // The important case: a naive countdown renders "0 days left" for the
    // tenants with the STRONGEST entitlement, because their column is unset.
    expect(prioritySupportDaysLeft("enterprise", null, NOW)).toBeNull();
    expect(prioritySupportDaysLeft("enterprise", untilIn(-500), NOW)).toBeNull();
    expect(prioritySupportDaysLeft("enterprise", untilIn(10), NOW)).toBeNull();
  });

  it("returns null when there is no coverage at all", () => {
    expect(prioritySupportDaysLeft("standard", null, NOW)).toBeNull();
    expect(prioritySupportDaysLeft("standard", undefined, NOW)).toBeNull();
    expect(prioritySupportDaysLeft(null, null, NOW)).toBeNull();
  });

  it("returns null for an unparseable date rather than NaN days", () => {
    expect(prioritySupportDaysLeft("standard", "not-a-date", NOW)).toBeNull();
  });

  it("rounds partial days up, so 'today' never reads as zero early", () => {
    expect(prioritySupportDaysLeft("standard", untilIn(0.5), NOW)).toBe(1);
    expect(prioritySupportDaysLeft("standard", untilIn(22.1), NOW)).toBe(23);
  });

  it("counts whole days for a future window", () => {
    expect(prioritySupportDaysLeft("standard", untilIn(30), NOW)).toBe(30);
    expect(prioritySupportDaysLeft("starter", untilIn(1), NOW)).toBe(1);
  });

  it("is exactly 0 at and after the boundary, never negative", () => {
    expect(prioritySupportDaysLeft("standard", NOW.toISOString(), NOW)).toBe(0);
    expect(prioritySupportDaysLeft("standard", untilIn(-1), NOW)).toBe(0);
    expect(prioritySupportDaysLeft("standard", untilIn(-400), NOW)).toBe(0);
  });

  it("defaults its clock to now when none is injected", () => {
    const farFuture = new Date(Date.now() + 10 * DAY).toISOString();
    expect(prioritySupportDaysLeft("standard", farFuture)).toBe(10);
  });
});

describe("prioritySupportStatus", () => {
  it("is permanent for enterprise regardless of the column", () => {
    expect(prioritySupportStatus("enterprise", null, NOW)).toBe("permanent");
    expect(prioritySupportStatus("enterprise", untilIn(-5), NOW)).toBe("permanent");
  });

  it("is none when the tenant never had coverage", () => {
    expect(prioritySupportStatus("standard", null, NOW)).toBe("none");
    expect(prioritySupportStatus("standard", undefined, NOW)).toBe("none");
  });

  it("is none for an unparseable date", () => {
    expect(prioritySupportStatus("standard", "nonsense", NOW)).toBe("none");
  });

  it("is active well clear of the threshold", () => {
    expect(prioritySupportStatus("standard", untilIn(30), NOW)).toBe("active");
    expect(
      prioritySupportStatus("standard", untilIn(PRIORITY_SUPPORT_LOW_DAYS_THRESHOLD + 1), NOW)
    ).toBe("active");
  });

  it("is expiring_soon at the threshold and below", () => {
    expect(
      prioritySupportStatus("standard", untilIn(PRIORITY_SUPPORT_LOW_DAYS_THRESHOLD), NOW)
    ).toBe("expiring_soon");
    expect(prioritySupportStatus("standard", untilIn(1), NOW)).toBe("expiring_soon");
  });

  it("is expired once the window has closed", () => {
    expect(prioritySupportStatus("standard", NOW.toISOString(), NOW)).toBe("expired");
    expect(prioritySupportStatus("standard", untilIn(-1), NOW)).toBe("expired");
  });

  it("defaults its clock to now when none is injected", () => {
    expect(prioritySupportStatus("standard", new Date(Date.now() + 30 * DAY).toISOString())).toBe(
      "active"
    );
  });
});

describe("prioritySupportStatusIsCovered", () => {
  it("treats permanent, active, and expiring_soon as covered", () => {
    expect(prioritySupportStatusIsCovered("permanent")).toBe(true);
    expect(prioritySupportStatusIsCovered("active")).toBe(true);
    expect(prioritySupportStatusIsCovered("expiring_soon")).toBe(true);
  });

  it("treats expired and none as not covered", () => {
    expect(prioritySupportStatusIsCovered("expired")).toBe(false);
    expect(prioritySupportStatusIsCovered("none")).toBe(false);
  });
});

describe("prioritySupportPurchasableForTier", () => {
  it("allows starter and standard", () => {
    expect(prioritySupportPurchasableForTier("starter")).toBe(true);
    expect(prioritySupportPurchasableForTier("standard")).toBe(true);
  });

  it("refuses enterprise, who would be charged for what they already hold", () => {
    expect(prioritySupportPurchasableForTier("enterprise")).toBe(false);
  });

  it("fails closed on unknown and missing tiers", () => {
    expect(prioritySupportPurchasableForTier(null)).toBe(false);
    expect(prioritySupportPurchasableForTier(undefined)).toBe(false);
    expect(prioritySupportPurchasableForTier("platinum")).toBe(false);
  });
});
