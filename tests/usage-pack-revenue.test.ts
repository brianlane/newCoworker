import { describe, expect, it } from "vitest";
import {
  isRecurringMembershipGrant,
  priceOneTimeGrant,
  sumUsagePackRevenue,
  usagePackGrantFromRow
} from "@/lib/admin/usage-pack-revenue";

const PACKS = [
  { unit: 1_800, priceCents: 1_399 },
  { unit: 7_200, priceCents: 4_800 }
];

describe("usage pack revenue", () => {
  it("treats an invoice-stamped grant as recurring membership revenue", () => {
    expect(isRecurringMembershipGrant("inv_123:voice:min_30")).toBe(true);
    expect(isRecurringMembershipGrant("pi_abc")).toBe(false);
    expect(isRecurringMembershipGrant(null)).toBe(false);
  });

  it("prices a one-time grant on the largest pack that divides it", () => {
    expect(
      priceOneTimeGrant(
        { businessId: "b", sourceId: "pi_1", voided: false, units: 7_200 },
        PACKS
      )
    ).toBe(4_800);
    expect(
      priceOneTimeGrant(
        { businessId: "b", sourceId: "cs_1", voided: false, units: 1_800 },
        PACKS
      )
    ).toBe(1_399);
  });

  it("drops voided grants, membership grants, and sizes no pack divides", () => {
    expect(
      priceOneTimeGrant({ businessId: "b", sourceId: "pi_1", voided: true, units: 1_800 }, PACKS)
    ).toBe(0);
    expect(
      priceOneTimeGrant(
        { businessId: "b", sourceId: "inv_1:voice:min_30", voided: false, units: 1_800 },
        PACKS
      )
    ).toBe(0);
    expect(
      priceOneTimeGrant({ businessId: "b", sourceId: "pi_1", voided: false, units: 0 }, PACKS)
    ).toBe(0);
    expect(
      priceOneTimeGrant({ businessId: "b", sourceId: "pi_1", voided: false, units: 100 }, PACKS)
    ).toBe(0);
    expect(
      priceOneTimeGrant(
        { businessId: "b", sourceId: "pi_1", voided: false, units: 1_800 },
        [{ unit: 0, priceCents: 100 }, { unit: 1_800, priceCents: 0 }]
      )
    ).toBe(0);
  });

  it("sums per business and skips zero rows", () => {
    const result = sumUsagePackRevenue(
      [
        { businessId: "amy", sourceId: "pi_1", voided: false, units: 1_800 },
        { businessId: "amy", sourceId: "pi_2", voided: false, units: 1_800 },
        { businessId: "amy", sourceId: "inv_9:voice:min_30", voided: false, units: 1_800 },
        { businessId: "other", sourceId: null, voided: false, units: 50 }
      ],
      PACKS
    );
    expect(result.totalCents).toBe(2_798);
    expect(result.byBusiness.get("amy")).toBe(2_798);
    expect(result.byBusiness.has("other")).toBe(false);
  });

  it("reads a grant row", () => {
    expect(
      usagePackGrantFromRow({
        business_id: "amy",
        stripe_checkout_session_id: "pi_1",
        voided_at: null,
        units: 1_800
      })
    ).toEqual({ businessId: "amy", sourceId: "pi_1", voided: false, units: 1_800 });
    expect(
      usagePackGrantFromRow({
        business_id: "amy",
        stripe_checkout_session_id: null,
        voided_at: "2026-09-01T00:00:00Z",
        units: 1_800
      }).voided
    ).toBe(true);
  });
});
