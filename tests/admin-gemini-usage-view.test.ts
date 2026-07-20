import { describe, it, expect } from "vitest";
import {
  GEMINI_RANGE_KEYS,
  buildGeminiDailySeries,
  buildGeminiReconciliation,
  buildGeminiTenantBreakdown,
  geminiMicrosByBusinessInWindow,
  geminiRangeWindow,
  resolveGeminiRange
} from "@/lib/admin/gemini-usage-view";
import type { GeminiBilledDailyRow, GeminiSpendDailyRow } from "@/lib/db/gemini-spend";

const NOW = new Date("2026-07-19T18:30:00.000Z");

function spendRow(overrides: Partial<GeminiSpendDailyRow>): GeminiSpendDailyRow {
  return {
    day: "2026-07-19",
    business_id: "biz-1",
    surface: "vps_rowboat",
    model: "gemini-2.5-flash-lite",
    pricing_source: "exact",
    call_count: 1,
    prompt_tokens: 1000,
    output_tokens: 100,
    cost_micros: 100,
    ...overrides
  };
}

function billedRow(overrides: Partial<GeminiBilledDailyRow>): GeminiBilledDailyRow {
  return {
    id: 1,
    day: "2026-07-18",
    gcp_project_id: "prod-project",
    cost_micros: 1_000,
    synced_at: "2026-07-19T11:10:00Z",
    ...overrides
  };
}

describe("resolveGeminiRange", () => {
  it("accepts every listed key and falls back to 7d", () => {
    for (const key of GEMINI_RANGE_KEYS) expect(resolveGeminiRange(key)).toBe(key);
    expect(resolveGeminiRange(undefined)).toBe("7d");
    expect(resolveGeminiRange("bogus")).toBe("7d");
  });
});

describe("geminiRangeWindow", () => {
  it("builds UTC windows ending tomorrow for rolling ranges", () => {
    expect(geminiRangeWindow("today", NOW)).toEqual({
      range: "today",
      startYmd: "2026-07-19",
      endYmdExclusive: "2026-07-20"
    });
    expect(geminiRangeWindow("7d", NOW)).toEqual({
      range: "7d",
      startYmd: "2026-07-13",
      endYmdExclusive: "2026-07-20"
    });
    expect(geminiRangeWindow("90d", NOW)).toEqual({
      range: "90d",
      startYmd: "2026-04-21",
      endYmdExclusive: "2026-07-20"
    });
  });

  it("anchors the month range at the first of the current UTC month", () => {
    expect(geminiRangeWindow("month", NOW)).toEqual({
      range: "month",
      startYmd: "2026-07-01",
      endYmdExclusive: "2026-07-20"
    });
  });
});

describe("buildGeminiDailySeries", () => {
  const window = geminiRangeWindow("7d", NOW);

  it("enumerates every day (zeros included) and stacks per-tenant segments largest first", () => {
    const series = buildGeminiDailySeries(
      [
        spendRow({ day: "2026-07-18", business_id: "biz-1", cost_micros: 100 }),
        spendRow({ day: "2026-07-18", business_id: "biz-2", cost_micros: 400 }),
        // Same tenant twice in a day (different surfaces) merges into one segment.
        spendRow({ day: "2026-07-18", business_id: "biz-1", surface: "webchat", cost_micros: 50 }),
        spendRow({ day: "2026-07-19", business_id: "biz-1", cost_micros: 10 }),
        // Outside the window → ignored.
        spendRow({ day: "2026-07-01", cost_micros: 999_999 })
      ],
      window
    );
    expect(series.points).toHaveLength(7);
    expect(series.points[0]).toEqual({ day: "2026-07-13", costMicros: 0, segments: [] });
    const jul18 = series.points.find((p) => p.day === "2026-07-18");
    expect(jul18?.segments).toEqual([
      { businessId: "biz-2", costMicros: 400 },
      { businessId: "biz-1", costMicros: 150 }
    ]);
    expect(series.maxMicros).toBe(550);
    expect(series.totalMicros).toBe(560);
  });
});

