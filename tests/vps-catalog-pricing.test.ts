import { describe, expect, it } from "vitest";

import {
  billingSubCentsPerMonth,
  catalogFirstPeriodCents,
  catalogFirstPeriodCentsPerMonth,
  catalogPriceMonths,
  findCatalogPrice,
  monthlySavingsRatio
} from "@/lib/vps/catalog-pricing";
import type { CatalogItem, CatalogPrice } from "@/lib/hostinger/client";

function price(overrides: Partial<CatalogPrice> = {}): CatalogPrice {
  return {
    id: "hostingercom-vps-kvm2-usd-1m",
    name: "KVM2 monthly",
    currency: "USD",
    price: 2449,
    period: 1,
    period_unit: "month",
    ...overrides
  };
}

const catalog: CatalogItem[] = [
  {
    id: "vps-kvm2",
    name: "KVM 2",
    category: "VPS",
    prices: [
      price(),
      price({
        id: "hostingercom-vps-kvm2-usd-2y",
        name: "KVM2 2y",
        price: 47976,
        first_period_price: 21576,
        period: 2,
        period_unit: "year"
      })
    ]
  }
];

describe("catalogPriceMonths", () => {
  it("reads a monthly period", () => {
    expect(catalogPriceMonths({ period: 1, period_unit: "month" })).toBe(1);
  });

  it("converts a yearly period into months", () => {
    expect(catalogPriceMonths({ period: 2, period_unit: "year" })).toBe(24);
    expect(catalogPriceMonths({ period: 1, period_unit: "year" })).toBe(12);
  });

  // Guessing a period we do not recognise would mis-price a real purchase,
  // so an unknown unit is refused and surfaces as "no comparable price".
  it("refuses an unrecognised unit or a non-positive period", () => {
    expect(catalogPriceMonths({ period: 1, period_unit: "fortnight" })).toBeNull();
    expect(catalogPriceMonths({ period: 0, period_unit: "month" })).toBeNull();
    expect(catalogPriceMonths({ period: -3, period_unit: "month" })).toBeNull();
    expect(catalogPriceMonths({ period: Number.NaN, period_unit: "month" })).toBeNull();
  });
});

describe("catalogFirstPeriodCents", () => {
  it("prefers the promotional first-period price", () => {
    expect(catalogFirstPeriodCents({ price: 47976, first_period_price: 21576 })).toBe(21576);
  });

  it("falls back to the standard price when there is no promo", () => {
    expect(catalogFirstPeriodCents({ price: 2449 })).toBe(2449);
  });
});

describe("catalogFirstPeriodCentsPerMonth", () => {
  // This is the whole reason the module exists. Compared as whole periods, a
  // $215.76 two-year first period looks ~9x more expensive than a $24.49
  // monthly renewal, and every contract upgrade would be skipped as
  // uneconomic while the sweep reported itself healthy.
  it("spreads a two-year first period across 24 months", () => {
    const twoYear = price({
      period: 2,
      period_unit: "year",
      price: 47976,
      first_period_price: 21576
    });
    expect(catalogFirstPeriodCentsPerMonth(twoYear)).toBe(899);
  });

  it("leaves a monthly price alone", () => {
    expect(catalogFirstPeriodCentsPerMonth(price())).toBe(2449);
  });

  it("returns null when the period cannot be read", () => {
    expect(catalogFirstPeriodCentsPerMonth(price({ period_unit: "decade" }))).toBeNull();
  });
});

describe("findCatalogPrice", () => {
  it("finds the price row for a size at a term", () => {
    expect(findCatalogPrice(catalog, "kvm2", "2y")?.first_period_price).toBe(21576);
  });

  it("returns null when the SKU is absent (renamed or retired)", () => {
    expect(findCatalogPrice(catalog, "kvm8", "2y")).toBeNull();
    expect(findCatalogPrice([], "kvm2", "1m")).toBeNull();
  });
});

describe("billingSubCentsPerMonth", () => {
  it("spreads a renewal across its own cycle length", () => {
    expect(billingSubCentsPerMonth({ renewal_price: 47976 }, 24)).toBe(1999);
  });

  it("prefers renewal_price over total_price", () => {
    expect(billingSubCentsPerMonth({ renewal_price: 2449, total_price: 899 }, 1)).toBe(2449);
  });

  it("falls back to total_price when there is no renewal price", () => {
    expect(billingSubCentsPerMonth({ total_price: 2449 }, 1)).toBe(2449);
  });

  // An unknown cycle must not be treated as monthly: that would read a
  // two-year renewal as a monthly rate and make term hardware look like a
  // catastrophic saving.
  it("returns null rather than assuming a cycle length", () => {
    expect(billingSubCentsPerMonth({ renewal_price: 47976 }, null)).toBeNull();
    expect(billingSubCentsPerMonth({ renewal_price: 47976 }, 0)).toBeNull();
  });

  it("returns null when Hostinger reports no usable price", () => {
    expect(billingSubCentsPerMonth({}, 1)).toBeNull();
    expect(billingSubCentsPerMonth({ renewal_price: 0 }, 1)).toBeNull();
    expect(billingSubCentsPerMonth({ renewal_price: Number.NaN }, 1)).toBeNull();
  });
});

describe("monthlySavingsRatio", () => {
  // The real fleet numbers: kvm2 monthly renews at $24.49/mo, a fresh 2y box
  // costs $8.99/mo for its first period.
  it("reports the saving of a term box against a monthly one", () => {
    expect(monthlySavingsRatio(2449, 899)).toBeCloseTo(0.6329, 4);
  });

  it("goes negative when the candidate costs more", () => {
    expect(monthlySavingsRatio(899, 2449)).toBeLessThan(0);
  });

  // An unknown baseline must never clear a positive threshold, or we would
  // buy hardware on the strength of a price we could not read.
  it("reports no saving when either side is unknown", () => {
    expect(monthlySavingsRatio(null, 899)).toBe(0);
    expect(monthlySavingsRatio(2449, null)).toBe(0);
    expect(monthlySavingsRatio(0, 899)).toBe(0);
  });
});
