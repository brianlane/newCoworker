import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockCreateClient = vi.hoisted(() => vi.fn());
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: mockCreateClient
}));

import {
  DEFAULT_CHAT_SPEND_CAP_MICROS,
  STARTER_CHAT_SPEND_CAP_MICROS,
  chatSpendBaseCapMicros,
  chatSpendBaseCapMicrosForTier,
  getChatSpendSnapshotForBusiness,
  getFleetCurrentAiSpendMicros,
  getFleetCurrentAiSpendMicrosByBusiness,
  getSmsBonusTextsRemaining
} from "@/lib/db/chat-usage";

type MaybeSingleResult = { data: unknown; error: { message: string } | null };

/**
 * Chainable query stub: every builder method returns itself; `maybeSingle`
 * resolves the queued result for that table (subscriptions first, then
 * owner_chat_model_spend).
 */
function stubDb(opts: {
  subscriptionRow?: unknown;
  spendRow?: unknown;
  creditResult?: MaybeSingleResult;
  rpcResults?: Record<string, MaybeSingleResult>;
}) {
  const tables: Record<string, MaybeSingleResult> = {
    subscriptions: { data: opts.subscriptionRow ?? null, error: null },
    owner_chat_model_spend: { data: opts.spendRow ?? null, error: null }
  };
  const rpc = vi.fn(async (fn: string) => {
    if (opts.rpcResults && fn in opts.rpcResults) return opts.rpcResults[fn];
    return opts.creditResult ?? { data: 0, error: null };
  });
  const from = vi.fn((table: string) => {
    const builder = {
      select: () => builder,
      eq: () => builder,
      order: () => builder,
      limit: () => builder,
      maybeSingle: async () => tables[table] ?? { data: null, error: null }
    };
    return builder;
  });
  return { from, rpc };
}

describe("chatSpendBaseCapMicros", () => {
  it("defaults to $10 when env is unset or invalid", () => {
    expect(chatSpendBaseCapMicros({})).toBe(DEFAULT_CHAT_SPEND_CAP_MICROS);
    expect(chatSpendBaseCapMicros({ OWNER_CHAT_SPEND_CAP_MICROS: "nope" })).toBe(10_000_000);
    expect(chatSpendBaseCapMicros({ OWNER_CHAT_SPEND_CAP_MICROS: "-3" })).toBe(10_000_000);
  });

  it("reads and floors a valid env value", () => {
    expect(chatSpendBaseCapMicros({ OWNER_CHAT_SPEND_CAP_MICROS: "5000000.9" })).toBe(5_000_000);
  });
});

describe("chatSpendBaseCapMicrosForTier", () => {
  it("gives starter the lower $5 base, standard/enterprise the $10 base", () => {
    expect(chatSpendBaseCapMicrosForTier("starter", {})).toBe(STARTER_CHAT_SPEND_CAP_MICROS);
    expect(chatSpendBaseCapMicrosForTier("starter", {})).toBe(5_000_000);
    expect(chatSpendBaseCapMicrosForTier("standard", {})).toBe(DEFAULT_CHAT_SPEND_CAP_MICROS);
    expect(chatSpendBaseCapMicrosForTier("enterprise", {})).toBe(10_000_000);
    expect(chatSpendBaseCapMicrosForTier(null, {})).toBe(10_000_000);
  });

  it("honors per-tier env overrides", () => {
    expect(
      chatSpendBaseCapMicrosForTier("starter", { OWNER_CHAT_SPEND_CAP_MICROS_STARTER: "3000000" })
    ).toBe(3_000_000);
    expect(
      chatSpendBaseCapMicrosForTier("standard", { OWNER_CHAT_SPEND_CAP_MICROS: "12000000" })
    ).toBe(12_000_000);
  });
});

