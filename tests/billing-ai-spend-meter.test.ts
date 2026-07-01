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
  businessRow?: unknown;
  creditResult?: DbResult;
  recordResult?: DbResult;
  markResult?: DbResult;
}) {
  const rpc = vi.fn(async (fn: string, _args?: Record<string, unknown>) => {
    if (fn === "chat_active_credit_micros") return opts.creditResult ?? { data: 0, error: null };
    if (fn === "mark_usage_cap_alert") return opts.markResult ?? { data: false, error: null };
    if (fn === "unmark_usage_cap_alert") return { data: null, error: null };
    return opts.recordResult ?? { data: null, error: null };
  });
  const from = vi.fn((table: string) => {
    const builder = {
      select: () => builder,
      eq: () => builder,
      order: () => builder,
      limit: () => builder,
      maybeSingle: async () =>
        table === "businesses"
          ? { data: opts.businessRow ?? null, error: null }
          : { data: opts.subscriptionRow ?? null, error: null }
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
    expect(geminiPriceFor(" gemini-3.5-flash ")).toEqual({ in: 1.5, out: 9.0 });
  });

  it("falls back to the priciest deployed tier (gemini-3.5-flash) for unknown models", () => {
    expect(geminiPriceFor("gemini-99-ultra")).toBe(DEFAULT_GEMINI_PRICE_PER_1M);
    expect(DEFAULT_GEMINI_PRICE_PER_1M).toEqual({ in: 1.5, out: 9.0 });
  });

  it("carries modality-aware audio rates for the Gemini Live voice model", () => {
    expect(geminiPriceFor("gemini-3.1-flash-live-preview")).toEqual({
      in: 0.75,
      out: 4.5,
      audioIn: 3.0,
      audioOut: 12.0
    });
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

  it("prices the AUDIO portion at the audio rate and the text remainder at the text rate (Gemini Live)", () => {
    // 10k prompt tokens: 9k audio @ $3/1M + 1k text @ $0.75/1M.
    // 20k output tokens: 19.5k audio @ $12/1M + 500 text @ $4.5/1M.
    expect(
      geminiCostMicrosFromUsage("gemini-3.1-flash-live-preview", {
        promptTokens: 10_000,
        outputTokens: 20_000,
        promptAudioTokens: 9_000,
        outputAudioTokens: 19_500
      })
    ).toBe(
      Math.ceil(
        1_000 * 0.75 + 9_000 * 3.0 + 500 * 4.5 + 19_500 * 12.0
      )
    );
  });

  it("treats all tokens as text when no audio split is provided (back-compat)", () => {
    // Same Live model, but no audio fields → everything on the text rate.
    expect(
      geminiCostMicrosFromUsage("gemini-3.1-flash-live-preview", {
        promptTokens: 1_000,
        outputTokens: 500
      })
    ).toBe(Math.ceil(1_000 * 0.75 + 500 * 4.5));
  });

  it("clamps audio tokens to their totals so a malformed split can't over/under-count", () => {
    // Audio counts exceed the totals → clamp to the totals (all audio-priced).
    expect(
      geminiCostMicrosFromUsage("gemini-3.1-flash-live-preview", {
        promptTokens: 100,
        outputTokens: 200,
        promptAudioTokens: 999,
        outputAudioTokens: 999
      })
    ).toBe(Math.ceil(100 * 3.0 + 200 * 12.0));
  });

  it("uses the text rate for audio tokens on a model without audio rates (fallback)", () => {
    // gemini-2.5-flash has no audioIn/audioOut → audio tokens price at in/out.
    expect(
      geminiCostMicrosFromUsage("gemini-2.5-flash", {
        promptTokens: 1_000,
        outputTokens: 500,
        promptAudioTokens: 400,
        outputAudioTokens: 200
      })
    ).toBe(Math.ceil(1_000 * 0.3 + 500 * 2.5));
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
  const savedSbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const savedSvcKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  beforeEach(() => {
    delete process.env.OWNER_CHAT_SPEND_CAP_MICROS;
  });

  afterEach(() => {
    if (savedCap === undefined) delete process.env.OWNER_CHAT_SPEND_CAP_MICROS;
    else process.env.OWNER_CHAT_SPEND_CAP_MICROS = savedCap;
    if (savedSbUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    else process.env.NEXT_PUBLIC_SUPABASE_URL = savedSbUrl;
    if (savedSvcKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = savedSvcKey;
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

  it("trips against the $5 starter base cap for starter tenants", async () => {
    const db = stubDb({
      businessRow: { tier: "starter" },
      creditResult: { data: 0, error: null }
    });

    await meterGeminiSpendForBusiness({
      businessId: "biz-1",
      model: "gemini-2.5-flash-lite",
      surface: "knowledge_lookup",
      usage: { promptTokens: 100, outputTokens: 10 },
      client: db as never
    });

    const call = db.rpc.mock.calls.find((c) => c[0] === "owner_chat_record_spend");
    expect((call![1] as Record<string, unknown>).p_cap_micros).toBe(5_000_000);
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

  it("sends a one-time owner alert when the shared spend cap is newly tripped", async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://sb.example";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "svc-key";
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 200 }));
    const db = stubDb({
      subscriptionRow: { stripe_current_period_start: "2026-05-29T21:33:49+00:00" },
      recordResult: { data: [{ spend_micros: 10_000_050, fuse_newly_tripped: true }], error: null },
      markResult: { data: true, error: null }
    });

    await meterGeminiSpendForBusiness({
      businessId: "biz-1",
      model: "gemini-2.5-flash-lite",
      surface: "vps_rowboat",
      usage: { promptTokens: 100, outputTokens: 10 },
      client: db as never
    });

    // Dedupe claim keyed by the subscription period start, then the urgent post.
    expect(db.rpc).toHaveBeenCalledWith("mark_usage_cap_alert", {
      p_business_id: "biz-1",
      p_cap_kind: "chat_spend",
      p_period_key: "2026-05-29T21:33:49+00:00"
    });
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://sb.example/functions/v1/notifications",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("tolerates missing notify env and absent spend_micros in the alert payload", async () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 200 }));
    const db = stubDb({
      // fuse tripped but the RPC row carries no spend_micros → payload null.
      recordResult: { data: [{ fuse_newly_tripped: true }], error: null },
      markResult: { data: true, error: null }
    });

    await meterGeminiSpendForBusiness({
      businessId: "biz-1",
      model: "gemini-2.5-flash-lite",
      surface: "vps_rowboat",
      usage: { promptTokens: 100, outputTokens: 10 },
      client: db as never
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      "/functions/v1/notifications",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("does not alert when the fuse was already tripped (no new crossing)", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 200 }));
    const db = stubDb({
      recordResult: { data: [{ spend_micros: 10_000_050, fuse_newly_tripped: false }], error: null }
    });

    await meterGeminiSpendForBusiness({
      businessId: "biz-1",
      model: "gemini-2.5-flash-lite",
      surface: "vps_rowboat",
      usage: { promptTokens: 100, outputTokens: 10 },
      client: db as never
    });

    expect(db.rpc).not.toHaveBeenCalledWith("mark_usage_cap_alert", expect.anything());
    expect(fetchSpy).not.toHaveBeenCalled();
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
