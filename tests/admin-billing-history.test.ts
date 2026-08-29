/**
 * Everything here drives `loadBillingHistory`, the entry point the page calls,
 * with the six readers injected. The folding, bucketing and month-window logic
 * are module-private on purpose: an export whose only caller is a test is dead
 * code wearing coverage (see scripts/knip-exports-ratchet.mjs), so they are
 * exercised through the surface production actually uses.
 */
import { describe, it, expect, vi } from "vitest";
import type { BusinessRow } from "@/lib/db/businesses";
import {
  UNATTRIBUTED_KEY,
  loadBillingHistory,
  seriesOf,
  trendFor,
  vendorCents,
  type BillingHistory,
  type BillingHistoryCell
} from "@/lib/admin/billing-history";

const business = (id: string, name: string): BusinessRow =>
  ({ id, name, tier: "standard" }) as BusinessRow;

const AMY = business("amy", "Amy Laidlaw Real Estate");
const KYP = business("kyp", "KYP Ads");

/** Aug 28 2026, ~90% through the month, matching the spike that motivated this page. */
const NOW = new Date("2026-08-28T12:00:00.000Z");

const EMPTY: BillingHistoryCell = {
  messages: 0,
  textUnits: 0,
  voiceMinutes: 0,
  calls: 0,
  telnyxCents: 0,
  geminiCents: 0,
  revenueCents: 0
};

type Rows = {
  businesses?: BusinessRow[];
  usage?: Array<{
    business_id: string;
    usage_date: string;
    sms_sent: number | null;
    sms_text_units: number | null;
  }>;
  voice?: Array<{ business_id: string; created_at: string; billable_seconds: number | null }>;
  telnyx?: Array<{ business_id: string | null; day: string; cost_micros: number }>;
  gemini?: Array<{ business_id: string; day: string; cost_micros: number }>;
  stripe?: Array<{ business_id: string | null; month_start: string; charge_gross_cents: number }>;
};

/** No rows at all, for the window-shape assertions. */
const NO_READERS = {
  loadBusinesses: vi.fn(async () => []),
  loadUsage: vi.fn(async () => []),
  loadVoice: vi.fn(async () => []),
  loadTelnyx: vi.fn(async () => []),
  loadGemini: vi.fn(async () => []),
  loadStripe: vi.fn(async () => [])
};

/** Load a two-month window (July + August 2026) from hand-supplied rows. */
async function load(rows: Rows = {}, months = 2): Promise<BillingHistory> {
  return await loadBillingHistory({
    now: NOW,
    months,
    loadBusinesses: vi.fn(async () => rows.businesses ?? [AMY, KYP]),
    loadUsage: vi.fn(async () => rows.usage ?? []),
    loadVoice: vi.fn(async () => rows.voice ?? []),
    loadTelnyx: vi.fn(async () => (rows.telnyx ?? []) as never),
    loadGemini: vi.fn(async () => (rows.gemini ?? []) as never),
    loadStripe: vi.fn(async () => (rows.stripe ?? []) as never)
  });
}

