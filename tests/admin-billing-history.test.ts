import { describe, it, expect, vi } from "vitest";
import type { BusinessRow } from "@/lib/db/businesses";
import {
  DEFAULT_HISTORY_MONTHS,
  UNATTRIBUTED_KEY,
  composeBillingHistory,
  emptyCell,
  historyMonths,
  loadBillingHistory,
  monthElapsedFraction,
  monthKey,
  monthKeyOfYmd,
  seriesOf,
  trendFor,
  vendorCents,
  windowStartYmd,
  type BillingHistoryCell,
  type ComposeBillingHistoryInput
} from "@/lib/admin/billing-history";

const business = (id: string, name: string): BusinessRow =>
  ({ id, name, tier: "standard" }) as BusinessRow;

const AMY = business("amy", "Amy Laidlaw Real Estate");
const KYP = business("kyp", "KYP Ads");

/** Aug 28 2026, ~90% through the month, matching the spike that motivated this page. */
const NOW = new Date("2026-08-28T12:00:00.000Z");

function input(over: Partial<ComposeBillingHistoryInput> = {}): ComposeBillingHistoryInput {
  return {
    months: ["2026-07", "2026-08"],
    businesses: [AMY, KYP],
    usage: [],
    voice: [],
    telnyx: [],
    gemini: [],
    stripe: [],
    now: NOW,
    ...over
  };
}

describe("month helpers", () => {
  it("keys a date and a day string to its month", () => {
    expect(monthKey(NOW)).toBe("2026-08");
    expect(monthKeyOfYmd("2026-07-31")).toBe("2026-07");
  });

  it("lists months oldest first, ending with the current one", () => {
    expect(historyMonths(NOW, 3)).toEqual(["2026-06", "2026-07", "2026-08"]);
  });

  it("crosses a year boundary", () => {
    expect(historyMonths(new Date("2026-01-15T00:00:00Z"), 3)).toEqual([
      "2025-11",
      "2025-12",
      "2026-01"
    ]);
  });

  it("clamps a nonsensical count to one month rather than returning no columns", () => {
    expect(historyMonths(NOW, 0)).toEqual(["2026-08"]);
    expect(historyMonths(NOW, -5)).toEqual(["2026-08"]);
  });

  it("starts the read window on the first day of the oldest month", () => {
    expect(windowStartYmd(["2026-06", "2026-07"])).toBe("2026-06-01");
  });

  it("measures how much of the current month has elapsed", () => {
    // Aug has 31 days; noon on the 28th is 27.5 days in.
    expect(monthElapsedFraction(NOW)).toBeCloseTo(27.5 / 31, 5);
    expect(monthElapsedFraction(new Date("2026-08-31T23:59:59.999Z"))).toBeCloseTo(1, 5);
  });

  it("adds the two cost lines it can source per month", () => {
    expect(vendorCents({ ...emptyCell(), telnyxCents: 300, geminiCents: 45 })).toBe(345);
  });

  it("defaults to a year of history", () => {
    expect(DEFAULT_HISTORY_MONTHS).toBe(12);
  });
});

