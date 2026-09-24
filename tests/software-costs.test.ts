import { describe, expect, it } from "vitest";
import {
  cursorOnDemandCents,
  emptySoftwareCosts,
  monthlyCentsFromEnv,
  parseFocusJsonl,
  parseSoftwareCostCache,
  resendCentsForEmailCount,
  softwareCacheIsFresh,
  softwareCostTotal,
  vercelCentsFromFocusCharges,
  RESEND_OVERAGE_CENTS_PER_THOUSAND
} from "@/lib/admin/software-costs";

describe("software costs", () => {
  it("reads a non-negative integer env and rejects anything else", () => {
    expect(monthlyCentsFromEnv(undefined)).toBe(0);
    expect(monthlyCentsFromEnv("  ")).toBe(0);
    expect(monthlyCentsFromEnv("1500")).toBe(1_500);
    expect(monthlyCentsFromEnv("0")).toBe(0);
    expect(monthlyCentsFromEnv("-5")).toBe(0);
    expect(monthlyCentsFromEnv("1.5")).toBe(0);
    expect(monthlyCentsFromEnv("nope")).toBe(0);
  });

  it("prices Resend as free through 3,000 emails, then per started thousand", () => {
    expect(resendCentsForEmailCount(0)).toBe(0);
    expect(resendCentsForEmailCount(-3)).toBe(0);
    expect(resendCentsForEmailCount(Number.NaN)).toBe(0);
    expect(resendCentsForEmailCount(598)).toBe(0);
    expect(resendCentsForEmailCount(3_000)).toBe(0);
    expect(resendCentsForEmailCount(3_001)).toBe(RESEND_OVERAGE_CENTS_PER_THOUSAND);
    expect(resendCentsForEmailCount(4_500, 2_000)).toBe(2_000 + RESEND_OVERAGE_CENTS_PER_THOUSAND * 2);
    expect(resendCentsForEmailCount(10, Number.NaN)).toBe(0);
  });

  it("counts Vercel overage plus the Pro seat, not included usage", () => {
    expect(
      vercelCentsFromFocusCharges([
        { ServiceName: "Pro", PricingCategory: "Committed", BilledCost: 0, EffectiveCost: 19.57 },
        { ServiceName: "Fluid", PricingCategory: "Committed", BilledCost: 0, EffectiveCost: 2.2 },
        { ServiceName: "Observability", PricingCategory: "Other", BilledCost: 0.46, EffectiveCost: 0.46 },
        { ServiceName: "Pro", PricingCategory: "Committed", BilledCost: "nope", EffectiveCost: "nope" },
        { BilledCost: 0 }
      ])
    ).toBe(Math.round((19.57 + 0.46) * 100));
  });

  it("parses FOCUS jsonl and skips blank or broken lines", () => {
    const rows = parseFocusJsonl(
      '\n{"BilledCost":1}\nnot json\n{"ServiceName":"Pro","PricingCategory":"Committed","EffectiveCost":2}\n'
    );
    expect(rows).toHaveLength(2);
    expect(vercelCentsFromFocusCharges(rows)).toBe(300);
  });

  it("sums Cursor on-demand spend and ignores included usage", () => {
    expect(cursorOnDemandCents(null)).toBe(0);
    expect(cursorOnDemandCents({})).toBe(0);
    expect(cursorOnDemandCents({ teamMemberSpend: "no" })).toBe(0);
    expect(
      cursorOnDemandCents({
        teamMemberSpend: [
          { spendCents: 250 },
          { spendCents: 0 },
          { spendCents: -4 },
          null,
          { spendCents: "x" },
          { spendCents: 75.4 }
        ]
      })
    ).toBe(325);
  });

  it("totals the four vendors", () => {
    expect(softwareCostTotal(emptySoftwareCosts())).toBe(0);
    expect(
      softwareCostTotal({ vercelCents: 1, zoomCents: 2, resendCents: 3, cursorCents: 4 })
    ).toBe(10);
  });

  it("parses a cache row and rejects a shapeless one", () => {
    expect(parseSoftwareCostCache(null)).toBeNull();
    expect(parseSoftwareCostCache({ vercelCents: 1 })).toBeNull();
    expect(
      parseSoftwareCostCache({
        syncedAt: "2026-09-23T00:00:00.000Z",
        vercelCents: 10.2,
        zoomCents: -1,
        resendCents: "x",
        cursorCents: 4,
        resendEmails: 8
      })
    ).toEqual({
      syncedAt: "2026-09-23T00:00:00.000Z",
      vercelCents: 10,
      zoomCents: 0,
      resendCents: 0,
      cursorCents: 4,
      resendEmails: 8
    });
  });

  it("treats a cache as fresh only inside the window", () => {
    const now = new Date("2026-09-23T12:00:00.000Z");
    const cache = {
      syncedAt: "2026-09-23T11:00:00.000Z",
      vercelCents: 1,
      zoomCents: 0,
      resendCents: 0,
      cursorCents: 0,
      resendEmails: 0
    };
    expect(softwareCacheIsFresh(cache, now, 2 * 60 * 60 * 1000)).toBe(true);
    expect(softwareCacheIsFresh({ ...cache, syncedAt: "nope" }, now, 1_000)).toBe(false);
    expect(softwareCacheIsFresh({ ...cache, syncedAt: "2026-09-23T13:00:00.000Z" }, now, 10_000)).toBe(
      false
    );
    expect(softwareCacheIsFresh({ ...cache, syncedAt: "2026-09-20T00:00:00.000Z" }, now, 1_000)).toBe(
      false
    );
    // Four hours old, but the UTC month has turned, so last month's bill
    // must not stand in for this month.
    expect(
      softwareCacheIsFresh(
        { ...cache, syncedAt: "2026-09-30T22:00:00.000Z" },
        new Date("2026-10-01T02:00:00.000Z"),
        6 * 60 * 60 * 1000
      )
    ).toBe(false);
  });
});