describe("the window", () => {
  it("ends with the month we are in and runs oldest first", async () => {
    expect((await load({}, 3)).months).toEqual(["2026-06", "2026-07", "2026-08"]);
  });

  it("crosses a year boundary", async () => {
    const history = await loadBillingHistory({
      ...NO_READERS,
      now: new Date("2026-01-15T00:00:00Z"),
      months: 3
    });
    expect(history.months).toEqual(["2025-11", "2025-12", "2026-01"]);
  });

  it("clamps a nonsensical count to one month rather than rendering no columns", async () => {
    expect((await load({}, 0)).months).toEqual(["2026-08"]);
    expect((await load({}, -5)).months).toEqual(["2026-08"]);
  });

  it("reads every source from the first day of the oldest month", async () => {
    const loadUsage = vi.fn(async () => []);
    const loadVoice = vi.fn(async () => []);
    const loadTelnyx = vi.fn(async () => []);
    const loadStripe = vi.fn(async () => []);
    await loadBillingHistory({
      ...NO_READERS,
      now: NOW,
      months: 2,
      loadUsage,
      loadVoice,
      loadTelnyx,
      loadStripe
    });
    expect(loadUsage).toHaveBeenCalledWith("2026-07-01", undefined);
    expect(loadVoice).toHaveBeenCalledWith("2026-07-01T00:00:00.000Z", undefined);
    expect(loadTelnyx).toHaveBeenCalledWith("2026-07-01", undefined);
    expect(loadStripe).toHaveBeenCalledWith("2026-07-01", undefined);
  });

  it("passes an injected client through to every reader", async () => {
    const client = { marker: true } as never;
    const loadUsage = vi.fn(async () => []);
    await loadBillingHistory({ ...NO_READERS, now: NOW, client, months: 1, loadUsage });
    expect(loadUsage).toHaveBeenCalledWith("2026-08-01", client);
  });

  it("defaults to a year of history", async () => {
    const history = await loadBillingHistory({ ...NO_READERS, now: NOW });
    expect(history.months).toHaveLength(12);
    expect(history.months[11]).toBe("2026-08");
  });

  it("uses the wall clock when no now is injected", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      const history = await loadBillingHistory({ ...NO_READERS, months: 1 });
      expect(history.months).toEqual(["2026-08"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports how much of the live month has elapsed, and that it is live", async () => {
    const history = await load();
    expect(history.newestMonthIsPartial).toBe(true);
    // Aug has 31 days; noon on the 28th is 27.5 days in.
    expect(history.newestMonthElapsed).toBeCloseTo(27.5 / 31, 5);
  });

  it("reads the elapsed fraction as full on the last instant of a month", async () => {
    const history = await loadBillingHistory({
      ...NO_READERS,
      now: new Date("2026-08-31T23:59:59.999Z"),
      months: 1
    });
    expect(history.newestMonthElapsed).toBeCloseTo(1, 5);
  });
});

describe("bucketing", () => {
  it("files every source into the right tenant-month", async () => {
    const history = await load({
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
      stripe: [{ business_id: "amy", month_start: "2026-08-01", charge_gross_cents: 28_399 }]
    });
    const amy = history.rows.find((r) => r.business?.id === "amy")!;
    expect(amy.cells[0]).toMatchObject({ messages: 10, textUnits: 26 });
    expect(amy.cells[1]).toEqual({
      messages: 20,
      textUnits: 61,
      voiceMinutes: 2,
      calls: 2,
      telnyxCents: 317.8,
      geminiCents: 2,
      revenueCents: 28_399
    });
  });

  it("treats null metered columns as zero", async () => {
    const history = await load({
      usage: [
        { business_id: "amy", usage_date: "2026-08-01", sms_sent: null, sms_text_units: null }
      ],
      voice: [{ business_id: "amy", created_at: "2026-08-01T00:00:00Z", billable_seconds: null }]
    });
    expect(history.rows[0]!.cells[1]).toMatchObject({
      messages: 0,
      textUnits: 0,
      voiceMinutes: 0,
      calls: 1
    });
  });

  it("drops rows outside the window instead of mis-filing them", async () => {
    const history = await load({
      usage: [{ business_id: "amy", usage_date: "2026-05-04", sms_sent: 99, sms_text_units: 99 }],
      voice: [{ business_id: "amy", created_at: "2026-05-05T10:00:00Z", billable_seconds: 600 }],
      telnyx: [{ business_id: "amy", day: "2026-05-07", cost_micros: 1_000_000 }],
      gemini: [{ business_id: "amy", day: "2026-05-07", cost_micros: 1_000_000 }],
      stripe: [{ business_id: "amy", month_start: "2026-05-01", charge_gross_cents: 100 }]
    });
    expect(history.rows).toEqual([]);
    expect(history.fleet).toEqual([EMPTY, EMPTY]);
  });

  it("files spend that matched no tenant under its own row", async () => {
    const history = await load({
      telnyx: [{ business_id: null, day: "2026-08-07", cost_micros: 40_000 }],
      stripe: [{ business_id: null, month_start: "2026-08-01", charge_gross_cents: 29 }]
    });
    expect(history.rows).toHaveLength(1);
    expect(history.rows[0]!.business).toBeNull();
    expect(history.rows[0]!.cells[1]).toMatchObject({ telnyxCents: 4, revenueCents: 29 });
  });

  it("keeps a row whose business is missing from the fleet list", async () => {
    const history = await load({
      businesses: [],
      telnyx: [{ business_id: "ghost", day: "2026-08-07", cost_micros: 10_000 }]
    });
    expect(history.rows[0]!.business).toBeNull();
    // The id survives, so the page can still say WHICH departed tenant it is.
    expect(history.rows[0]!.key).toBe("ghost");
  });

  it("keeps two departed tenants apart instead of merging them", async () => {
    // Both resolve to `business: null`. Keyed on that alone they collapsed
    // into one label, one React key and one drill-in, while the fleet totals
    // above still counted both.
    const history = await load({
      businesses: [],
      usage: [
        { business_id: "gone-a", usage_date: "2026-08-01", sms_sent: 1, sms_text_units: 3 },
        { business_id: "gone-b", usage_date: "2026-08-01", sms_sent: 1, sms_text_units: 7 }
      ]
    });
    expect(history.rows.map((r) => r.key).sort()).toEqual(["gone-a", "gone-b"]);
    expect(new Set(history.rows.map((r) => r.key)).size).toBe(2);
    // And the per-tenant rows still add up to the fleet row.
    expect(history.fleet[1]!.textUnits).toBe(10);
  });

  it("keeps genuinely unattributed spend separate from a departed tenant", async () => {
    const history = await load({
      businesses: [],
      telnyx: [
        { business_id: null, day: "2026-08-07", cost_micros: 40_000 },
        { business_id: "gone", day: "2026-08-07", cost_micros: 10_000 }
      ]
    });
    expect(history.rows.map((r) => r.key).sort()).toEqual([UNATTRIBUTED_KEY, "gone"].sort());
  });

  it("omits a tenant with no activity anywhere in the window", async () => {
    const history = await load({
      telnyx: [{ business_id: "amy", day: "2026-08-07", cost_micros: 10_000 }]
    });
    expect(history.rows.map((r) => r.business?.id)).toEqual(["amy"]);
  });

  it("sums the fleet row across tenants", async () => {
    const history = await load({
      usage: [
        { business_id: "amy", usage_date: "2026-08-01", sms_sent: 3, sms_text_units: 9 },
        { business_id: "kyp", usage_date: "2026-08-01", sms_sent: 2, sms_text_units: 5 }
      ],
      voice: [{ business_id: "amy", created_at: "2026-08-02T00:00:00Z", billable_seconds: 60 }],
      telnyx: [{ business_id: "kyp", day: "2026-08-02", cost_micros: 10_000 }],
      gemini: [{ business_id: "amy", day: "2026-08-02", cost_micros: 20_000 }],
      stripe: [{ business_id: "kyp", month_start: "2026-08-01", charge_gross_cents: 100 }]
    });
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
});

describe("ordering", () => {
  it("puts this month's biggest vendor spend first", async () => {
    const history = await load({
      telnyx: [
        { business_id: "kyp", day: "2026-08-07", cost_micros: 1_071_000 },
        { business_id: "amy", day: "2026-08-07", cost_micros: 3_178_000 }
      ]
    });
    expect(history.rows.map((r) => r.business?.name)).toEqual([
      "Amy Laidlaw Real Estate",
      "KYP Ads"
    ]);
  });

  it("breaks a spend tie on name", async () => {
    const history = await load({
      usage: [
        { business_id: "kyp", usage_date: "2026-08-01", sms_sent: 1, sms_text_units: 1 },
        { business_id: "amy", usage_date: "2026-08-01", sms_sent: 1, sms_text_units: 1 }
      ]
    });
    expect(history.rows.map((r) => r.business?.name)).toEqual([
      "Amy Laidlaw Real Estate",
      "KYP Ads"
    ]);
  });

  it("sorts the nameless unattributed bucket above a named tie", async () => {
    const history = await load({
      telnyx: [
        { business_id: null, day: "2026-08-07", cost_micros: 0 },
        { business_id: "amy", day: "2026-08-07", cost_micros: 0 }
      ]
    });
    expect(history.rows.map((r) => r.business?.name ?? UNATTRIBUTED_KEY)).toEqual([
      UNATTRIBUTED_KEY,
      "Amy Laidlaw Real Estate"
    ]);
  });
});

describe("trends", () => {
  const cells = (telnyx: number[]): BillingHistoryCell[] =>
    telnyx.map((t) => ({ ...EMPTY, telnyxCents: t }));

  it("adds the two cost lines it can source per month", () => {
    expect(vendorCents({ ...EMPTY, telnyxCents: 300, geminiCents: 45 })).toBe(345);
  });

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

  it("exposes the key the page uses to link the unattributed row", () => {
    expect(UNATTRIBUTED_KEY).toBe("__unattributed__");
  });
});
