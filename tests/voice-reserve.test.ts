import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  reserveVoiceBudget,
  checkVoiceBudgetAvailable,
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
  availability?: Result<unknown>;
  reservationUpdateError?: { message: string } | null;
  reservationUpdateThrows?: boolean;
}) {
  const telemetry: Array<{ p_event_type: string; p_payload: Record<string, unknown> }> = [];
  const reserveArgs: Array<Record<string, unknown>> = [];
  const availabilityArgs: Array<Record<string, unknown>> = [];
  const reservationUpdates: Array<{ row: Record<string, unknown>; eq: [string, unknown] }> = [];
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
      if (table === "voice_reservations") {
        return {
          update: (row: Record<string, unknown>) => ({
            eq: async (col: string, val: unknown) => {
              if (cfg.reservationUpdateThrows) throw new Error("reservations table offline");
              reservationUpdates.push({ row, eq: [col, val] });
              return { error: cfg.reservationUpdateError ?? null };
            }
          })
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
      if (fn === "voice_check_availability") {
        availabilityArgs.push(args);
        return cfg.availability ?? { data: { ok: true }, error: null };
      }
      throw new Error(`unexpected rpc ${fn}`);
    }
  };
  // deno SupabaseClient typing is structural here; tests only use from/rpc.
  return { supabase: supabase as never, telemetry, reserveArgs, availabilityArgs, reservationUpdates };
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

  it("JIT-refreshes missing bounds from the per-item shape, persists cache, then reserves", async () => {
    // The shape the LIVE Stripe API actually returns. The account default API
    // version (2026-03-25.dahlia) moved current_period_* off the Subscription
    // and onto its items, so the top-level fields are absent entirely. A
    // fixture that still sends them describes an API that no longer exists,
    // which is how this path passed at 100% coverage while failing on every
    // real call for a month.
    stubFetch(() => ({
      ok: true,
      status: 200,
      json: async () => ({
        id: "si_1",
        status: "active",
        items: {
          data: [
            {
              current_period_start: Math.floor((NOW - 86_400_000) / 1000),
              current_period_end: Math.floor((NOW + 86_400_000) / 1000)
            }
          ]
        }
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

  it("logs but proceeds when JIT cache persist write fails (legacy top-level shape)", async () => {
    // Legacy shape, still accepted for an account pinned to an API version
    // at or below 2025-03-30.
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

  it("refreshes a stale cache from the live per-item shape instead of failing the JIT", async () => {
    // Regression for the Aug 2026 outage: a stale-but-valid cache triggers the
    // JIT, Stripe answers 200 with the modern shape, and the refresh must
    // SUCCEED. Reading only the top level returned null here, which degraded
    // every call to the cached-period fallback and stopped re-stamping
    // stripe_subscription_cached_at, until the cache aged out and calls were
    // refused outright.
    stubFetch(() => ({
      ok: true,
      status: 200,
      json: async () => ({
        items: {
          data: [
            {
              current_period_start: Math.floor((NOW - 86_400_000) / 1000),
              current_period_end: Math.floor((NOW + 30 * 86_400_000) / 1000)
            }
          ]
        }
      })
    }));
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
    // No fallback telemetry at all: the refresh worked.
    expect(telemetry.map((t) => t.p_event_type)).not.toContain("jit_stripe_fail_proceed_cached");
    expect(telemetry.map((t) => t.p_event_type)).not.toContain("jit_stripe_fail_block");
  });

  it("honors a >30d cache for a prepaid biennial plan when the JIT fails", async () => {
    // A term plan gets no renewal webhook for two years, so nothing but the
    // JIT re-stamps its cache. Judging it by the monthly 30-day yardstick
    // refuses calls from a tenant paid in full through 2028.
    stubFetch(() => ({ ok: false, status: 500, text: async () => "stripe down" }));
    const { supabase, telemetry } = makeSupabase({
      business: bizStarter,
      subscription: {
        data: {
          id: "sub_1",
          stripe_subscription_id: "si_1",
          stripe_current_period_start: PAST_START,
          stripe_current_period_end: FUTURE_END,
          stripe_subscription_cached_at: new Date(NOW - 40 * 24 * 3600 * 1000).toISOString(),
          billing_period: "biennial"
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

  it("still blocks a >30d cache for a monthly plan when the JIT fails", async () => {
    // The monthly rule is unchanged: a renewal webhook re-stamps every cycle,
    // so a cache older than a full cycle really does mean something is broken.
    stubFetch(() => ({ ok: false, status: 500, text: async () => "stripe down" }));
    const { supabase, telemetry } = makeSupabase({
      business: bizStarter,
      subscription: {
        data: {
          id: "sub_1",
          stripe_subscription_id: "si_1",
          stripe_current_period_start: PAST_START,
          stripe_current_period_end: FUTURE_END,
          stripe_subscription_cached_at: new Date(NOW - 40 * 24 * 3600 * 1000).toISOString(),
          billing_period: "monthly"
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

describe("checkVoiceBudgetAvailable", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** A subscription row with valid, in-window cached period bounds. */
  function periodSub(start = PAST_START, end = FUTURE_END) {
    return {
      data: { stripe_current_period_start: start, stripe_current_period_end: end },
      error: null
    };
  }

  it("returns ok with remaining/bonus when budget is available", async () => {
    const { supabase, availabilityArgs } = makeSupabase({
      business: bizStarter,
      subscription: periodSub(),
      availability: {
        data: { ok: true, remaining_seconds: 1200, bonus_seconds_available: 300 },
        error: null
      }
    });
    const r = await checkVoiceBudgetAvailable(supabase, { businessId: "b1", minGrantSeconds: 90 });
    expect(r).toEqual({ status: "ok", remainingSeconds: 1200, bonusSeconds: 300 });
    expect(availabilityArgs[0]).toMatchObject({
      p_business_id: "b1",
      p_min_grant_seconds: 90
    });
  });

  it("defaults numeric fields to 0 when the RPC omits them", async () => {
    const { supabase } = makeSupabase({
      business: bizStarter,
      subscription: periodSub(),
      availability: { data: { ok: true }, error: null }
    });
    const r = await checkVoiceBudgetAvailable(supabase, { businessId: "b1" });
    expect(r).toEqual({ status: "ok", remainingSeconds: 0, bonusSeconds: 0 });
  });

  it("uses enterprise caps when tier is enterprise", async () => {
    const { supabase, availabilityArgs } = makeSupabase({
      business: { data: { tier: "enterprise", enterprise_limits: null }, error: null },
      subscription: periodSub(),
      availability: { data: { ok: true }, error: null }
    });
    await checkVoiceBudgetAvailable(supabase, { businessId: "b1" });
    expect(availabilityArgs[0]).toMatchObject({
      p_tier_cap_seconds: VOICE_RES_LIMITS.enterprise.voiceIncludedSecondsPerStripePeriod,
      p_max_concurrent: VOICE_RES_LIMITS.enterprise.maxConcurrentCalls
    });
  });

  it("maps a concurrent_limit refusal to blocked", async () => {
    const { supabase } = makeSupabase({
      business: bizStarter,
      subscription: periodSub(),
      availability: { data: { ok: false, reason: "concurrent_limit" }, error: null }
    });
    const r = await checkVoiceBudgetAvailable(supabase, { businessId: "b1" });
    expect(r).toEqual({ status: "blocked", reason: "concurrent_limit" });
  });

  it("maps any other refusal (incl. null) to blocked quota_exhausted", async () => {
    const { supabase } = makeSupabase({
      business: bizStarter,
      subscription: periodSub(),
      availability: { data: null, error: null }
    });
    const r = await checkVoiceBudgetAvailable(supabase, { businessId: "b1" });
    expect(r).toEqual({ status: "blocked", reason: "quota_exhausted" });
  });

  it("indeterminate(no_business) on business DB error", async () => {
    const { supabase } = makeSupabase({ business: { data: null, error: { message: "db" } } });
    const r = await checkVoiceBudgetAvailable(supabase, { businessId: "b1" });
    expect(r).toEqual({ status: "indeterminate", reason: "no_business" });
  });

  it("indeterminate(no_business) when business row missing", async () => {
    const { supabase } = makeSupabase({ business: { data: null, error: null } });
    const r = await checkVoiceBudgetAvailable(supabase, { businessId: "b1" });
    expect(r).toEqual({ status: "indeterminate", reason: "no_business" });
  });

  it("defaults tier to starter when business.tier is null", async () => {
    const { supabase, availabilityArgs } = makeSupabase({
      business: { data: { tier: null, enterprise_limits: null }, error: null },
      subscription: periodSub(),
      availability: { data: { ok: true }, error: null }
    });
    await checkVoiceBudgetAvailable(supabase, { businessId: "b1" });
    expect(availabilityArgs[0]).toMatchObject({
      p_tier_cap_seconds: VOICE_RES_LIMITS.starter.voiceIncludedSecondsPerStripePeriod
    });
  });

  it("indeterminate(check_error) on subscription DB error", async () => {
    const { supabase } = makeSupabase({
      business: bizStarter,
      subscription: { data: null, error: { message: "db" } }
    });
    const r = await checkVoiceBudgetAvailable(supabase, { businessId: "b1" });
    expect(r).toEqual({ status: "indeterminate", reason: "check_error" });
  });

  it("indeterminate(no_period_bounds) when subscription row missing", async () => {
    const { supabase } = makeSupabase({
      business: bizStarter,
      subscription: { data: null, error: null }
    });
    const r = await checkVoiceBudgetAvailable(supabase, { businessId: "b1" });
    expect(r).toEqual({ status: "indeterminate", reason: "no_period_bounds" });
  });

  it("indeterminate(no_period_bounds) when only the period end is present", async () => {
    const { supabase } = makeSupabase({
      business: bizStarter,
      subscription: {
        data: { stripe_current_period_start: null, stripe_current_period_end: FUTURE_END },
        error: null
      }
    });
    const r = await checkVoiceBudgetAvailable(supabase, { businessId: "b1" });
    expect(r).toEqual({ status: "indeterminate", reason: "no_period_bounds" });
  });

  it("indeterminate(period_stale) when the cached period is past end", async () => {
    const { supabase } = makeSupabase({
      business: bizStarter,
      subscription: periodSub(PAST_START, PAST_END)
    });
    const r = await checkVoiceBudgetAvailable(supabase, { businessId: "b1" });
    expect(r).toEqual({ status: "indeterminate", reason: "period_stale" });
  });

  it("indeterminate(check_error) when the availability RPC errors", async () => {
    const { supabase } = makeSupabase({
      business: bizStarter,
      subscription: periodSub(),
      availability: { data: null, error: { message: "rpc" } }
    });
    const r = await checkVoiceBudgetAvailable(supabase, { businessId: "b1" });
    expect(r).toEqual({ status: "indeterminate", reason: "check_error" });
  });
});

/**
 * Fleet-gate additions (PR 2 of the Telnyx capacity plan): the direction
 * stamp that lets the platform count outbound legs, and the
 * p_platform_max_outbound passthrough + platform_capacity mapping on the
 * pre-dial probe.
 */
describe("reserveVoiceBudget: direction stamp", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const okReserve = { data: { ok: true, grant_seconds: 120, duplicate: false }, error: null };

  it("stamps outbound on the reservation row after a successful reserve", async () => {
    const { supabase, reservationUpdates } = makeSupabase({
      business: bizStarter,
      subscription: freshSub(),
      reserve: okReserve
    });
    const r = await reserveVoiceBudget(supabase, {
      businessId: "b1",
      callControlId: "cc-out-1",
      stripeSecret: "",
      direction: "outbound"
    });
    expect(r.ok).toBe(true);
    expect(reservationUpdates).toEqual([
      { row: { direction: "outbound" }, eq: ["call_control_id", "cc-out-1"] }
    ]);
  });

  it("stamps on an idempotent duplicate reserve too", async () => {
    const { supabase, reservationUpdates } = makeSupabase({
      business: bizStarter,
      subscription: freshSub(),
      reserve: { data: { ok: true, duplicate: true }, error: null }
    });
    const r = await reserveVoiceBudget(supabase, {
      businessId: "b1",
      callControlId: "cc-out-2",
      stripeSecret: "",
      direction: "outbound"
    });
    expect(r).toEqual({ ok: true, grantSeconds: 0, duplicate: true });
    expect(reservationUpdates).toHaveLength(1);
  });

  it("never touches reservations when direction is omitted (inbound default)", async () => {
    const { supabase, reservationUpdates } = makeSupabase({
      business: bizStarter,
      subscription: freshSub(),
      reserve: okReserve
    });
    const r = await reserveVoiceBudget(supabase, {
      businessId: "b1",
      callControlId: "cc-in-1",
      stripeSecret: ""
    });
    expect(r.ok).toBe(true);
    expect(reservationUpdates).toEqual([]);
  });

  it("does not stamp when the reserve was refused", async () => {
    const { supabase, reservationUpdates } = makeSupabase({
      business: bizStarter,
      subscription: freshSub(),
      reserve: { data: { ok: false, reason: "concurrent_limit" }, error: null }
    });
    const r = await reserveVoiceBudget(supabase, {
      businessId: "b1",
      callControlId: "cc-out-3",
      stripeSecret: "",
      direction: "outbound"
    });
    expect(r.ok).toBe(false);
    expect(reservationUpdates).toEqual([]);
  });

  // The stamp is best-effort: a failed or throwing stamp leaves the default
  // 'inbound' (the fleet gate under-counts briefly) but must never fail the
  // reserve, because the leg is already dialed and metering is committed.
  it("a stamp DB error does not fail the reserve", async () => {
    const { supabase } = makeSupabase({
      business: bizStarter,
      subscription: freshSub(),
      reserve: okReserve,
      reservationUpdateError: { message: "column locked" }
    });
    const r = await reserveVoiceBudget(supabase, {
      businessId: "b1",
      callControlId: "cc-out-4",
      stripeSecret: "",
      direction: "outbound"
    });
    expect(r.ok).toBe(true);
  });

  it("a stamp that throws does not fail the reserve", async () => {
    const { supabase } = makeSupabase({
      business: bizStarter,
      subscription: freshSub(),
      reserve: okReserve,
      reservationUpdateThrows: true
    });
    const r = await reserveVoiceBudget(supabase, {
      businessId: "b1",
      callControlId: "cc-out-5",
      stripeSecret: "",
      direction: "outbound"
    });
    expect(r.ok).toBe(true);
  });
});

describe("checkVoiceBudgetAvailable: platform gate passthrough", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("passes a floored positive platformMaxOutbound to the RPC", async () => {
    const { supabase, availabilityArgs } = makeSupabase({
      business: bizStarter,
      subscription: freshSub(),
      availability: { data: { ok: true, remaining_seconds: 100, bonus_seconds_available: 0 }, error: null }
    });
    const r = await checkVoiceBudgetAvailable(supabase, {
      businessId: "b1",
      platformMaxOutbound: 7.9
    });
    expect(r.status).toBe("ok");
    expect(availabilityArgs[0]).toMatchObject({ p_platform_max_outbound: 7 });
  });

  it("passes null when the gate is omitted or non-positive", async () => {
    for (const platformMaxOutbound of [undefined, 0, -4, Number.NaN]) {
      const { supabase, availabilityArgs } = makeSupabase({
        business: bizStarter,
        subscription: freshSub(),
        availability: { data: { ok: true, remaining_seconds: 1, bonus_seconds_available: 0 }, error: null }
      });
      await checkVoiceBudgetAvailable(supabase, {
        businessId: "b1",
        ...(platformMaxOutbound === undefined ? {} : { platformMaxOutbound })
      });
      expect(availabilityArgs[0]).toMatchObject({ p_platform_max_outbound: null });
    }
  });

  it("maps a platform_capacity refusal through as its own blocked reason", async () => {
    const { supabase } = makeSupabase({
      business: bizStarter,
      subscription: freshSub(),
      availability: {
        data: { ok: false, reason: "platform_capacity", outbound_in_flight: 7 },
        error: null
      }
    });
    const r = await checkVoiceBudgetAvailable(supabase, {
      businessId: "b1",
      platformMaxOutbound: 7
    });
    expect(r).toEqual({ status: "blocked", reason: "platform_capacity" });
  });
});

/**
 * Per-tenant dial headroom (owner policy, Aug 16 2026): the pre-dial probe
 * gates AI FLOW DIALS at (tenant cap - headroom) so warm transfers and
 * reach legs always find channels inside the tenant's own carrier cap. The
 * authoritative post-dial reserve keeps the FULL cap on purpose.
 */
describe("checkVoiceBudgetAvailable: tenant dial headroom", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const okAvail = {
    data: { ok: true, remaining_seconds: 100, bonus_seconds_available: 0 },
    error: null
  };
  const bizStandard = { data: { tier: "standard", enterprise_limits: null }, error: null };

  it("reduces the probe's concurrency cap by the headroom", async () => {
    const { supabase, availabilityArgs } = makeSupabase({
      business: bizStandard,
      subscription: freshSub(),
      availability: okAvail
    });
    await checkVoiceBudgetAvailable(supabase, { businessId: "b1", outboundDialHeadroom: 3 });
    expect(availabilityArgs[0]).toMatchObject({
      p_max_concurrent: VOICE_RES_LIMITS.standard.maxConcurrentCalls - 3
    });
  });

  it("never reduces below one dial slot (starter cap 1 minus headroom 3)", async () => {
    const { supabase, availabilityArgs } = makeSupabase({
      business: bizStarter,
      subscription: freshSub(),
      availability: okAvail
    });
    await checkVoiceBudgetAvailable(supabase, { businessId: "b1", outboundDialHeadroom: 3 });
    expect(availabilityArgs[0]).toMatchObject({ p_max_concurrent: 1 });
  });

  it("passes the full cap when headroom is omitted, zero, or garbage", async () => {
    for (const outboundDialHeadroom of [undefined, 0, -2, Number.NaN]) {
      const { supabase, availabilityArgs } = makeSupabase({
        business: bizStandard,
        subscription: freshSub(),
        availability: okAvail
      });
      await checkVoiceBudgetAvailable(supabase, {
        businessId: "b1",
        ...(outboundDialHeadroom === undefined ? {} : { outboundDialHeadroom })
      });
      expect(availabilityArgs[0]).toMatchObject({
        p_max_concurrent: VOICE_RES_LIMITS.standard.maxConcurrentCalls
      });
    }
  });

  it("floors a fractional headroom", async () => {
    const { supabase, availabilityArgs } = makeSupabase({
      business: bizStandard,
      subscription: freshSub(),
      availability: okAvail
    });
    await checkVoiceBudgetAvailable(supabase, { businessId: "b1", outboundDialHeadroom: 2.9 });
    expect(availabilityArgs[0]).toMatchObject({
      p_max_concurrent: VOICE_RES_LIMITS.standard.maxConcurrentCalls - 2
    });
  });
});
