import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockCreateClient = vi.hoisted(() => vi.fn());
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: mockCreateClient
}));

import {
  DEFAULT_GEMINI_PRICE_PER_1M,
  GEMINI_PRICES_PER_1M,
  estimateGeminiCostMicrosFromChars,
  geminiCostMicrosFromUsage,
  geminiPriceFor,
  meterGeminiSpendForBusiness
} from "@/lib/billing/ai-spend-meter";

type DbResult = { data: unknown; error: { message: string } | null };

function stubDb(opts: {
  subscriptionRow?: unknown;
  creditResult?: DbResult;
  recordResult?: DbResult;
}) {
  const rpc = vi.fn(async (fn: string, _args?: Record<string, unknown>) => {
    if (fn === "chat_active_credit_micros") return opts.creditResult ?? { data: 0, error: null };
    return opts.recordResult ?? { data: null, error: null };
  });
  const from = vi.fn(() => {
    const builder = {
      select: () => builder,
      eq: () => builder,
      order: () => builder,
      limit: () => builder,
      maybeSingle: async () => ({ data: opts.subscriptionRow ?? null, error: null })
    };
    return builder;
  });
  return { from, rpc };
}

describe("geminiPriceFor", () => {
  it("returns the listed price for known models (trimming whitespace)", () => {
    expect(geminiPriceFor(" gemini-2.5-flash-lite ")).toEqual({ in: 0.1, out: 0.4 });
    expect(geminiPriceFor("gemini-2.5-flash")).toEqual({ in: 0.3, out: 2.5 });
    expect(geminiPriceFor("gemini-3-flash-preview")).toEqual(
      GEMINI_PRICES_PER_1M["gemini-3-flash"]
    );
  });

  it("falls back to the priciest deployed tier for unknown models", () => {
    expect(geminiPriceFor("gemini-99-ultra")).toBe(DEFAULT_GEMINI_PRICE_PER_1M);
  });
});

describe("geminiCostMicrosFromUsage", () => {
  it("bills prompt tokens at the input rate and output tokens at the output rate", () => {
    // flash-lite: 1M in = $0.10 → 1 token = 0.1 micro; out 0.4 micro/token.
    expect(
      geminiCostMicrosFromUsage("gemini-2.5-flash-lite", { promptTokens: 1000, outputTokens: 500 })
    ).toBe(Math.ceil(1000 * 0.1 + 500 * 0.4));
  });

  it("clamps negative token counts to 0", () => {
    expect(
      geminiCostMicrosFromUsage("gemini-2.5-flash", { promptTokens: -10, outputTokens: 4 })
    ).toBe(10);
    expect(
      geminiCostMicrosFromUsage("gemini-2.5-flash", { promptTokens: 4, outputTokens: -10 })
    ).toBe(2);
  });
});

describe("estimateGeminiCostMicrosFromChars", () => {
  it("estimates tokens as chars/4 at the model's price", () => {
    expect(estimateGeminiCostMicrosFromChars("gemini-2.5-flash", 4000, 400)).toBe(
      Math.ceil(1000 * 0.3 + 100 * 2.5)
    );
  });

  it("clamps negative char counts to 0", () => {
    expect(estimateGeminiCostMicrosFromChars("gemini-2.5-flash-lite", -8, -8)).toBe(0);
  });
});

