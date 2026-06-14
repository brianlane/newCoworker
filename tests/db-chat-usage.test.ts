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
  businessRow?: unknown;
  creditResult?: MaybeSingleResult;
  rpcResults?: Record<string, MaybeSingleResult>;
}) {
  const tables: Record<string, MaybeSingleResult> = {
    subscriptions: { data: opts.subscriptionRow ?? null, error: null },
    owner_chat_model_spend: { data: opts.spendRow ?? null, error: null },
    businesses: { data: opts.businessRow ?? null, error: null }
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

  it("uses the $5 starter base when tier is passed explicitly", async () => {
    const db = stubDb({ spendRow: { spend_micros: "1000000" } });

    const snap = await getChatSpendSnapshotForBusiness("biz-1", db as never, "starter");

    expect(snap.baseCapMicros).toBe(5_000_000);
    expect(snap.effectiveCapMicros).toBe(5_000_000);
  });

  it("resolves the tier from businesses.tier when not passed", async () => {
    const db = stubDb({ businessRow: { tier: "starter" } });

    const snap = await getChatSpendSnapshotForBusiness("biz-1", db as never);

    expect(snap.baseCapMicros).toBe(5_000_000);
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
