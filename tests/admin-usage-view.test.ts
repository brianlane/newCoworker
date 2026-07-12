import { describe, it, expect } from "vitest";
import {
  computeUtilizationPct,
  listRecentMonths,
  monthWindow,
  resolveSelectedMonth,
  telnyxMicrosByBusinessInWindow
} from "@/lib/admin/usage-view";
import { TIER_LIMITS } from "@/lib/plans/limits";
import {
  DEFAULT_CHAT_SPEND_CAP_MICROS,
  STARTER_CHAT_SPEND_CAP_MICROS
} from "@/lib/db/chat-usage";
import type { TelnyxCostDailyRow } from "@/lib/db/platform-costs";

const NOW = new Date("2026-07-12T18:00:00.000Z");

describe("listRecentMonths", () => {
  it("returns the current month and the ones before it, newest first", () => {
    expect(listRecentMonths(NOW, 3)).toEqual(["2026-07", "2026-06", "2026-05"]);
  });

  it("crosses year boundaries", () => {
    expect(listRecentMonths(new Date("2026-01-15T00:00:00.000Z"), 2)).toEqual([
      "2026-01",
      "2025-12"
    ]);
  });
});

describe("monthWindow", () => {
  it("returns [first of month, first of next month)", () => {
    expect(monthWindow("2026-07")).toEqual({
      ym: "2026-07",
      startYmd: "2026-07-01",
      endYmdExclusive: "2026-08-01"
    });
    expect(monthWindow("2026-12")).toEqual({
      ym: "2026-12",
      startYmd: "2026-12-01",
      endYmdExclusive: "2027-01-01"
    });
  });
});

describe("resolveSelectedMonth", () => {
  const months = ["2026-07", "2026-06", "2026-05"];

  it("accepts a listed month and falls back to current otherwise", () => {
    expect(resolveSelectedMonth("2026-06", months)).toBe("2026-06");
    expect(resolveSelectedMonth("2020-01", months)).toBe("2026-07");
    expect(resolveSelectedMonth(undefined, months)).toBe("2026-07");
  });
});

describe("computeUtilizationPct", () => {
  it("blends voice, SMS, and AI ratios for a standard tenant (Amy's ~10% profile)", () => {
    const voiceCapMin = TIER_LIMITS.standard.voiceIncludedSecondsPerStripePeriod / 60;
    const smsCap = TIER_LIMITS.standard.smsPerMonth;
    const pct = computeUtilizationPct({
      tier: "standard",
      voiceMinutes: voiceCapMin * 0.1,
      smsSent: smsCap * 0.1,
      aiSpendMicros: DEFAULT_CHAT_SPEND_CAP_MICROS * 0.1,
      aiCapMicros: DEFAULT_CHAT_SPEND_CAP_MICROS
    });
    expect(pct).toBe(10);
  });

  it("excludes the AI axis when spend is unknown (historical months)", () => {
    const voiceCapMin = TIER_LIMITS.starter.voiceIncludedSecondsPerStripePeriod / 60;
    const smsCap = TIER_LIMITS.starter.smsPerMonth;
    const pct = computeUtilizationPct({
      tier: "starter",
      voiceMinutes: voiceCapMin, // 100%
      smsSent: smsCap / 2, // 50%
      aiSpendMicros: null,
      aiCapMicros: STARTER_CHAT_SPEND_CAP_MICROS
    });
    expect(pct).toBe(75);
  });

  it("excludes uncapped axes (enterprise unlimited SMS)", () => {
    const voiceCapMin = TIER_LIMITS.enterprise.voiceIncludedSecondsPerStripePeriod / 60;
    const pct = computeUtilizationPct({
      tier: "enterprise",
      voiceMinutes: voiceCapMin / 4,
      smsSent: 999_999, // no cap — must not count
      aiSpendMicros: null,
      aiCapMicros: DEFAULT_CHAT_SPEND_CAP_MICROS
    });
    expect(pct).toBe(25);
  });

  it("applies enterprise limit overrides to the caps", () => {
    const pct = computeUtilizationPct({
      tier: "enterprise",
      enterpriseLimitsOverride: { voiceIncludedSecondsPerStripePeriod: 6000, smsPerMonth: 100 },
      voiceMinutes: 50, // 50% of the overridden 100-minute pool
      smsSent: 100, // 100% of the overridden cap
      aiSpendMicros: null,
      aiCapMicros: 0
    });
    expect(pct).toBe(75);
  });

  it("ignores a zero AI cap even when spend is known", () => {
    const voiceCapMin = TIER_LIMITS.standard.voiceIncludedSecondsPerStripePeriod / 60;
    const pct = computeUtilizationPct({
      tier: "standard",
      voiceMinutes: voiceCapMin / 2,
      smsSent: 0,
      aiSpendMicros: 123,
      aiCapMicros: 0
    });
    // voice 50% + sms 0% → 25%
    expect(pct).toBe(25);
  });
});

describe("telnyxMicrosByBusinessInWindow", () => {
  function rowFor(day: string, businessId: string | null, micros: number): TelnyxCostDailyRow {
    return {
      id: 1,
      day,
      business_id: businessId,
      record_type: "messaging",
      direction: "outbound",
      record_count: 1,
      cost_micros: micros,
      carrier_fee_micros: 0,
      billed_seconds: 0,
      synced_at: "2026-07-12T00:00:00.000Z"
    };
  }

  it("sums per business inside the window, excluding unattributed and out-of-window rows", () => {
    const window = monthWindow("2026-06");
    const result = telnyxMicrosByBusinessInWindow(
      [
        rowFor("2026-06-05", "biz-1", 100),
        rowFor("2026-06-20", "biz-1", 50),
        rowFor("2026-06-21", null, 999), // counts as hasRows, not attributed
        rowFor("2026-05-31", "biz-1", 77), // before window
        rowFor("2026-07-01", "biz-1", 88) // at/after exclusive end
      ],
      window
    );
    expect(result.hasRows).toBe(true);
    expect(result.byBusiness.get("biz-1")).toBe(150);
    expect(result.byBusiness.size).toBe(1);
  });

  it("reports hasRows false for an empty window", () => {
    const result = telnyxMicrosByBusinessInWindow(
      [rowFor("2026-05-31", "biz-1", 77)],
      monthWindow("2026-06")
    );
    expect(result.hasRows).toBe(false);
    expect(result.byBusiness.size).toBe(0);
  });
});