describe("meterGeminiSpendForBusiness", () => {
  const savedCap = process.env.OWNER_CHAT_SPEND_CAP_MICROS;

  beforeEach(() => {
    delete process.env.OWNER_CHAT_SPEND_CAP_MICROS;
  });

  afterEach(() => {
    if (savedCap === undefined) delete process.env.OWNER_CHAT_SPEND_CAP_MICROS;
    else process.env.OWNER_CHAT_SPEND_CAP_MICROS = savedCap;
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it("records exact usage-based cost against the Stripe period with credit-raised cap", async () => {
    const db = stubDb({
      subscriptionRow: { stripe_current_period_start: "2026-05-29T21:33:49+00:00" },
      creditResult: { data: 5_000_000, error: null }
    });

    await meterGeminiSpendForBusiness({
      businessId: "biz-1",
      model: "gemini-3-flash-preview",
      surface: "website_ingest",
      usage: { promptTokens: 10_000, outputTokens: 1_000 },
      client: db as never
    });

    expect(db.rpc).toHaveBeenCalledWith("owner_chat_record_spend", {
      p_business_id: "biz-1",
      p_period_start: "2026-05-29T21:33:49+00:00",
      p_cost_micros: Math.ceil(10_000 * 0.5 + 1_000 * 3.0),
      p_cap_micros: 15_000_000
    });
  });

  it("falls back to a chars/4 estimate and UTC month-start period without usage/subscription", async () => {
    const db = stubDb({ creditResult: { data: null, error: null } });

    await meterGeminiSpendForBusiness({
      businessId: "biz-1",
      model: "gemini-2.5-flash",
      surface: "aiflow_compile",
      inputChars: 4000,
      outputChars: 400,
      client: db as never
    });

    const call = db.rpc.mock.calls.find((c) => c[0] === "owner_chat_record_spend");
    expect(call).toBeDefined();
    const args = call![1] as Record<string, unknown>;
    expect(String(args.p_period_start)).toMatch(/^\d{4}-\d{2}-01T00:00:00\.000Z$/);
    expect(args.p_cost_micros).toBe(Math.ceil(1000 * 0.3 + 100 * 2.5));
    expect(args.p_cap_micros).toBe(10_000_000);
  });

  it("defaults missing inputChars/outputChars to 0 and skips the zero-cost write", async () => {
    const db = stubDb({});
    await meterGeminiSpendForBusiness({
      businessId: "biz-1",
      model: "gemini-2.5-flash",
      surface: "aiflow_compile",
      client: db as never
    });
    expect(db.rpc).not.toHaveBeenCalled();
    expect(db.from).not.toHaveBeenCalled();
  });

  it("ignores a credit read error (base cap only)", async () => {
    const db = stubDb({ creditResult: { data: null, error: { message: "boom" } } });
    await meterGeminiSpendForBusiness({
      businessId: "biz-1",
      model: "gemini-2.5-flash-lite",
      surface: "knowledge_lookup",
      usage: { promptTokens: 100, outputTokens: 10 },
      client: db as never
    });
    const call = db.rpc.mock.calls.find((c) => c[0] === "owner_chat_record_spend");
    expect((call![1] as Record<string, unknown>).p_cap_micros).toBe(10_000_000);
  });

  it("ignores non-positive credit values", async () => {
    const db = stubDb({ creditResult: { data: -5, error: null } });
    await meterGeminiSpendForBusiness({
      businessId: "biz-1",
      model: "gemini-2.5-flash-lite",
      surface: "knowledge_lookup",
      usage: { promptTokens: 100, outputTokens: 10 },
      client: db as never
    });
    const call = db.rpc.mock.calls.find((c) => c[0] === "owner_chat_record_spend");
    expect((call![1] as Record<string, unknown>).p_cap_micros).toBe(10_000_000);
  });

  it("never throws when the spend RPC fails (logs instead)", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const db = stubDb({ recordResult: { data: null, error: { message: "rpc down" } } });
    await expect(
      meterGeminiSpendForBusiness({
        businessId: "biz-1",
        model: "gemini-2.5-flash",
        surface: "aiflow_compile",
        usage: { promptTokens: 1, outputTokens: 1 },
        client: db as never
      })
    ).resolves.toBeUndefined();
    expect(errSpy).toHaveBeenCalledWith("meterGeminiSpendForBusiness(aiflow_compile)", "rpc down");
  });

  it("never throws on unexpected non-Error failures", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const db = {
      from: vi.fn(() => {
        throw "weird";
      }),
      rpc: vi.fn()
    };
    await expect(
      meterGeminiSpendForBusiness({
        businessId: "biz-1",
        model: "gemini-2.5-flash",
        surface: "aiflow_compile",
        usage: { promptTokens: 1, outputTokens: 1 },
        client: db as never
      })
    ).resolves.toBeUndefined();
    expect(errSpy).toHaveBeenCalledWith("meterGeminiSpendForBusiness(aiflow_compile)", "weird");
  });

  it("creates a service client when none is injected", async () => {
    const db = stubDb({});
    mockCreateClient.mockResolvedValue(db as never);
    await meterGeminiSpendForBusiness({
      businessId: "biz-1",
      model: "gemini-2.5-flash-lite",
      surface: "knowledge_lookup",
      usage: { promptTokens: 100, outputTokens: 10 }
    });
    expect(mockCreateClient).toHaveBeenCalledOnce();
    expect(db.rpc).toHaveBeenCalledWith("owner_chat_record_spend", expect.anything());
  });
});
