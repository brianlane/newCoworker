import { describe, expect, it } from "vitest";
import {
  DEFAULT_CHAT_SPEND_CAP_MICROS,
  DEFAULT_GEMINI_PRICE_PER_1M,
  STARTER_CHAT_SPEND_CAP_MICROS,
  capMicrosForTier,
  geminiCostMicrosFromTokens,
  monthStartIso,
  pickSmsTurn,
  readActiveChatCreditMicros,
  readChatSpendMicros,
  resolveSmsChatCap,
  type SpendSupabase
} from "../supabase/functions/_shared/chat_spend_cap";
import { callRowboatChatOnce } from "../supabase/functions/_shared/sms_rowboat";

// --- geminiCostMicrosFromTokens ------------------------------------------------

describe("geminiCostMicrosFromTokens", () => {
  it("bills exact tokens at the model's list price (trimming whitespace)", () => {
    // flash-lite: 0.1 micro per prompt token, 0.4 per output token.
    expect(geminiCostMicrosFromTokens(" gemini-2.5-flash-lite ", 1000, 500)).toBe(
      Math.ceil(1000 * 0.1 + 500 * 0.4)
    );
    // 2.5 flash is 3x in / 6.25x out vs flash-lite.
    expect(geminiCostMicrosFromTokens("gemini-2.5-flash", 1000, 500)).toBe(
      Math.ceil(1000 * 0.3 + 500 * 2.5)
    );
  });

  it("falls back to the priciest deployed tier for unknown models", () => {
    expect(geminiCostMicrosFromTokens("gemini-99-ultra", 1000, 100)).toBe(
      Math.ceil(1000 * DEFAULT_GEMINI_PRICE_PER_1M.in + 100 * DEFAULT_GEMINI_PRICE_PER_1M.out)
    );
  });

  it("prices the (voice-path, defensively listed) 3.1 models in the flash tier, not the default", () => {
    // 0.5 in / 3.0 out — same as gemini-3-flash, and cheaper than the 1.5/9.0
    // unknown-model default that a missing entry would have hit.
    expect(geminiCostMicrosFromTokens("gemini-3.1-flash", 1000, 100)).toBe(
      Math.ceil(1000 * 0.5 + 100 * 3.0)
    );
    expect(geminiCostMicrosFromTokens("gemini-3.1-flash-live-preview", 1000, 100)).toBe(
      Math.ceil(1000 * 0.5 + 100 * 3.0)
    );
  });

  it("clamps negative token counts to zero", () => {
    expect(geminiCostMicrosFromTokens("gemini-2.5-flash-lite", -10, 10)).toBe(4);
    expect(geminiCostMicrosFromTokens("gemini-2.5-flash-lite", 10, -10)).toBe(1);
  });
});

// --- capMicrosForTier --------------------------------------------------------

describe("capMicrosForTier", () => {
  it("returns the starter base for starter, the standard base otherwise", () => {
    expect(capMicrosForTier("starter", 10_000_000)).toBe(STARTER_CHAT_SPEND_CAP_MICROS);
    expect(capMicrosForTier("starter", 10_000_000)).toBe(5_000_000);
    expect(capMicrosForTier("standard", 10_000_000)).toBe(10_000_000);
    expect(capMicrosForTier("enterprise", 10_000_000)).toBe(10_000_000);
    expect(capMicrosForTier(null, DEFAULT_CHAT_SPEND_CAP_MICROS)).toBe(10_000_000);
  });

  it("honors an explicit starter override", () => {
    expect(capMicrosForTier("starter", 10_000_000, 3_000_000)).toBe(3_000_000);
  });
});

// --- pickSmsTurn -------------------------------------------------------------

describe("pickSmsTurn", () => {
  it("under cap: Gemini agent, stateful, metered", () => {
    expect(
      pickSmsTurn({ overCap: false, geminiAgent: "Coworker", localAgent: "CoworkerLocal" })
    ).toEqual({ startAgent: "Coworker", stateless: false, meter: true });
  });

  it("over cap: local agent, stateless, NOT metered", () => {
    expect(
      pickSmsTurn({ overCap: true, geminiAgent: "Coworker", localAgent: "CoworkerLocal" })
    ).toEqual({ startAgent: "CoworkerLocal", stateless: true, meter: false });
  });

  it("over cap with no local agent configured: stays on Gemini (fail open)", () => {
    expect(
      pickSmsTurn({ overCap: true, geminiAgent: "Coworker", localAgent: "" })
    ).toEqual({ startAgent: "Coworker", stateless: false, meter: true });
  });

  it("empty gemini agent → startAgent null (omit, use workflow default)", () => {
    expect(
      pickSmsTurn({ overCap: false, geminiAgent: "", localAgent: "CoworkerLocal" })
    ).toEqual({ startAgent: null, stateless: false, meter: true });
  });
});

