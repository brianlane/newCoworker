import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  reserveVoiceBudget,
  tierCapSeconds,
  maxConcurrent,
  STRIPE_JIT_FETCH_MS
} from "../supabase/functions/_shared/voice_reserve";
import { VOICE_RES_LIMITS } from "../supabase/functions/_shared/voice_reservation_limits";

type Result<T> = { data: T; error: { message: string } | null };

function makeSupabase(cfg: {
  business: Result<unknown>;
  subscription?: Result<unknown>;
  subUpdateError?: { message: string } | null;
  reserve?: Result<unknown>;
}) {
  const telemetry: Array<{ p_event_type: string; p_payload: Record<string, unknown> }> = [];
  const reserveArgs: Array<Record<string, unknown>> = [];
  const supabase = {
    from(table: string) {
      if (table === "businesses") {
        return {
          select: () => ({ eq: () => ({ single: async () => cfg.business }) })
        };
      }
      if (table === "subscriptions") {
        return {
          select: () => ({
            eq: () => ({
              order: () => ({
                limit: () => ({ maybeSingle: async () => cfg.subscription })
              })
            })
          }),
          update: () => ({ eq: async () => ({ error: cfg.subUpdateError ?? null }) })
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
    rpc: async (fn: string, args: Record<string, unknown>) => {
      if (fn === "telemetry_record") {
        telemetry.push(args as { p_event_type: string; p_payload: Record<string, unknown> });
        return { error: null };
      }
      if (fn === "voice_reserve_for_call") {
        reserveArgs.push(args);
        return cfg.reserve ?? { data: { ok: true }, error: null };
      }
      throw new Error(`unexpected rpc ${fn}`);
    }
  };
  // deno SupabaseClient typing is structural here; tests only use from/rpc.
  return { supabase: supabase as never, telemetry, reserveArgs };
}

function stubFetch(impl: () => unknown) {
  vi.stubGlobal("fetch", vi.fn(async () => impl()));
}

const NOW = Date.now();
const FUTURE_END = new Date(NOW + 5 * 24 * 3600 * 1000).toISOString();
const PAST_START = new Date(NOW - 2 * 24 * 3600 * 1000).toISOString();
const PAST_END = new Date(NOW - 3600 * 1000).toISOString();

/** A valid, fresh subscription row that needs no JIT refresh. */
function freshSub() {
  return {
    data: {
      id: "sub_1",
      stripe_subscription_id: "si_1",
      stripe_current_period_start: PAST_START,
      stripe_current_period_end: FUTURE_END,
      stripe_subscription_cached_at: new Date(NOW - 60_000).toISOString()
    },
    error: null
  };
}

const bizStarter = { data: { tier: "starter", enterprise_limits: null }, error: null };

describe("tierCapSeconds / maxConcurrent", () => {
  it("resolves per-tier caps and concurrency", () => {
    expect(tierCapSeconds("enterprise", null)).toBe(
      VOICE_RES_LIMITS.enterprise.voiceIncludedSecondsPerStripePeriod
    );
    expect(tierCapSeconds("standard", null)).toBe(
      VOICE_RES_LIMITS.standard.voiceIncludedSecondsPerStripePeriod
    );
    expect(tierCapSeconds("starter", null)).toBe(
      VOICE_RES_LIMITS.starter.voiceIncludedSecondsPerStripePeriod
    );
    expect(maxConcurrent("enterprise", null)).toBe(VOICE_RES_LIMITS.enterprise.maxConcurrentCalls);
    expect(maxConcurrent("standard", null)).toBe(VOICE_RES_LIMITS.standard.maxConcurrentCalls);
    expect(maxConcurrent("starter", null)).toBe(VOICE_RES_LIMITS.starter.maxConcurrentCalls);
  });
});

describe("reserveVoiceBudget", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("reserves successfully on a fresh subscription (no JIT) and passes grant bounds", async () => {
    const { supabase, reserveArgs } = makeSupabase({
      business: bizStarter,
      subscription: freshSub(),
      reserve: { data: { ok: true, grant_seconds: 120, duplicate: false }, error: null }
    });
    const r = await reserveVoiceBudget(supabase, {
      businessId: "b1",
      callControlId: "cc1",
      stripeSecret: "",
      minGrantSeconds: 30,
      maxGrantSeconds: 600
    });
    expect(r).toEqual({ ok: true, grantSeconds: 120, duplicate: false });
    expect(reserveArgs[0]).toMatchObject({
      p_business_id: "b1",
      p_call_control_id: "cc1",
      p_min_grant_seconds: 30,
      p_max_grant_seconds: 600
    });
  });

  it("defaults grant bounds to 60/900 and grant_seconds to 0 when omitted", async () => {
    const { supabase, reserveArgs } = makeSupabase({
      business: { data: { tier: "standard", enterprise_limits: null }, error: null },
      subscription: freshSub(),
      reserve: { data: { ok: true, duplicate: true }, error: null }
    });
    const r = await reserveVoiceBudget(supabase, {
      businessId: "b1",
      callControlId: "cc1",
      stripeSecret: ""
    });
    expect(r).toEqual({ ok: true, grantSeconds: 0, duplicate: true });
    expect(reserveArgs[0]).toMatchObject({ p_min_grant_seconds: 60, p_max_grant_seconds: 900 });
  });

  it("uses enterprise caps for enterprise tier", async () => {
    const { supabase, reserveArgs } = makeSupabase({
      business: { data: { tier: "enterprise", enterprise_limits: null }, error: null },
      subscription: freshSub(),
      reserve: { data: { ok: true, grant_seconds: 90, duplicate: false }, error: null }
    });
    await reserveVoiceBudget(supabase, { businessId: "b1", callControlId: "cc1", stripeSecret: "" });
    expect(reserveArgs[0]).toMatchObject({
      p_tier: "enterprise",
      p_tier_cap_seconds: VOICE_RES_LIMITS.enterprise.voiceIncludedSecondsPerStripePeriod
    });
  });

  it("returns no_business on DB error", async () => {
    const { supabase } = makeSupabase({ business: { data: null, error: { message: "db" } } });
    const r = await reserveVoiceBudget(supabase, {
      businessId: "b1",
      callControlId: "cc1",
      stripeSecret: ""
    });
    expect(r).toEqual({ ok: false, reason: "no_business" });
  });

  it("returns no_business when business row missing", async () => {
    const { supabase } = makeSupabase({ business: { data: null, error: null } });
    const r = await reserveVoiceBudget(supabase, {
      businessId: "b1",
      callControlId: "cc1",
      stripeSecret: ""
    });
    expect(r).toEqual({ ok: false, reason: "no_business" });
  });

  it("defaults tier to starter when business.tier is null", async () => {
    const { supabase, reserveArgs } = makeSupabase({
      business: { data: { tier: null, enterprise_limits: null }, error: null },
      subscription: freshSub(),
      reserve: { data: { ok: true, grant_seconds: 60, duplicate: false }, error: null }
    });
    await reserveVoiceBudget(supabase, { businessId: "b1", callControlId: "cc1", stripeSecret: "" });
    expect(reserveArgs[0]).toMatchObject({ p_tier: "starter" });
  });

  it("returns sub_db_error on subscription DB error", async () => {
    const { supabase } = makeSupabase({
      business: bizStarter,
      subscription: { data: null, error: { message: "db" } }
    });
    const r = await reserveVoiceBudget(supabase, {
      businessId: "b1",
      callControlId: "cc1",
      stripeSecret: ""
    });
    expect(r).toEqual({ ok: false, reason: "sub_db_error" });
  });

  it("returns no_subscription when no subscription row", async () => {
    const { supabase } = makeSupabase({
      business: bizStarter,
      subscription: { data: null, error: null }
    });
    const r = await reserveVoiceBudget(supabase, {
      businessId: "b1",
      callControlId: "cc1",
      stripeSecret: ""
    });
    expect(r).toEqual({ ok: false, reason: "no_subscription" });
  });

  it("returns no_period_bounds when period bounds are absent and no JIT", async () => {
    // stripeSecret "" ⇒ needsJit false; missing fields exercise the `?? null` coalescing.
    const { supabase } = makeSupabase({
      business: bizStarter,
      subscription: { data: { id: "sub_1" }, error: null }
    });
    const r = await reserveVoiceBudget(supabase, {
      businessId: "b1",
      callControlId: "cc1",
      stripeSecret: ""
    });
    expect(r).toEqual({ ok: false, reason: "no_period_bounds" });
  });

  it("returns period_cache_stale when cached period is past end", async () => {
    const { supabase } = makeSupabase({
      business: bizStarter,
      subscription: {
        data: {
          id: "sub_1",
          stripe_subscription_id: "si_1",
          stripe_current_period_start: PAST_START,
          stripe_current_period_end: PAST_END,
          stripe_subscription_cached_at: new Date(NOW - 60_000).toISOString()
        },
        error: null
      }
    });
    const r = await reserveVoiceBudget(supabase, {
      businessId: "b1",
      callControlId: "cc1",
      stripeSecret: ""
    });
    expect(r).toEqual({ ok: false, reason: "period_cache_stale" });
  });

  it("JIT-refreshes missing bounds, persists cache, then reserves", async () => {
    stubFetch(() => ({
      ok: true,
      status: 200,
      json: async () => ({
        current_period_start: Math.floor((NOW - 86_400_000) / 1000),
        current_period_end: Math.floor((NOW + 86_400_000) / 1000)
      })
    }));
    const { supabase } = makeSupabase({
      business: bizStarter,
      subscription: {
        data: { id: "sub_1", stripe_subscription_id: "si_1" },
        error: null
      },
      reserve: { data: { ok: true, grant_seconds: 120, duplicate: false }, error: null }
    });
    const r = await reserveVoiceBudget(supabase, {
      businessId: "b1",
      callControlId: "cc1",
      stripeSecret: "sk_live"
    });
    expect(r).toEqual({ ok: true, grantSeconds: 120, duplicate: false });
  });

  it("logs but proceeds when JIT cache persist write fails", async () => {
    stubFetch(() => ({
      ok: true,
      status: 200,
      json: async () => ({
        current_period_start: Math.floor((NOW - 86_400_000) / 1000),
        current_period_end: Math.floor((NOW + 86_400_000) / 1000)
      })
    }));
    const { supabase } = makeSupabase({
      business: bizStarter,
      subscription: { data: { id: "sub_1", stripe_subscription_id: "si_1" }, error: null },
      subUpdateError: { message: "write fail" },
      reserve: { data: { ok: true, grant_seconds: 60, duplicate: false }, error: null }
    });
    const r = await reserveVoiceBudget(supabase, {
      businessId: "b1",
      callControlId: "cc1",
      stripeSecret: "sk_live"
    });
    expect(r.ok).toBe(true);
  });

  it("proceeds on still-valid cache after a failed JIT fetch", async () => {
    // Stale cache (cached >6h ago) triggers JIT; fetch fails but the cached
    // period is still in the future ⇒ proceed.
    stubFetch(() => ({ ok: false, status: 500, text: async () => "stripe down" }));
    const { supabase, telemetry } = makeSupabase({
      business: bizStarter,
      subscription: {
        data: {
          id: "sub_1",
          stripe_subscription_id: "si_1",
          stripe_current_period_start: PAST_START,
          stripe_current_period_end: FUTURE_END,
          stripe_subscription_cached_at: new Date(NOW - 7 * 3600 * 1000).toISOString()
        },
        error: null
      },
      reserve: { data: { ok: true, grant_seconds: 60, duplicate: false }, error: null }
    });
    const r = await reserveVoiceBudget(supabase, {
      businessId: "b1",
      callControlId: "cc1",
      stripeSecret: "sk_live"
    });
    expect(r.ok).toBe(true);
    expect(telemetry.map((t) => t.p_event_type)).toContain("jit_stripe_fail_proceed_cached");
  });

  it("blocks when JIT fetch fails and cache is no longer valid", async () => {
    // Past-end cache triggers JIT; fetch returns malformed JSON (null) and the
    // cache is past end ⇒ block.
    stubFetch(() => ({ ok: true, status: 200, json: async () => ({ current_period_start: "nope" }) }));
    const { supabase, telemetry } = makeSupabase({
      business: bizStarter,
      subscription: {
        data: {
          id: "sub_1",
          stripe_subscription_id: "si_1",
          stripe_current_period_start: PAST_START,
          stripe_current_period_end: PAST_END,
          stripe_subscription_cached_at: new Date(NOW - 60_000).toISOString()
        },
        error: null
      }
    });
    const r = await reserveVoiceBudget(supabase, {
      businessId: "b1",
      callControlId: "cc1",
      stripeSecret: "sk_live"
    });
    expect(r).toEqual({ ok: false, reason: "jit_stripe_fail_block" });
    expect(telemetry.map((t) => t.p_event_type)).toContain("jit_stripe_fail_block");
  });

  it("returns reserve_error when the reserve RPC errors", async () => {
    const { supabase } = makeSupabase({
      business: bizStarter,
      subscription: freshSub(),
      reserve: { data: null, error: { message: "rpc" } }
    });
    const r = await reserveVoiceBudget(supabase, {
      businessId: "b1",
      callControlId: "cc1",
      stripeSecret: ""
    });
    expect(r).toEqual({ ok: false, reason: "reserve_error" });
  });

  it("maps concurrent_limit refusal", async () => {
    const { supabase } = makeSupabase({
      business: bizStarter,
      subscription: freshSub(),
      reserve: { data: { ok: false, reason: "concurrent_limit" }, error: null }
    });
    const r = await reserveVoiceBudget(supabase, {
      businessId: "b1",
      callControlId: "cc1",
      stripeSecret: ""
    });
    expect(r).toEqual({ ok: false, reason: "concurrent_limit" });
  });

  it("aborts a hung Stripe JIT fetch via timeout and falls back to cache", async () => {
    vi.useFakeTimers();
    try {
      // Fetch never resolves on its own; it rejects only when the abort signal
      // fires, exercising the timeout callback + catch branch.
      vi.stubGlobal(
        "fetch",
        vi.fn(
          (_url: string, init: { signal: AbortSignal }) =>
            new Promise((_resolve, reject) => {
              init.signal.addEventListener("abort", () => reject(new Error("aborted")));
            })
        )
      );
      const { supabase, telemetry } = makeSupabase({
        business: bizStarter,
        subscription: {
          data: {
            id: "sub_1",
            stripe_subscription_id: "si_1",
            stripe_current_period_start: PAST_START,
            stripe_current_period_end: FUTURE_END,
            stripe_subscription_cached_at: new Date(NOW - 7 * 3600 * 1000).toISOString()
          },
          error: null
        },
        reserve: { data: { ok: true, grant_seconds: 60, duplicate: false }, error: null }
      });
      const pending = reserveVoiceBudget(supabase, {
        businessId: "b1",
        callControlId: "cc1",
        stripeSecret: "sk_live"
      });
      await vi.advanceTimersByTimeAsync(STRIPE_JIT_FETCH_MS + 10);
      const r = await pending;
      expect(r.ok).toBe(true);
      expect(telemetry.map((t) => t.p_event_type)).toContain("jit_stripe_fail_proceed_cached");
    } finally {
      vi.useRealTimers();
    }
  });

  it("maps any other refusal to quota_exhausted (including null result)", async () => {
    const { supabase } = makeSupabase({
      business: bizStarter,
      subscription: freshSub(),
      reserve: { data: null, error: null }
    });
    const r = await reserveVoiceBudget(supabase, {
      businessId: "b1",
      callControlId: "cc1",
      stripeSecret: ""
    });
    expect(r).toEqual({ ok: false, reason: "quota_exhausted" });
  });
});
