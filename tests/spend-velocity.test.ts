import { describe, expect, it } from "vitest";
import {
  DEFAULT_SPEND_VELOCITY_CONFIG,
  MAX_WINDOW_MINUTES,
  MIN_THRESHOLD_MICROS,
  MIN_WINDOW_MINUTES,
  computeVelocityBreaches,
  formatSpendVelocityEmail,
  latestSpendPerBusiness,
  microsToUsd,
  parseSpendVelocityConfig,
  serializeSpendVelocityConfig,
  type SnapshotRow,
  type SpendRow
} from "../supabase/functions/_shared/spend_velocity";

const BIZ_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BIZ_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const NOW = new Date("2026-07-10T12:00:00Z");
const PERIOD = "2026-07-01T00:00:00+00:00";

const CONFIG = { enabled: true, thresholdMicros: 3_000_000, windowMinutes: 120 };

function snap(businessId: string, spend: number, minutesAgo: number, period = PERIOD): SnapshotRow {
  return {
    business_id: businessId,
    period_start: period,
    spend_micros: spend,
    captured_at: new Date(NOW.getTime() - minutesAgo * 60_000).toISOString()
  };
}

describe("parseSpendVelocityConfig", () => {
  it("returns the launch defaults for missing/garbage rows ($3 / 120 min, enabled)", () => {
    expect(parseSpendVelocityConfig(null)).toEqual(DEFAULT_SPEND_VELOCITY_CONFIG);
    expect(parseSpendVelocityConfig("junk")).toEqual(DEFAULT_SPEND_VELOCITY_CONFIG);
    expect(parseSpendVelocityConfig({})).toEqual(DEFAULT_SPEND_VELOCITY_CONFIG);
    expect(DEFAULT_SPEND_VELOCITY_CONFIG).toEqual({
      enabled: true,
      thresholdMicros: 3_000_000,
      windowMinutes: 120
    });
  });

  it("reads a well-formed row verbatim", () => {
    expect(
      parseSpendVelocityConfig({ enabled: false, threshold_micros: 5_000_000, window_minutes: 60 })
    ).toEqual({ enabled: false, thresholdMicros: 5_000_000, windowMinutes: 60 });
  });

  it("clamps out-of-range numbers and floors fractions", () => {
    const clamped = parseSpendVelocityConfig({
      enabled: true,
      threshold_micros: 5, // below the $0.10 floor
      window_minutes: 999999
    });
    expect(clamped.thresholdMicros).toBe(MIN_THRESHOLD_MICROS);
    expect(clamped.windowMinutes).toBe(MAX_WINDOW_MINUTES);

    const low = parseSpendVelocityConfig({ threshold_micros: 4_500_000.9, window_minutes: 1 });
    expect(low.thresholdMicros).toBe(4_500_000);
    expect(low.windowMinutes).toBe(MIN_WINDOW_MINUTES);

    // Negative / NaN fall back to defaults entirely.
    const bad = parseSpendVelocityConfig({ threshold_micros: -1, window_minutes: "soon" });
    expect(bad.thresholdMicros).toBe(DEFAULT_SPEND_VELOCITY_CONFIG.thresholdMicros);
    expect(bad.windowMinutes).toBe(DEFAULT_SPEND_VELOCITY_CONFIG.windowMinutes);
  });

  it("round-trips through serializeSpendVelocityConfig", () => {
    const config = { enabled: false, thresholdMicros: 7_000_000, windowMinutes: 45 };
    expect(parseSpendVelocityConfig(serializeSpendVelocityConfig(config))).toEqual(config);
  });
});

describe("latestSpendPerBusiness", () => {
  it("keeps only the newest period row per business", () => {
    const rows: SpendRow[] = [
      { business_id: BIZ_A, period_start: "2026-06-01T00:00:00Z", spend_micros: 900 },
      { business_id: BIZ_A, period_start: PERIOD, spend_micros: 100 },
      { business_id: BIZ_B, period_start: PERIOD, spend_micros: 50 }
    ];
    const latest = latestSpendPerBusiness(rows);
    expect(latest).toHaveLength(2);
    expect(latest.find((r) => r.business_id === BIZ_A)?.spend_micros).toBe(100);
  });

  it("keeps the newest row regardless of input order", () => {
    const rows: SpendRow[] = [
      { business_id: BIZ_A, period_start: PERIOD, spend_micros: 100 },
      { business_id: BIZ_A, period_start: "2026-06-01T00:00:00Z", spend_micros: 900 }
    ];
    expect(latestSpendPerBusiness(rows)).toEqual([rows[0]]);
  });
});

