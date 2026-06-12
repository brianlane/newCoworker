import { describe, expect, it } from "vitest";
import {
  estimateChatCostMicros,
  monthStartIso,
  pickSmsTurn,
  readActiveChatCreditMicros,
  readChatSpendMicros,
  recordSmsChatSpend,
  resolveSmsChatCap,
  type SpendSupabase
} from "../supabase/functions/_shared/chat_spend_cap";
import { callRowboatChatOnce } from "../supabase/functions/_shared/sms_rowboat";

// --- estimateChatCostMicros --------------------------------------------------

describe("estimateChatCostMicros", () => {
  it("computes inTokens*priceIn + outTokens*priceOut (chars/4), overhead-free", () => {
    // 400 chars => 100 tokens each side. 100*0.1 + 100*0.4 = 50 micros.
    const cost = estimateChatCostMicros(400, 400, {
      priceInPer1M: 0.1,
      priceOutPer1M: 0.4,
      promptOverheadTokens: 0
    });
    expect(cost).toBe(50);
  });

  it("adds the flat prompt overhead to the input side", () => {
    // inTokens = 100 + 1200 = 1300; 1300*0.1 + 100*0.4 = 170.
    const cost = estimateChatCostMicros(400, 400, {
      priceInPer1M: 0.1,
      priceOutPer1M: 0.4,
      promptOverheadTokens: 1200
    });
    expect(cost).toBe(170);
  });

  it("clamps negative inputs to zero", () => {
    expect(
      estimateChatCostMicros(-100, -100, { promptOverheadTokens: 0 })
    ).toBe(0);
  });

  it("uses all defaults when no config is passed", () => {
    // defaults: priceIn 0.1, priceOut 0.4, overhead 1200.
    // inTokens = 100 + 1200 = 1300; 1300*0.1 + 100*0.4 = 170.
    expect(estimateChatCostMicros(400, 400)).toBe(170);
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
  // result of the metered_at claim (update...select("id") on sms_inbound_jobs)
  claimRows?: Array<{ id: string }>;
  // make the claim return a non-array `data` (exercise the Array.isArray false side)
  claimDataNonArray?: boolean;
  claimError?: string;
  // owner_chat_record_spend rpc result
  rpc?: { data: unknown; error: { message: string } | null };
  // chat_active_credit_micros rpc result (purchased Gemini credit)
  creditMicros?: unknown;
  creditError?: string;
  creditThrows?: boolean;
};

function makeStub(s: Scenario) {
  const calls = {
    rpc: [] as Array<{ fn: string; args: Record<string, unknown> }>,
    meteredAtSet: [] as Array<unknown>
  };

  function builder(table: string) {
    let op: "select" | "update" = "select";
    let values: Record<string, unknown> | null = null;

    const api = {
      select() {
        return api;
      },
      update(v: Record<string, unknown>) {
        op = "update";
        values = v;
        return api;
      },
      eq() {
        return api;
      },
      is() {
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
      },
      // Awaitable builder (used by update(...).select("id") + release update).
      then(
        resolve: (v: { data: unknown; error: { message: string } | null }) => unknown,
        reject?: (e: unknown) => unknown
      ) {
        let result: { data: unknown; error: { message: string } | null };
        if (table === "sms_inbound_jobs" && op === "update") {
          const meteredAt = (values ?? {}).metered_at;
          calls.meteredAtSet.push(meteredAt);
          if (meteredAt == null) {
            // release path
            result = { data: null, error: null };
          } else if (s.claimError) {
            result = { data: null, error: { message: s.claimError } };
          } else if (s.claimDataNonArray) {
            result = { data: null, error: null };
          } else {
            result = { data: s.claimRows ?? [{ id: "job-1" }], error: null };
          }
        } else {
          result = { data: null, error: null };
        }
        return Promise.resolve(result).then(resolve, reject);
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
      return Promise.resolve(s.rpc ?? { data: null, error: null });
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

// --- recordSmsChatSpend ------------------------------------------------------

describe("recordSmsChatSpend", () => {
  const base = {
    jobId: "job-1",
    businessId: "biz",
    periodStart: "2026-06-01T00:00:00.000Z",
    inputChars: 400,
    outputChars: 400,
    capMicros: 10_000_000,
    costConfig: { priceInPer1M: 0.1, priceOutPer1M: 0.4, promptOverheadTokens: 0 }
  };

  it("disabled → no claim, no rpc", async () => {
    const stub = makeStub({});
    const r = await recordSmsChatSpend(stub, { ...base, enabled: false });
    expect(r).toEqual({ metered: false, reason: "disabled" });
    expect(stub._calls.rpc).toHaveLength(0);
    expect(stub._calls.meteredAtSet).toHaveLength(0);
  });

  it("happy path: claims metered_at, records spend, returns total + cost", async () => {
    const stub = makeStub({
      claimRows: [{ id: "job-1" }],
      rpc: { data: [{ spend_micros: 50, turn_count: 1, fuse_newly_tripped: false }], error: null }
    });
    const r = await recordSmsChatSpend(stub, { ...base, enabled: true });
    expect(r.metered).toBe(true);
    expect(r.costMicros).toBe(50);
    expect(r.spendMicros).toBe(50);
    expect(r.fuseNewlyTripped).toBe(false);
    const spendCall = stub._calls.rpc.find((c) => c.fn === "owner_chat_record_spend");
    expect(spendCall?.args).toMatchObject({
      p_business_id: "biz",
      p_period_start: "2026-06-01T00:00:00.000Z",
      p_cost_micros: 50,
      p_cap_micros: 10_000_000
    });
  });

  it("passes base + purchased credit as p_cap_micros so the fuse trips at the raised cap", async () => {
    const stub = makeStub({
      claimRows: [{ id: "job-1" }],
      creditMicros: 5_000_000,
      rpc: { data: [{ spend_micros: 50, fuse_newly_tripped: false }], error: null }
    });
    const r = await recordSmsChatSpend(stub, { ...base, enabled: true });
    expect(r.metered).toBe(true);
    const spendCall = stub._calls.rpc.find((c) => c.fn === "owner_chat_record_spend");
    expect(spendCall?.args.p_cap_micros).toBe(15_000_000);
  });

  it("surfaces fuse_newly_tripped", async () => {
    const stub = makeStub({
      claimRows: [{ id: "job-1" }],
      rpc: { data: [{ spend_micros: 10_000_050, fuse_newly_tripped: true }], error: null }
    });
    const r = await recordSmsChatSpend(stub, { ...base, enabled: true });
    expect(r.fuseNewlyTripped).toBe(true);
  });

  it("handles a non-array (object) rpc result and a null row", async () => {
    const objStub = makeStub({
      claimRows: [{ id: "job-1" }],
      rpc: { data: { spend_micros: 50, fuse_newly_tripped: false }, error: null }
    });
    const r1 = await recordSmsChatSpend(objStub, { ...base, enabled: true });
    expect(r1.metered).toBe(true);
    expect(r1.spendMicros).toBe(50);

    const nullStub = makeStub({ claimRows: [{ id: "job-1" }], rpc: { data: null, error: null } });
    const r2 = await recordSmsChatSpend(nullStub, { ...base, enabled: true });
    expect(r2.metered).toBe(true);
    expect(r2.spendMicros).toBe(0);
    expect(r2.fuseNewlyTripped).toBe(false);
  });

  it("resolves the period when none is supplied (periodStart null)", async () => {
    const stub = makeStub({
      periodStart: "2026-06-01T00:00:00.000Z",
      claimRows: [{ id: "job-1" }],
      rpc: { data: [{ spend_micros: 50 }], error: null }
    });
    const r = await recordSmsChatSpend(stub, { ...base, periodStart: null, enabled: true });
    expect(r.metered).toBe(true);
    const spendCall = stub._calls.rpc.find((c) => c.fn === "owner_chat_record_spend");
    expect(spendCall?.args.p_period_start).toBe("2026-06-01T00:00:00.000Z");
  });

  it("non-array claim data is treated as already-metered", async () => {
    const stub = makeStub({ claimDataNonArray: true });
    const r = await recordSmsChatSpend(stub, { ...base, enabled: true });
    expect(r).toEqual({ metered: false, reason: "already_metered" });
    expect(stub._calls.rpc).toHaveLength(0);
  });

  it("already metered (claim matched 0 rows) → skip rpc", async () => {
    const stub = makeStub({ claimRows: [] });
    const r = await recordSmsChatSpend(stub, { ...base, enabled: true });
    expect(r).toEqual({ metered: false, reason: "already_metered" });
    expect(stub._calls.rpc).toHaveLength(0);
  });

  it("claim error → no rpc", async () => {
    const stub = makeStub({ claimError: "lock timeout" });
    const r = await recordSmsChatSpend(stub, { ...base, enabled: true });
    expect(r.metered).toBe(false);
    expect(r.reason).toBe("claim_failed");
    expect(stub._calls.rpc).toHaveLength(0);
  });

  it("rpc error → releases the metered_at claim (set back to null)", async () => {
    const stub = makeStub({
      claimRows: [{ id: "job-1" }],
      rpc: { data: null, error: { message: "rpc boom" } }
    });
    const r = await recordSmsChatSpend(stub, { ...base, enabled: true });
    expect(r.metered).toBe(false);
    expect(r.reason).toBe("rpc_failed");
    // First metered_at set = timestamp (claim); second = null (release).
    expect(stub._calls.meteredAtSet).toHaveLength(2);
    expect(stub._calls.meteredAtSet[0]).toBeTypeOf("string");
    expect(stub._calls.meteredAtSet[1]).toBeNull();
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