describe("getChatSpendSnapshotForBusiness", () => {
  const savedCap = process.env.OWNER_CHAT_SPEND_CAP_MICROS;

  beforeEach(() => {
    delete process.env.OWNER_CHAT_SPEND_CAP_MICROS;
  });

  afterEach(() => {
    if (savedCap === undefined) delete process.env.OWNER_CHAT_SPEND_CAP_MICROS;
    else process.env.OWNER_CHAT_SPEND_CAP_MICROS = savedCap;
    vi.clearAllMocks();
  });

  it("uses the Stripe period start, spend row, and active credit", async () => {
    // Pin the clock inside the anchor's first monthly window: with real time
    // this assertion is a time bomb — once "now" crosses the next window
    // boundary, deriveMonthlyQuotaWindow rolls periodStart forward a month.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-15T12:00:00Z"));
    try {
      const db = stubDb({
        subscriptionRow: { stripe_current_period_start: "2026-06-03T00:00:00Z" },
        spendRow: { spend_micros: "2500000" },
        creditResult: { data: 5_000_000, error: null }
      });

      const snap = await getChatSpendSnapshotForBusiness("biz-1", db as never);

      expect(snap).toEqual({
        periodStart: "2026-06-03T00:00:00Z",
        spendMicros: 2_500_000,
        baseCapMicros: 10_000_000,
        creditMicros: 5_000_000,
        effectiveCapMicros: 15_000_000
      });
      expect(db.rpc).toHaveBeenCalledWith("chat_active_credit_micros", { p_business_id: "biz-1" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back to the UTC month start and zeros when nothing exists", async () => {
    const db = stubDb({ creditResult: { data: null, error: null } });

    const snap = await getChatSpendSnapshotForBusiness("biz-1", db as never);

    expect(snap.periodStart).toMatch(/^\d{4}-\d{2}-01T00:00:00\.000Z$/);
    expect(snap.spendMicros).toBe(0);
    expect(snap.creditMicros).toBe(0);
    expect(snap.effectiveCapMicros).toBe(snap.baseCapMicros);
  });

  it("treats a credit RPC error and non-finite spend as zero", async () => {
    const db = stubDb({
      spendRow: { spend_micros: "not-a-number" },
      creditResult: { data: null, error: { message: "boom" } }
    });

    const snap = await getChatSpendSnapshotForBusiness("biz-1", db as never);

    expect(snap.spendMicros).toBe(0);
    expect(snap.creditMicros).toBe(0);
  });

  it("creates a service client when none is passed", async () => {
    const db = stubDb({});
    mockCreateClient.mockResolvedValueOnce(db);

    const snap = await getChatSpendSnapshotForBusiness("biz-1");

    expect(mockCreateClient).toHaveBeenCalled();
    expect(snap.baseCapMicros).toBe(10_000_000);
  });

  it("uses the $5 starter base when tier is starter", async () => {
    const db = stubDb({ spendRow: { spend_micros: "1000000" } });

    const snap = await getChatSpendSnapshotForBusiness("biz-1", db as never, "starter");

    expect(snap.baseCapMicros).toBe(5_000_000);
    expect(snap.effectiveCapMicros).toBe(5_000_000);
  });

  it("uses the $10 base for a non-starter tier", async () => {
    const db = stubDb({ spendRow: { spend_micros: "1000000" } });

    const snap = await getChatSpendSnapshotForBusiness("biz-1", db as never, "standard");

    expect(snap.baseCapMicros).toBe(10_000_000);
  });
});

describe("getFleetCurrentAiSpendMicros", () => {
  afterEach(() => vi.clearAllMocks());

  type FleetSpendRow = {
    business_id?: string;
    period_start?: string;
    spend_micros?: number | string;
  };

  type FleetSpendPage = {
    data: FleetSpendRow[] | null;
    error: { message: string } | null;
  };

  /** Chain ending at `.range()`, resolving queued pages in order. */
  function fleetSpendDb(...pages: FleetSpendPage[]) {
    let call = 0;
    const builder = {
      select: vi.fn(() => builder),
      gt: vi.fn(() => builder),
      lte: vi.fn(() => builder),
      order: vi.fn(() => builder),
      range: vi.fn(async () => pages[Math.min(call++, pages.length - 1)])
    };
    return { from: vi.fn(() => builder), builder };
  }

  it("counts each business's newest row only while its one-month window covers now", async () => {
    const now = new Date("2026-07-10T12:00:00Z");
    const { from, builder } = fleetSpendDb({
      data: [
        // biz-a: newer row first, older second → older is skipped, no double count.
        { business_id: "biz-a", period_start: "2026-07-01T00:00:00Z", spend_micros: 1_000_000 },
        { business_id: "biz-a", period_start: "2026-06-01T00:00:00Z", spend_micros: 999 },
        // biz-b: older row first, replaced by the newer covering row (string spend).
        { business_id: "biz-b", period_start: "2026-06-05T00:00:00Z", spend_micros: 100 },
        { business_id: "biz-b", period_start: "2026-06-20T00:00:00Z", spend_micros: "250000" },
        // biz-c: newest window ended 2026-07-01 → rolled over, not counted.
        { business_id: "biz-c", period_start: "2026-06-01T00:00:00Z", spend_micros: 750_000 },
        // Covering windows with garbage spend clamp to 0.
        { business_id: "biz-d", period_start: "2026-07-02T00:00:00Z", spend_micros: -5 },
        { business_id: "biz-e", period_start: "2026-07-02T00:00:00Z", spend_micros: "junk" },
        { business_id: "biz-h", period_start: "2026-07-03T00:00:00Z" },
        // Malformed rows are skipped outright.
        { period_start: "2026-07-01T00:00:00Z", spend_micros: 111 },
        { business_id: "biz-f", period_start: "not-a-date", spend_micros: 222 },
        { business_id: "biz-g", spend_micros: 333 }
      ],
      error: null
    });

    const total = await getFleetCurrentAiSpendMicros({ from } as never, now);
    expect(total).toBe(1_250_000);
    // Fetch lookback is a two-month superset of any window that can cover now.
    expect(builder.gt).toHaveBeenCalledWith("period_start", "2026-05-10T12:00:00.000Z");
    expect(builder.lte).toHaveBeenCalledWith("period_start", now.toISOString());
  });

  it("pages past PostgREST's 1000-row cap instead of silently dropping spend", async () => {
    const now = new Date("2026-07-10T12:00:00Z");
    const fullPage = Array.from({ length: 1000 }, (_, i) => ({
      business_id: `biz-${i}`,
      period_start: "2026-07-01T00:00:00Z",
      spend_micros: 10
    }));
    const { from, builder } = fleetSpendDb(
      { data: fullPage, error: null },
      {
        data: [{ business_id: "biz-extra", period_start: "2026-07-01T00:00:00Z", spend_micros: 5 }],
        error: null
      }
    );

    await expect(getFleetCurrentAiSpendMicros({ from } as never, now)).resolves.toBe(10_005);
    expect(builder.range).toHaveBeenCalledTimes(2);
    expect(builder.range).toHaveBeenNthCalledWith(1, 0, 999);
    expect(builder.range).toHaveBeenNthCalledWith(2, 1000, 1999);
  });

  it("ends windows with clamped month math (a Jan 31 anchor expires Feb 28, not Mar 3)", async () => {
    const { from } = fleetSpendDb({
      data: [{ business_id: "biz-a", period_start: "2026-01-31T00:00:00Z", spend_micros: 500 }],
      error: null
    });
    // Naive month addition would keep this window alive until Mar 3.
    await expect(
      getFleetCurrentAiSpendMicros({ from } as never, new Date("2026-03-01T00:00:00Z"))
    ).resolves.toBe(0);
  });

  it("returns 0 for null data and 0 when the first page fails (best effort — dashboard must render)", async () => {
    const { from: emptyFrom } = fleetSpendDb({ data: null, error: null });
    await expect(getFleetCurrentAiSpendMicros({ from: emptyFrom } as never)).resolves.toBe(0);

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { from: errFrom } = fleetSpendDb({ data: null, error: { message: "down" } });
    await expect(getFleetCurrentAiSpendMicros({ from: errFrom } as never)).resolves.toBe(0);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("keeps already-merged pages when a later page fails instead of zeroing the rollup", async () => {
    const now = new Date("2026-07-10T12:00:00Z");
    const fullPage = Array.from({ length: 1000 }, (_, i) => ({
      business_id: `biz-${i}`,
      period_start: "2026-07-01T00:00:00Z",
      spend_micros: 10
    }));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { from } = fleetSpendDb(
      { data: fullPage, error: null },
      { data: null, error: { message: "transient" } }
    );

    await expect(getFleetCurrentAiSpendMicros({ from } as never, now)).resolves.toBe(10_000);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("creates a service client when none is passed and defaults now", async () => {
    const { from } = fleetSpendDb({
      data: [
        { business_id: "biz-a", period_start: new Date().toISOString(), spend_micros: 42 }
      ],
      error: null
    });
    mockCreateClient.mockResolvedValueOnce({ from });
    await expect(getFleetCurrentAiSpendMicros()).resolves.toBe(42);
    expect(mockCreateClient).toHaveBeenCalled();
  });

  it("exposes the per-business map (admin usage page / margin engine)", async () => {
    const now = new Date("2026-07-10T12:00:00Z");
    const { from } = fleetSpendDb({
      data: [
        { business_id: "biz-a", period_start: "2026-07-01T00:00:00Z", spend_micros: 1_000_000 },
        // Rolled-over window — omitted from the map entirely.
        { business_id: "biz-c", period_start: "2026-06-01T00:00:00Z", spend_micros: 750_000 }
      ],
      error: null
    });
    const map = await getFleetCurrentAiSpendMicrosByBusiness({ from } as never, now);
    expect(map.get("biz-a")).toBe(1_000_000);
    expect(map.has("biz-c")).toBe(false);
    expect(map.size).toBe(1);
  });

  it("by-business variant creates a service client and defaults now on its own", async () => {
    const { from } = fleetSpendDb({
      data: [
        { business_id: "biz-a", period_start: new Date().toISOString(), spend_micros: 7 }
      ],
      error: null
    });
    mockCreateClient.mockResolvedValueOnce({ from });
    const map = await getFleetCurrentAiSpendMicrosByBusiness();
    expect(map.get("biz-a")).toBe(7);
    expect(mockCreateClient).toHaveBeenCalled();
  });
});

describe("getSmsBonusTextsRemaining", () => {
  afterEach(() => vi.clearAllMocks());

  it("returns the floored RPC value", async () => {
    const db = stubDb({ rpcResults: { sms_bonus_texts_remaining: { data: 412.7, error: null } } });
    await expect(getSmsBonusTextsRemaining("biz-1", db as never)).resolves.toBe(412);
  });

  it("returns 0 when the RPC returns null data", async () => {
    const db = stubDb({ rpcResults: { sms_bonus_texts_remaining: { data: null, error: null } } });
    await expect(getSmsBonusTextsRemaining("biz-1", db as never)).resolves.toBe(0);
  });

  it("returns 0 on error, negative, or non-finite values", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const dbErr = stubDb({ rpcResults: { sms_bonus_texts_remaining: { data: null, error: { message: "x" } } } });
    await expect(getSmsBonusTextsRemaining("biz-1", dbErr as never)).resolves.toBe(0);
    expect(errSpy).toHaveBeenCalled();

    const dbNeg = stubDb({ rpcResults: { sms_bonus_texts_remaining: { data: -3, error: null } } });
    await expect(getSmsBonusTextsRemaining("biz-1", dbNeg as never)).resolves.toBe(0);

    const dbNaN = stubDb({ rpcResults: { sms_bonus_texts_remaining: { data: "zzz", error: null } } });
    await expect(getSmsBonusTextsRemaining("biz-1", dbNaN as never)).resolves.toBe(0);
    errSpy.mockRestore();
  });

  it("creates a service client when none is passed", async () => {
    const db = stubDb({ rpcResults: { sms_bonus_texts_remaining: { data: 5, error: null } } });
    mockCreateClient.mockResolvedValueOnce(db);
    await expect(getSmsBonusTextsRemaining("biz-1")).resolves.toBe(5);
    expect(mockCreateClient).toHaveBeenCalled();
  });
});