describe("monthStartIso", () => {
  it("returns the first of the month at UTC midnight", () => {
    expect(monthStartIso(new Date("2026-06-07T10:11:12.000Z"))).toBe(
      "2026-06-01T00:00:00.000Z"
    );
  });

  it("defaults to now when called with no argument", () => {
    expect(monthStartIso()).toMatch(/^\d{4}-\d{2}-01T00:00:00\.000Z$/);
  });
});

// --- Supabase stub -----------------------------------------------------------

type Scenario = {
  // subscriptions.stripe_current_period_start (maybeSingle on subscriptions)
  periodStart?: string | null;
  // make the subscriptions read reject (exercise resolveChatPeriodStart catch)
  periodThrows?: boolean;
  // owner_chat_model_spend.spend_micros (maybeSingle on owner_chat_model_spend)
  spendMicros?: number | null;
  spendError?: string;
  // chat_active_credit_micros rpc result (purchased Gemini credit)
  creditMicros?: unknown;
  creditError?: string;
  creditThrows?: boolean;
};

function makeStub(s: Scenario) {
  const calls = {
    rpc: [] as Array<{ fn: string; args: Record<string, unknown> }>
  };

  function builder(table: string) {
    const api = {
      select() {
        return api;
      },
      eq() {
        return api;
      },
      order() {
        return api;
      },
      limit() {
        return api;
      },
      maybeSingle() {
        if (table === "subscriptions") {
          if (s.periodThrows) {
            return Promise.reject(new Error("subscriptions read failed"));
          }
          return Promise.resolve({
            data:
              s.periodStart === undefined
                ? null
                : { stripe_current_period_start: s.periodStart },
            error: null
          });
        }
        if (table === "owner_chat_model_spend") {
          if (s.spendError) {
            return Promise.resolve({ data: null, error: { message: s.spendError } });
          }
          return Promise.resolve({
            data: s.spendMicros == null ? null : { spend_micros: s.spendMicros },
            error: null
          });
        }
        return Promise.resolve({ data: null, error: null });
      }
    };
    return api;
  }

  const stub: SpendSupabase & { _calls: typeof calls } = {
    from(table: string) {
      return builder(table) as unknown as ReturnType<SpendSupabase["from"]>;
    },
    rpc(fn: string, args: Record<string, unknown>) {
      calls.rpc.push({ fn, args });
      if (fn === "chat_active_credit_micros") {
        if (s.creditThrows) return Promise.reject(new Error("credit read failed"));
        if (s.creditError) {
          return Promise.resolve({ data: null, error: { message: s.creditError } });
        }
        return Promise.resolve({ data: s.creditMicros ?? null, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    },
    _calls: calls
  };
  return stub;
}

// --- resolveSmsChatCap -------------------------------------------------------

describe("resolveSmsChatCap", () => {
  it("disabled → never over cap, no period", async () => {
    const stub = makeStub({});
    const d = await resolveSmsChatCap(stub, "biz", { capMicros: 10_000_000, enabled: false });
    expect(d).toEqual({ periodStart: null, overCap: false, effectiveCapMicros: 10_000_000 });
    expect(stub._calls.rpc).toHaveLength(0);
  });

  it("under cap → overCap false with resolved period", async () => {
    const stub = makeStub({ periodStart: "2026-06-01T00:00:00.000Z", spendMicros: 5_000_000 });
    const d = await resolveSmsChatCap(stub, "biz", { capMicros: 10_000_000, enabled: true });
    expect(d.overCap).toBe(false);
    expect(d.periodStart).toBe("2026-06-01T00:00:00.000Z");
  });

  it("at/over cap → overCap true", async () => {
    const stub = makeStub({ periodStart: "2026-06-01T00:00:00.000Z", spendMicros: 10_000_000 });
    const d = await resolveSmsChatCap(stub, "biz", { capMicros: 10_000_000, enabled: true });
    expect(d.overCap).toBe(true);
  });

  it("fails open (overCap false) when the spend read errors", async () => {
    const stub = makeStub({ periodStart: "2026-06-01T00:00:00.000Z", spendError: "boom" });
    const d = await resolveSmsChatCap(stub, "biz", { capMicros: 10_000_000, enabled: true });
    expect(d).toEqual({ periodStart: null, overCap: false, effectiveCapMicros: 10_000_000 });
  });

  it("purchased credit raises the effective cap (over base, under base+credit → Gemini)", async () => {
    const stub = makeStub({
      periodStart: "2026-06-01T00:00:00.000Z",
      spendMicros: 12_000_000,
      creditMicros: 5_000_000
    });
    const d = await resolveSmsChatCap(stub, "biz", { capMicros: 10_000_000, enabled: true });
    expect(d.overCap).toBe(false);
    expect(d.effectiveCapMicros).toBe(15_000_000);
  });

  it("over base+credit → overCap true", async () => {
    const stub = makeStub({
      periodStart: "2026-06-01T00:00:00.000Z",
      spendMicros: 15_000_000,
      creditMicros: 5_000_000
    });
    const d = await resolveSmsChatCap(stub, "biz", { capMicros: 10_000_000, enabled: true });
    expect(d.overCap).toBe(true);
  });

  it("falls back to the UTC month start when there's no subscription period", async () => {
    const stub = makeStub({ spendMicros: 0 }); // periodStart undefined → no sub row
    const d = await resolveSmsChatCap(stub, "biz", { capMicros: 10_000_000, enabled: true });
    expect(d.overCap).toBe(false);
    expect(d.periodStart).toMatch(/^\d{4}-\d{2}-01T00:00:00\.000Z$/);
  });

  it("falls back to the UTC month start when the subscription read throws", async () => {
    const stub = makeStub({ periodThrows: true, spendMicros: 0 });
    const d = await resolveSmsChatCap(stub, "biz", { capMicros: 10_000_000, enabled: true });
    expect(d.periodStart).toMatch(/^\d{4}-\d{2}-01T00:00:00\.000Z$/);
  });
});

describe("readActiveChatCreditMicros", () => {
  it("returns the credit when positive", async () => {
    const stub = makeStub({ creditMicros: 5_000_000 });
    expect(await readActiveChatCreditMicros(stub, "biz")).toBe(5_000_000);
  });

  it("returns 0 for null / non-finite / non-positive values", async () => {
    expect(await readActiveChatCreditMicros(makeStub({ creditMicros: null }), "biz")).toBe(0);
    expect(await readActiveChatCreditMicros(makeStub({ creditMicros: -5 }), "biz")).toBe(0);
    expect(await readActiveChatCreditMicros(makeStub({ creditMicros: "zzz" }), "biz")).toBe(0);
  });

  it("returns 0 on rpc error (base cap still applies)", async () => {
    const stub = makeStub({ creditError: "rpc down" });
    expect(await readActiveChatCreditMicros(stub, "biz")).toBe(0);
  });

  it("returns 0 when the rpc throws", async () => {
    const stub = makeStub({ creditThrows: true });
    expect(await readActiveChatCreditMicros(stub, "biz")).toBe(0);
  });
});

describe("readChatSpendMicros", () => {
  it("returns 0 when no row exists", async () => {
    const stub = makeStub({ spendMicros: null });
    expect(await readChatSpendMicros(stub, "biz", "2026-06-01T00:00:00.000Z")).toBe(0);
  });
  it("throws on a hard read error", async () => {
    const stub = makeStub({ spendError: "db down" });
    await expect(readChatSpendMicros(stub, "biz", "2026-06-01T00:00:00.000Z")).rejects.toThrow(
      "db down"
    );
  });
});

// --- sms_rowboat startAgent passing -----------------------------------------

describe("callRowboatChatOnce startAgent", () => {
  function captureFetch(captured: { body?: Record<string, unknown> }) {
    return (async (_url: string, init?: RequestInit) => {
      captured.body = JSON.parse(String(init?.body ?? "{}"));
      return new Response(
        JSON.stringify({ turn: { output: [{ role: "assistant", content: "hi" }] } }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }) as unknown as typeof fetch;
  }

  it("includes startAgent in the chat body when provided", async () => {
    const captured: { body?: Record<string, unknown> } = {};
    await callRowboatChatOnce(
      {
        chatUrl: "https://x/chat",
        bearer: "t",
        userText: "hello",
        conversationId: null,
        state: null,
        timeoutMs: 1000,
        startAgent: "CoworkerLocal"
      },
      captureFetch(captured)
    );
    expect(captured.body?.startAgent).toBe("CoworkerLocal");
  });

  it("omits startAgent when not provided", async () => {
    const captured: { body?: Record<string, unknown> } = {};
    await callRowboatChatOnce(
      {
        chatUrl: "https://x/chat",
        bearer: "t",
        userText: "hello",
        conversationId: null,
        state: null,
        timeoutMs: 1000
      },
      captureFetch(captured)
    );
    expect(captured.body && "startAgent" in captured.body).toBe(false);
  });
});