describe("buildGeminiTenantBreakdown", () => {
  const window = geminiRangeWindow("7d", NOW);

  it("rolls up per tenant with surface×model lines, estimate share, sorted by spend", () => {
    const tenants = buildGeminiTenantBreakdown(
      [
        spendRow({ business_id: "biz-1", cost_micros: 100, call_count: 2 }),
        spendRow({
          business_id: "biz-1",
          pricing_source: "estimate",
          cost_micros: 60,
          call_count: 1,
          prompt_tokens: 500,
          output_tokens: 50
        }),
        spendRow({
          business_id: "biz-1",
          surface: "aiflow_extract",
          model: "gemini-3.5-flash",
          cost_micros: 40
        }),
        spendRow({ business_id: "biz-2", cost_micros: 900 }),
        spendRow({ day: "2026-06-01", business_id: "biz-3", cost_micros: 1 })
      ],
      window
    );
    expect(tenants.map((t) => t.businessId)).toEqual(["biz-2", "biz-1"]);
    const biz1 = tenants[1];
    expect(biz1.costMicros).toBe(200);
    expect(biz1.callCount).toBe(4);
    expect(biz1.estimateMicros).toBe(60);
    // Same surface+model merges (exact + estimate rows), lines sorted by cost.
    expect(biz1.lines).toEqual([
      {
        surface: "vps_rowboat",
        model: "gemini-2.5-flash-lite",
        callCount: 3,
        promptTokens: 1500,
        outputTokens: 150,
        costMicros: 160,
        estimateMicros: 60
      },
      {
        surface: "aiflow_extract",
        model: "gemini-3.5-flash",
        callCount: 1,
        promptTokens: 1000,
        outputTokens: 100,
        costMicros: 40,
        estimateMicros: 0
      }
    ]);
  });

  it("returns an empty list for no in-window rows", () => {
    expect(buildGeminiTenantBreakdown([spendRow({ day: "2020-01-01" })], window)).toEqual([]);
  });
});

describe("geminiMicrosByBusinessInWindow", () => {
  it("sums per business inside [start, end)", () => {
    const byBusiness = geminiMicrosByBusinessInWindow(
      [
        spendRow({ day: "2026-07-01", cost_micros: 5 }),
        spendRow({ day: "2026-07-19", cost_micros: 7 }),
        spendRow({ day: "2026-07-20", cost_micros: 100 }),
        spendRow({ day: "2026-06-30", cost_micros: 100 }),
        spendRow({ day: "2026-07-10", business_id: "biz-2", cost_micros: 3 })
      ],
      { startYmd: "2026-07-01", endYmdExclusive: "2026-07-20" }
    );
    expect(byBusiness.get("biz-1")).toBe(12);
    expect(byBusiness.get("biz-2")).toBe(3);
  });
});

describe("buildGeminiReconciliation", () => {
  const window = geminiRangeWindow("7d", NOW);

  it("clips the metered side to days billed data covers and splits by project", () => {
    const result = buildGeminiReconciliation(
      [
        spendRow({ day: "2026-07-17", cost_micros: 400 }),
        spendRow({ day: "2026-07-18", cost_micros: 500 }),
        // After the latest billed day → excluded from the comparable total.
        spendRow({ day: "2026-07-19", cost_micros: 999 }),
        // Before the window → excluded entirely.
        spendRow({ day: "2026-07-01", cost_micros: 999 })
      ],
      [
        billedRow({ day: "2026-07-17", gcp_project_id: "prod-project", cost_micros: 600 }),
        billedRow({ day: "2026-07-18", gcp_project_id: "prod-project", cost_micros: 500 }),
        billedRow({ day: "2026-07-18", gcp_project_id: "internal-project", cost_micros: 300 }),
        // Outside the window → ignored.
        billedRow({ day: "2026-07-01", cost_micros: 999_999 })
      ],
      window
    );
    expect(result.latestBilledDay).toBe("2026-07-18");
    expect(result.meteredComparableMicros).toBe(900);
    expect(result.billedTotalMicros).toBe(1400);
    expect(result.byProject).toEqual([
      { projectId: "prod-project", costMicros: 1100 },
      { projectId: "internal-project", costMicros: 300 }
    ]);
    expect(result.deltaMicros).toBe(500);
    expect(result.deltaPct).toBe(35.7);
  });

  it("reports no billed data as null latest day and null delta pct", () => {
    const result = buildGeminiReconciliation([spendRow({})], [], window);
    expect(result.latestBilledDay).toBeNull();
    expect(result.meteredComparableMicros).toBe(0);
    expect(result.billedTotalMicros).toBe(0);
    expect(result.deltaPct).toBeNull();
  });
});
