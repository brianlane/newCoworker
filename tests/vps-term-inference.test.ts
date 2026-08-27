import { describe, it, expect } from "vitest";
import {
  HOSTINGER_TERMS,
  RUNWAY_MATCH_TOLERANCE,
  catalogMonthlyCentsForTerm,
  hostingerTermForMonths,
  inferTermFromJump,
  inferTermFromRunway,
  monthsBetween,
  planTermInference,
  sameInstant
} from "@/lib/vps/term-inference";
import type { CatalogItem } from "@/lib/hostinger/client";

const NOW = new Date("2026-08-27T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const at = (days: number) => new Date(NOW.getTime() + days * DAY).toISOString();

/** The live KVM 1 catalog item, read from Hostinger on 2026-08-27. */
const CATALOG: CatalogItem[] = [
  {
    id: "hostingercom-vps-kvm1",
    name: "KVM 1",
    category: "VPS",
    prices: [
      {
        id: "hostingercom-vps-kvm1-usd-1m",
        name: "KVM 1 (billed every month)",
        currency: "USD",
        price: 1949,
        first_period_price: 999,
        period: 1,
        period_unit: "month"
      },
      {
        id: "hostingercom-vps-kvm1-usd-1y",
        name: "KVM 1 (billed every year)",
        currency: "USD",
        price: 15588,
        first_period_price: 8388,
        period: 1,
        period_unit: "year"
      },
      {
        id: "hostingercom-vps-kvm1-usd-2y",
        name: "KVM 1 (billed every 2 years)",
        currency: "USD",
        price: 28776,
        first_period_price: 15576,
        period: 2,
        period_unit: "year"
      }
    ]
  } as CatalogItem
];

describe("hostingerTermForMonths", () => {
  it("maps the terms Hostinger sells", () => {
    expect(hostingerTermForMonths(1)).toBe("1m");
    expect(hostingerTermForMonths(12)).toBe("1y");
    expect(hostingerTermForMonths(24)).toBe("2y");
  });

  it("refuses a term that is not on the price list", () => {
    // 6 months is a plausible-sounding number that cannot be priced, so it
    // must not resolve to the nearest thing.
    expect(hostingerTermForMonths(6)).toBeNull();
    expect(hostingerTermForMonths(0)).toBeNull();
  });

  it("covers every term in the exported list", () => {
    for (const term of HOSTINGER_TERMS) expect(hostingerTermForMonths).toBeTruthy();
    expect(HOSTINGER_TERMS).toHaveLength(3);
  });
});

describe("monthsBetween", () => {
  it("reads a one-year gap as 12 months despite uneven calendar months", () => {
    expect(monthsBetween("2026-09-05T04:23:54Z", "2027-09-05T04:23:54Z")).toBe(12);
  });

  it("reads a two-year gap as 24", () => {
    expect(monthsBetween("2026-07-14T00:00:00Z", "2028-07-14T00:00:00Z")).toBe(24);
  });

  it("reads a normal monthly renewal as 1", () => {
    expect(monthsBetween("2026-08-05T00:00:00Z", "2026-09-05T00:00:00Z")).toBe(1);
  });

  it("is null when a date is missing, unparseable, or not moving forward", () => {
    expect(monthsBetween(null, "2027-01-01T00:00:00Z")).toBeNull();
    expect(monthsBetween("2027-01-01T00:00:00Z", undefined)).toBeNull();
    expect(monthsBetween("nope", "2027-01-01T00:00:00Z")).toBeNull();
    expect(monthsBetween("2027-01-01T00:00:00Z", "nope")).toBeNull();
    expect(monthsBetween("2027-01-01T00:00:00Z", "2026-01-01T00:00:00Z")).toBeNull();
    expect(monthsBetween("2027-01-01T00:00:00Z", "2027-01-01T00:00:00Z")).toBeNull();
  });
});

describe("inferTermFromJump", () => {
  it("reads the HQ term change: the date moved a year on a declared 1-month cycle", () => {
    expect(
      inferTermFromJump("2026-09-05T04:23:54Z", "2027-09-05T04:23:54Z", 1)
    ).toBe(12);
  });

  it("ignores an ordinary monthly renewal", () => {
    // The date moving one declared cycle is a renewal, not a term purchase.
    // Reporting it as a 1-month "term" would overwrite a real stored term.
    expect(inferTermFromJump("2026-08-05T00:00:00Z", "2026-09-05T00:00:00Z", 1)).toBeNull();
  });

  it("ignores a two-year box renewing on its own two-year cycle", () => {
    expect(
      inferTermFromJump("2026-07-14T00:00:00Z", "2028-07-14T00:00:00Z", 24)
    ).toBeNull();
  });

  it("refuses a jump that is not a term Hostinger sells", () => {
    // Seven months means something happened that we do not model. Pricing it
    // would require inventing a catalog entry.
    expect(inferTermFromJump("2026-09-05T00:00:00Z", "2027-04-05T00:00:00Z", 1)).toBeNull();
  });

  it("treats an unknown declared cycle as monthly rather than skipping", () => {
    expect(inferTermFromJump("2026-09-05T00:00:00Z", "2027-09-05T00:00:00Z", null)).toBe(12);
  });

  it("is null without a previous observation", () => {
    expect(inferTermFromJump(null, "2027-09-05T00:00:00Z", 1)).toBeNull();
  });
});

describe("inferTermFromRunway", () => {
  it("bootstraps the HQ box: 374 days of runway is the one-year term", () => {
    expect(inferTermFromRunway(at(374), NOW)).toBe(12);
  });

  it("matches a two-year term", () => {
    expect(inferTermFromRunway(at(717), NOW)).toBe(24);
  });

  it("matches a fresh monthly box", () => {
    expect(inferTermFromRunway(at(30), NOW)).toBe(1);
  });

  it("refuses a box sitting mid-term, where runway names nothing", () => {
    // Seven months into a year term. This is the case that makes re-deriving
    // the bootstrap on every sync unsafe, so it must return null loudly
    // rather than snap to the nearest term.
    expect(inferTermFromRunway(at(190), NOW)).toBeNull();
  });

  it("refuses an expired or missing date", () => {
    expect(inferTermFromRunway(at(-5), NOW)).toBeNull();
    expect(inferTermFromRunway(null, NOW)).toBeNull();
    expect(inferTermFromRunway("nope", NOW)).toBeNull();
  });

  it("honours the tolerance at its edges", () => {
    const yearDays = 12 * 30.44;
    const slack = yearDays * RUNWAY_MATCH_TOLERANCE;
    expect(inferTermFromRunway(at(yearDays + slack - 1), NOW)).toBe(12);
    expect(inferTermFromRunway(at(yearDays + slack + 2), NOW)).toBeNull();
  });

  it("defaults now to the wall clock", () => {
    const oneYearOut = new Date(Date.now() + 366 * DAY).toISOString();
    expect(inferTermFromRunway(oneYearOut)).toBe(12);
  });
});

describe("catalogMonthlyCentsForTerm", () => {
  it("prices the HQ year term at the real $12.99, not the stale $19.49", () => {
    // 15588 / 12. This is the number the whole feature exists to recover.
    expect(catalogMonthlyCentsForTerm(CATALOG, "kvm1", 12)).toBe(1299);
  });

  it("prices a monthly and a two-year term", () => {
    expect(catalogMonthlyCentsForTerm(CATALOG, "kvm1", 1)).toBe(1949);
    expect(catalogMonthlyCentsForTerm(CATALOG, "kvm1", 24)).toBe(1199);
  });

  it("uses the RENEWAL price, never the promotional first period", () => {
    // first_period_price for the year is 8388 ($6.99/mo). A term already
    // running has spent its promo, so quoting it would understate cost.
    expect(catalogMonthlyCentsForTerm(CATALOG, "kvm1", 12)).not.toBe(699);
  });

  it("is null for a term or size the catalog does not carry", () => {
    expect(catalogMonthlyCentsForTerm(CATALOG, "kvm1", 6)).toBeNull();
    expect(catalogMonthlyCentsForTerm(CATALOG, "kvm8", 12)).toBeNull();
    expect(catalogMonthlyCentsForTerm([], "kvm1", 12)).toBeNull();
  });

  it("is null when the catalog reports a period it cannot express", () => {
    const odd: CatalogItem[] = [
      {
        ...CATALOG[0],
        prices: [
          {
            id: "hostingercom-vps-kvm1-usd-1y",
            name: "odd",
            currency: "USD",
            price: 15588,
            period: 1,
            period_unit: "fortnight"
          }
        ]
      } as CatalogItem
    ];
    expect(catalogMonthlyCentsForTerm(odd, "kvm1", 12)).toBeNull();
  });

  it("is null on a negative price rather than publishing it", () => {
    const bad: CatalogItem[] = [
      {
        ...CATALOG[0],
        prices: [
          {
            id: "hostingercom-vps-kvm1-usd-1y",
            name: "bad",
            currency: "USD",
            price: -1,
            period: 1,
            period_unit: "year"
          }
        ]
      } as CatalogItem
    ];
    expect(catalogMonthlyCentsForTerm(bad, "kvm1", 12)).toBeNull();
  });
});

describe("sameInstant", () => {
  it("matches Hostinger's Z spelling against PostgREST's offset spelling", () => {
    // The exact pair that occurs in production: Hostinger returns Z, the
    // timestamptz column round-trips to +00:00.
    expect(sameInstant("2027-09-05T04:23:54Z", "2027-09-05T04:23:54+00:00")).toBe(true);
  });

  it("matches across an equivalent non-UTC offset", () => {
    expect(sameInstant("2027-09-05T04:23:54Z", "2027-09-05T06:23:54+02:00")).toBe(true);
  });

  it("separates genuinely different instants", () => {
    expect(sameInstant("2026-09-05T04:23:54Z", "2027-09-05T04:23:54Z")).toBe(false);
  });

  it("is false when either side is missing or unparseable", () => {
    expect(sameInstant(null, "2027-09-05T04:23:54Z")).toBe(false);
    expect(sameInstant("2027-09-05T04:23:54Z", undefined)).toBe(false);
    expect(sameInstant("nope", "2027-09-05T04:23:54Z")).toBe(false);
    expect(sameInstant("2027-09-05T04:23:54Z", "nope")).toBe(false);
  });
});

describe("planTermInference", () => {
  const hq = (over: Record<string, unknown> = {}) => ({
    subscriptionId: "16BcBrVOTACBI8WdU",
    size: "kvm1" as const,
    declaredCycleMonths: 1,
    nextBillingAt: "2027-09-05T04:23:54Z",
    cycleContradicted: true,
    ...over
  });

  const plan = (subs: ReturnType<typeof hq>[], stored: Parameters<typeof planTermInference>[0]["stored"] = []) =>
    planTermInference({ subscriptions: subs, stored, catalog: CATALOG, now: NOW });

  it("bootstraps an unseen contradicted box from its runway and prices it", () => {
    // First sync after deploy: no stored row, HQ's runway names the year term.
    const result = plan([hq()]);
    expect(result.monthlyBySubscription.get("16BcBrVOTACBI8WdU")).toBe(1299);
    expect(result.updates[0]).toMatchObject({
      term_months: 12,
      monthly_cents: 1299,
      source: "runway_match",
      observed_next_billing_at: "2027-09-05T04:23:54Z"
    });
  });

  it("prefers a measured jump over everything else", () => {
    const result = plan(
      [hq()],
      [
        {
          subscription_id: "16BcBrVOTACBI8WdU",
          observed_next_billing_at: "2026-09-05T04:23:54Z",
          term_months: null,
          monthly_cents: null,
          source: null,
          inferred_at: null
        }
      ]
    );
    expect(result.updates[0]).toMatchObject({ term_months: 12, source: "jump" });
    expect(result.monthlyBySubscription.get("16BcBrVOTACBI8WdU")).toBe(1299);
  });

  it("HOLDS a stored term instead of re-deriving it from shrinking runway", () => {
    // This is the case that would silently rot. Seven months into the term
    // the runway matches nothing, so a re-derivation would drop the price
    // back to withheld. The stored answer must survive.
    const result = planTermInference({
      subscriptions: [hq({ nextBillingAt: at(190) })],
      stored: [
        {
          subscription_id: "16BcBrVOTACBI8WdU",
          observed_next_billing_at: at(190),
          term_months: 12,
          monthly_cents: 1299,
          source: "runway_match",
          inferred_at: "2026-08-27T12:00:00.000Z"
        }
      ],
      catalog: CATALOG,
      now: NOW
    });
    expect(result.updates[0]).toMatchObject({
      term_months: 12,
      source: "runway_match",
      inferred_at: "2026-08-27T12:00:00.000Z"
    });
    expect(result.monthlyBySubscription.get("16BcBrVOTACBI8WdU")).toBe(1299);
  });

  it("HOLDS the term when the stored date round-trips through Postgres", () => {
    // Regression: the stored value comes back from a timestamptz column as
    // "+00:00" while Hostinger says "Z". Comparing spellings made every sync
    // look like a move, which cleared the term; and because the bootstrap
    // only runs when no row exists, the recovered price was gone for good
    // from the second sync onward.
    const result = planTermInference({
      subscriptions: [hq({ nextBillingAt: "2027-09-05T04:23:54Z" })],
      stored: [
        {
          subscription_id: "16BcBrVOTACBI8WdU",
          observed_next_billing_at: "2027-09-05T04:23:54+00:00",
          term_months: 12,
          monthly_cents: 1299,
          source: "runway_match",
          inferred_at: "2026-08-27T12:00:00.000Z"
        }
      ],
      catalog: CATALOG,
      now: NOW
    });
    expect(result.updates[0]).toMatchObject({ term_months: 12, source: "runway_match" });
    expect(result.monthlyBySubscription.get("16BcBrVOTACBI8WdU")).toBe(1299);
  });

  it("clears a stored term when the billing date disappears entirely", () => {
    // A vanished date is a change, not a match, so the old term must go.
    const result = planTermInference({
      subscriptions: [hq({ nextBillingAt: null })],
      stored: [
        {
          subscription_id: "16BcBrVOTACBI8WdU",
          observed_next_billing_at: "2027-09-05T04:23:54+00:00",
          term_months: 12,
          monthly_cents: 1299,
          source: "runway_match",
          inferred_at: "2026-08-27T12:00:00.000Z"
        }
      ],
      catalog: CATALOG,
      now: NOW
    });
    expect(result.updates[0]).toMatchObject({ term_months: null, monthly_cents: null });
  });

  it("clears a stored term once the box rolls over to a new period", () => {
    // The date moved but not by a whole extra term, so the old term has been
    // consumed. Keeping it would price the NEXT period from the LAST one.
    const result = planTermInference({
      subscriptions: [hq({ nextBillingAt: "2027-10-05T04:23:54Z" })],
      stored: [
        {
          subscription_id: "16BcBrVOTACBI8WdU",
          observed_next_billing_at: "2027-09-05T04:23:54Z",
          term_months: 12,
          monthly_cents: 1299,
          source: "runway_match",
          inferred_at: "2026-08-27T12:00:00.000Z"
        }
      ],
      catalog: CATALOG,
      now: NOW
    });
    expect(result.updates[0]).toMatchObject({ term_months: null, source: null, monthly_cents: null });
    expect(result.monthlyBySubscription.has("16BcBrVOTACBI8WdU")).toBe(false);
  });

  it("records the billing date for a HEALTHY box without publishing a price", () => {
    // The observation is the whole point: it is what makes a FUTURE term
    // change on this box detectable. But a healthy box's own renewal price
    // beats the catalog, so nothing is published for it.
    const result = plan([
      hq({ subscriptionId: "healthy", nextBillingAt: at(4), cycleContradicted: false })
    ]);
    expect(result.updates[0].observed_next_billing_at).toBe(at(4));
    expect(result.monthlyBySubscription.has("healthy")).toBe(false);
  });

  it("does not bootstrap a healthy box even when its runway names a term", () => {
    const result = plan([hq({ subscriptionId: "fresh-year", cycleContradicted: false })]);
    expect(result.updates[0].term_months).toBeNull();
    expect(result.monthlyBySubscription.has("fresh-year")).toBe(false);
  });

  it("withholds rather than guessing when the runway names no term", () => {
    const result = plan([hq({ nextBillingAt: at(190) })]);
    expect(result.updates[0]).toMatchObject({ term_months: null, monthly_cents: null });
    expect(result.monthlyBySubscription.size).toBe(0);
  });

  it("still records the observation when the size is unreadable", () => {
    // No size means no catalog lookup, but the billing date must still be
    // stored or this box can never be diagnosed later.
    const result = plan([hq({ size: null })]);
    expect(result.updates[0].observed_next_billing_at).toBe("2027-09-05T04:23:54Z");
    expect(result.updates[0].monthly_cents).toBeNull();
    expect(result.monthlyBySubscription.size).toBe(0);
  });

  it("withholds when the term is known but the catalog cannot price it", () => {
    const result = planTermInference({
      subscriptions: [hq({ size: "kvm8" })],
      stored: [],
      catalog: CATALOG,
      now: NOW
    });
    expect(result.updates[0].term_months).toBe(12);
    expect(result.updates[0].monthly_cents).toBeNull();
    expect(result.monthlyBySubscription.size).toBe(0);
  });

  it("handles the whole live fleet in one pass", () => {
    const result = plan([
      hq(),
      hq({ subscriptionId: "kvm2-a", size: "kvm2", nextBillingAt: at(2), cycleContradicted: false }),
      hq({ subscriptionId: "kvm2-b", size: "kvm2", nextBillingAt: at(3), cycleContradicted: false }),
      hq({
        subscriptionId: "kvm2-2y",
        size: "kvm2",
        declaredCycleMonths: 24,
        nextBillingAt: at(687),
        cycleContradicted: false
      })
    ]);
    expect(result.updates).toHaveLength(4);
    // Only the contradicted box gets a published price.
    expect([...result.monthlyBySubscription.keys()]).toEqual(["16BcBrVOTACBI8WdU"]);
  });
});