describe("composeBillingHistory", () => {
  it("buckets every source into the right tenant-month", () => {
    const history = composeBillingHistory(
      input({
        usage: [
          { business_id: "amy", usage_date: "2026-07-04", sms_sent: 10, sms_text_units: 26 },
          { business_id: "amy", usage_date: "2026-08-04", sms_sent: 20, sms_text_units: 61 }
        ],
        voice: [
          { business_id: "amy", created_at: "2026-08-05T10:00:00Z", billable_seconds: 90 },
          { business_id: "amy", created_at: "2026-08-06T10:00:00Z", billable_seconds: 30 }
        ],
        telnyx: [{ business_id: "amy", day: "2026-08-07", cost_micros: 3_178_000 }],
        gemini: [{ business_id: "amy", day: "2026-08-07", cost_micros: 20_000 }],
        stripe: [
          { business_id: "amy", month_start: "2026-08-01", charge_gross_cents: 28_399 }
        ]
      })
    );
    const amy = history.rows.find((r) => r.business?.id === "amy")!;
    expect(amy.cells[0]).toMatchObject({ messages: 10, textUnits: 26 });
    expect(amy.cells[1]).toMatchObject({
      messages: 20,
      textUnits: 61,
      voiceMinutes: 2,
      calls: 2,
      telnyxCents: 317.8,
      geminiCents: 2,
      revenueCents: 28_399
    });
  });

  it("treats null metered columns as zero", () => {
    const history = composeBillingHistory(
      input({
        usage: [{ business_id: "amy", usage_date: "2026-08-01", sms_sent: null, sms_text_units: null }],
        voice: [{ business_id: "amy", created_at: "2026-08-01T00:00:00Z", billable_seconds: null }]
      })
    );
    expect(history.rows[0]!.cells[1]).toMatchObject({ messages: 0, textUnits: 0, voiceMinutes: 0, calls: 1 });
  });

  it("drops rows outside the window instead of mis-filing them", () => {
    const history = composeBillingHistory(
      input({
        usage: [{ business_id: "amy", usage_date: "2026-05-04", sms_sent: 99, sms_text_units: 99 }],
        voice: [{ business_id: "amy", created_at: "2026-05-05T10:00:00Z", billable_seconds: 600 }],
        telnyx: [{ business_id: "amy", day: "2026-05-07", cost_micros: 1_000_000 }],
        gemini: [{ business_id: "amy", day: "2026-05-07", cost_micros: 1_000_000 }],
        stripe: [{ business_id: "amy", month_start: "2026-05-01", charge_gross_cents: 100 }]
      })
    );
    expect(history.rows).toEqual([]);
    expect(history.fleet).toEqual([emptyCell(), emptyCell()]);
  });

  it("files spend that matched no tenant under its own row", () => {
    const history = composeBillingHistory(
      input({
        telnyx: [{ business_id: null, day: "2026-08-07", cost_micros: 40_000 }],
        stripe: [{ business_id: null, month_start: "2026-08-01", charge_gross_cents: 29 }]
      })
    );
    expect(history.rows).toHaveLength(1);
    expect(history.rows[0]!.business).toBeNull();
    expect(history.rows[0]!.cells[1]).toMatchObject({ telnyxCents: 4, revenueCents: 29 });
  });

  it("keeps a row whose business row is missing from the fleet list", () => {
    const history = composeBillingHistory(
      input({
        businesses: [],
        telnyx: [{ business_id: "ghost", day: "2026-08-07", cost_micros: 10_000 }]
      })
    );
    expect(history.rows[0]!.business).toBeNull();
  });

  it("sorts by this month's vendor spend, then by name", () => {
    const history = composeBillingHistory(
      input({
        telnyx: [
          { business_id: "kyp", day: "2026-08-07", cost_micros: 1_071_000 },
          { business_id: "amy", day: "2026-08-07", cost_micros: 3_178_000 }
        ]
      })
    );
    expect(history.rows.map((r) => r.business?.name)).toEqual([
      "Amy Laidlaw Real Estate",
      "KYP Ads"
    ]);
  });

  it("breaks a vendor-spend tie on name", () => {
    const history = composeBillingHistory(
      input({
        usage: [
          { business_id: "kyp", usage_date: "2026-08-01", sms_sent: 1, sms_text_units: 1 },
          { business_id: "amy", usage_date: "2026-08-01", sms_sent: 1, sms_text_units: 1 }
        ]
      })
    );
    expect(history.rows.map((r) => r.business?.name)).toEqual([
      "Amy Laidlaw Real Estate",
      "KYP Ads"
    ]);
  });

  it("sorts an unattributed row against a named one when they tie on spend", () => {
    const history = composeBillingHistory(
      input({
        telnyx: [
          { business_id: null, day: "2026-08-07", cost_micros: 0 },
          { business_id: "amy", day: "2026-08-07", cost_micros: 0 }
        ]
      })
    );
    expect(history.rows.map((r) => r.business?.name ?? "(unattributed)")).toEqual([
      "(unattributed)",
      "Amy Laidlaw Real Estate"
    ]);
  });

  it("sums the fleet row across tenants", () => {
    const history = composeBillingHistory(
      input({
        usage: [
          { business_id: "amy", usage_date: "2026-08-01", sms_sent: 3, sms_text_units: 9 },
          { business_id: "kyp", usage_date: "2026-08-01", sms_sent: 2, sms_text_units: 5 }
        ],
        voice: [{ business_id: "amy", created_at: "2026-08-02T00:00:00Z", billable_seconds: 60 }],
        telnyx: [{ business_id: "kyp", day: "2026-08-02", cost_micros: 10_000 }],
        gemini: [{ business_id: "amy", day: "2026-08-02", cost_micros: 20_000 }],
        stripe: [{ business_id: "kyp", month_start: "2026-08-01", charge_gross_cents: 100 }]
      })
    );
    expect(history.fleet[1]).toEqual({
      messages: 5,
      textUnits: 14,
      voiceMinutes: 1,
      calls: 1,
      telnyxCents: 1,
      geminiCents: 2,
      revenueCents: 100
    });
  });

  it("flags the newest month as partial only when it is the month we are in", () => {
    expect(composeBillingHistory(input()).newestMonthIsPartial).toBe(true);
    expect(
      composeBillingHistory(input({ months: ["2026-06", "2026-07"] })).newestMonthIsPartial
    ).toBe(false);
  });

  it("exposes the unattributed key callers use to build links", () => {
    expect(UNATTRIBUTED_KEY).toBe("__unattributed__");
  });
});