describe("computeVelocityBreaches", () => {
  it("alerts when the window delta exceeds the threshold (strictly more than)", () => {
    const current: SpendRow[] = [
      { business_id: BIZ_A, period_start: PERIOD, spend_micros: 5_000_000 }
    ];
    const exact = computeVelocityBreaches({
      current,
      snapshots: [snap(BIZ_A, 2_000_000, 110)],
      recentAlerts: [],
      config: CONFIG,
      now: NOW
    });
    // Delta is exactly $3 — NOT more than $3, no alert.
    expect(exact).toEqual([]);

    const over = computeVelocityBreaches({
      current: [{ business_id: BIZ_A, period_start: PERIOD, spend_micros: 5_000_001 }],
      snapshots: [snap(BIZ_A, 2_000_000, 110)],
      recentAlerts: [],
      config: CONFIG,
      now: NOW
    });
    expect(over).toEqual([
      {
        businessId: BIZ_A,
        deltaMicros: 3_000_001,
        baselineMicros: 2_000_000,
        periodStart: PERIOD
      }
    ]);
  });

  it("uses the OLDEST in-window snapshot as the baseline", () => {
    const breaches = computeVelocityBreaches({
      current: [{ business_id: BIZ_A, period_start: PERIOD, spend_micros: 10_000_000 }],
      snapshots: [
        snap(BIZ_A, 1_000_000, 119), // oldest in window → baseline
        snap(BIZ_A, 6_000_000, 60),
        snap(BIZ_A, 500_000, 130) // outside the window — ignored
      ],
      recentAlerts: [],
      config: CONFIG,
      now: NOW
    });
    expect(breaches[0]?.baselineMicros).toBe(1_000_000);
    expect(breaches[0]?.deltaMicros).toBe(9_000_000);
  });

  it("skips businesses without a usable baseline (first tick) and other businesses' snapshots", () => {
    const breaches = computeVelocityBreaches({
      current: [{ business_id: BIZ_A, period_start: PERIOD, spend_micros: 99_000_000 }],
      snapshots: [snap(BIZ_B, 0, 60)],
      recentAlerts: [],
      config: CONFIG,
      now: NOW
    });
    expect(breaches).toEqual([]);
  });

  it("treats a period that started inside the window as baseline 0", () => {
    const freshPeriod = new Date(NOW.getTime() - 30 * 60_000).toISOString();
    const breaches = computeVelocityBreaches({
      current: [{ business_id: BIZ_A, period_start: freshPeriod, spend_micros: 3_500_000 }],
      snapshots: [],
      recentAlerts: [],
      config: CONFIG,
      now: NOW
    });
    expect(breaches).toEqual([
      {
        businessId: BIZ_A,
        deltaMicros: 3_500_000,
        baselineMicros: 0,
        periodStart: freshPeriod
      }
    ]);
  });

  it("ignores snapshots from a DIFFERENT period (billing rollover safety)", () => {
    const breaches = computeVelocityBreaches({
      current: [{ business_id: BIZ_A, period_start: PERIOD, spend_micros: 9_000_000 }],
      snapshots: [snap(BIZ_A, 1_000_000, 60, "2026-06-01T00:00:00+00:00")],
      recentAlerts: [],
      config: CONFIG,
      now: NOW
    });
    expect(breaches).toEqual([]);
  });

  it("dedupes: a business alerted within the window is skipped; older alerts are not", () => {
    const current: SpendRow[] = [
      { business_id: BIZ_A, period_start: PERIOD, spend_micros: 9_000_000 }
    ];
    const snapshots = [snap(BIZ_A, 1_000_000, 110)];

    const recently = computeVelocityBreaches({
      current,
      snapshots,
      recentAlerts: [
        { business_id: BIZ_A, alerted_at: new Date(NOW.getTime() - 30 * 60_000).toISOString() }
      ],
      config: CONFIG,
      now: NOW
    });
    expect(recently).toEqual([]);

    const longAgo = computeVelocityBreaches({
      current,
      snapshots,
      recentAlerts: [
        { business_id: BIZ_A, alerted_at: new Date(NOW.getTime() - 180 * 60_000).toISOString() }
      ],
      config: CONFIG,
      now: NOW
    });
    expect(longAgo).toHaveLength(1);
  });

  it("defaults `now` to the wall clock", () => {
    const breaches = computeVelocityBreaches({
      current: [
        {
          business_id: BIZ_A,
          period_start: new Date(Date.now() - 5 * 60_000).toISOString(),
          spend_micros: 99_000_000
        }
      ],
      snapshots: [],
      recentAlerts: [],
      config: CONFIG
    });
    expect(breaches).toHaveLength(1);
  });
});

describe("email formatting", () => {
  it("microsToUsd renders dollars with two decimals", () => {
    expect(microsToUsd(3_000_000)).toBe("$3.00");
    expect(microsToUsd(12_345)).toBe("$0.01");
  });

  it("names the business, the delta, the window, and the threshold", () => {
    const { subject, text } = formatSpendVelocityEmail({
      breach: {
        businessId: BIZ_A,
        deltaMicros: 4_200_000,
        baselineMicros: 1_000_000,
        periodStart: PERIOD
      },
      config: CONFIG,
      businessName: "Residency Pilot (internal)"
    });
    expect(subject).toContain("Residency Pilot (internal)");
    expect(subject).toContain("$4.20");
    expect(subject).toContain("120 min");
    expect(text).toContain(BIZ_A);
    expect(text).toContain("$3.00 alert threshold");
    expect(text).toContain("$5.20"); // baseline + delta
    expect(text).toContain("$1.00"); // baseline
  });

  it("falls back to the business id when the name is missing/blank", () => {
    const { subject } = formatSpendVelocityEmail({
      breach: { businessId: BIZ_A, deltaMicros: 4_000_000, baselineMicros: 0, periodStart: PERIOD },
      config: CONFIG,
      businessName: "  "
    });
    expect(subject).toContain(BIZ_A);
  });
});