describe("trendFor", () => {
  const cells = (telnyx: number[]): BillingHistoryCell[] =>
    telnyx.map((t) => ({ ...emptyCell(), telnyxCents: t }));

  it("pulls one metric out of a series", () => {
    expect(seriesOf(cells([100, 200]), (c) => c.telnyxCents)).toEqual([100, 200]);
  });

  it("pro-rates a month still in progress", () => {
    // Amy's real shape: $15.98 in July, $31.78 by the 28th of a 31-day August.
    const trend = trendFor([1598, 3178], { partial: true, elapsed: 27.5 / 31 });
    expect(trend.current).toBe(3178);
    expect(trend.previous).toBe(1598);
    expect(trend.projected).toBeCloseTo(3582.5, 0);
    expect(trend.changePct).toBeCloseTo(124.2, 0);
  });

  it("leaves a finished month alone", () => {
    const trend = trendFor([1000, 1500], { partial: false, elapsed: 0.5 });
    expect(trend.projected).toBe(1500);
    expect(trend.changePct).toBe(50);
  });

  it("does not divide by a zero elapsed fraction", () => {
    expect(trendFor([100, 50], { partial: true, elapsed: 0 }).projected).toBe(50);
  });

  it("reports null rather than an infinite jump from a zero month", () => {
    expect(trendFor([0, 500], { partial: false, elapsed: 1 }).changePct).toBeNull();
  });

  it("treats a missing history as zeros", () => {
    expect(trendFor([], { partial: false, elapsed: 1 })).toEqual({
      previous: 0,
      current: 0,
      projected: 0,
      changePct: null
    });
  });
});

describe("loadBillingHistory", () => {
  it("reads each source once over the whole window and composes them", async () => {
    const loadBusinesses = vi.fn(async () => [AMY]);
    const loadUsage = vi.fn(async () => [
      { business_id: "amy", usage_date: "2026-08-04", sms_sent: 20, sms_text_units: 61 }
    ]);
    const loadVoice = vi.fn(async () => [
      { business_id: "amy", created_at: "2026-08-05T10:00:00Z", billable_seconds: 120 }
    ]);
    const loadTelnyx = vi.fn(async () => [
      {
        business_id: "amy",
        day: "2026-08-07",
        cost_micros: 3_178_000,
        id: 1,
        record_type: "messaging" as const,
        direction: "outbound",
        record_count: 1,
        carrier_fee_micros: 0,
        billed_seconds: 0,
        sender: null,
        synced_at: "2026-08-07T00:00:00Z"
      }
    ]);
    const loadGemini = vi.fn(async () => [
      {
        business_id: "amy",
        day: "2026-08-07",
        cost_micros: 20_000,
        surface: "owner_chat",
        model: "gemini",
        pricing_source: "exact" as const,
        call_count: 1,
        prompt_tokens: 1,
        output_tokens: 1
      }
    ]);
    const loadStripe = vi.fn(async () => [
      {
        business_id: "amy",
        month_start: "2026-08-01",
        charge_gross_cents: 28_399,
        id: 1,
        gross_cents: 28_399,
        fee_cents: 1000,
        net_cents: 27_399,
        charge_fee_cents: 1000,
        charge_count: 1,
        synced_at: "2026-08-07T00:00:00Z"
      }
    ]);

    const history = await loadBillingHistory({
      now: NOW,
      months: 2,
      loadBusinesses,
      loadUsage,
      loadVoice,
      loadTelnyx,
      loadGemini,
      loadStripe
    });

    expect(history.months).toEqual(["2026-07", "2026-08"]);
    expect(loadUsage).toHaveBeenCalledWith("2026-07-01", undefined);
    expect(loadVoice).toHaveBeenCalledWith("2026-07-01T00:00:00.000Z", undefined);
    expect(loadTelnyx).toHaveBeenCalledWith("2026-07-01", undefined);
    expect(loadStripe).toHaveBeenCalledWith("2026-07-01", undefined);
    expect(history.rows[0]!.cells[1]).toMatchObject({
      textUnits: 61,
      voiceMinutes: 2,
      telnyxCents: 317.8,
      revenueCents: 28_399
    });
  });

  it("defaults the window to a year and passes the injected client through", async () => {
    const client = { marker: true } as never;
    const loadUsage = vi.fn(async () => []);
    const history = await loadBillingHistory({
      now: NOW,
      client,
      loadBusinesses: vi.fn(async () => []),
      loadUsage,
      loadVoice: vi.fn(async () => []),
      loadTelnyx: vi.fn(async () => []),
      loadGemini: vi.fn(async () => []),
      loadStripe: vi.fn(async () => [])
    });
    expect(history.months).toHaveLength(DEFAULT_HISTORY_MONTHS);
    expect(loadUsage).toHaveBeenCalledWith("2025-09-01", client);
  });

  it("uses the wall clock when no now is injected", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      const history = await loadBillingHistory({
        months: 1,
        loadBusinesses: vi.fn(async () => []),
        loadUsage: vi.fn(async () => []),
        loadVoice: vi.fn(async () => []),
        loadTelnyx: vi.fn(async () => []),
        loadGemini: vi.fn(async () => []),
        loadStripe: vi.fn(async () => [])
      });
      expect(history.months).toEqual(["2026-08"]);
    } finally {
      vi.useRealTimers();
    }
  });
});
