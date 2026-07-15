import { describe, expect, it } from "vitest";
import {
  meterForwardedCallSeconds,
  type ForwardedMeterSupabase
} from "../supabase/functions/_shared/forwarded_call_meter";
import { VOICE_RES_LIMITS } from "../supabase/functions/_shared/voice_reservation_limits";

type Result<T> = { data: T; error: { message: string } | null };

function makeSupabase(cfg: {
  business?: Result<unknown>;
  subscription?: Result<unknown>;
  meter?: Result<unknown>;
  meterError?: { message: string } | null;
}) {
  const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const supabase: ForwardedMeterSupabase = {
    from(table: string) {
      if (table === "businesses") {
        return {
          select: () => ({
            eq: () => ({
              single: async () =>
                cfg.business ?? { data: { tier: "starter" }, error: null },
              order: () => ({ limit: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) })
            })
          })
        };
      }
      // subscriptions
      return {
        select: () => ({
          eq: () => ({
            single: async () => ({ data: null, error: null }),
            order: () => ({
              limit: () => ({
                maybeSingle: async () =>
                  cfg.subscription ?? {
                    data: {
                      stripe_current_period_start: "2026-07-01T00:00:00Z",
                      stripe_current_period_end: new Date(Date.now() + 86_400_000).toISOString()
                    },
                    error: null
                  }
              })
            })
          })
        })
      };
    },
    rpc: async (fn: string, args?: Record<string, unknown>) => {
      rpcCalls.push({ fn, args: args ?? {} });
      if (fn === "voice_meter_forwarded_call") {
        return {
          data: cfg.meter ? cfg.meter.data : { ok: true, duplicate: false, billable_seconds: 600 },
          error: cfg.meterError ?? cfg.meter?.error ?? null
        };
      }
      // telemetry_record
      return { data: null, error: null };
    }
  };
  return { supabase, rpcCalls };
}

const base = {
  businessId: "biz-1",
  callControlId: "v3:leg-b",
  reportedSeconds: 543,
  context: "warm_transfer"
};

describe("meterForwardedCallSeconds", () => {
  it("meters an answered human leg through the RPC with the month-window period key", async () => {
    const { supabase, rpcCalls } = makeSupabase({});
    const res = await meterForwardedCallSeconds(supabase, base);
    expect(res).toEqual({ status: "metered", billableSeconds: 600 });
    const call = rpcCalls.find((c) => c.fn === "voice_meter_forwarded_call");
    expect(call?.args).toMatchObject({
      p_business_id: "biz-1",
      p_call_control_id: "v3:leg-b",
      p_reported_seconds: 543,
      p_context: "warm_transfer",
      p_tier_cap_seconds: VOICE_RES_LIMITS.starter.voiceIncludedSecondsPerStripePeriod
    });
    // deriveMonthlyQuotaWindow of a period start in the current month-window —
    // must be an ISO timestamp (the exact window is covered by its own tests).
    expect(typeof call?.args.p_stripe_period_start).toBe("string");
    // Success telemetry carries the billable figure for ops reconciliation.
    const tel = rpcCalls.find(
      (c) => c.fn === "telemetry_record" && c.args.p_event_type === "voice_forwarded_call_metered"
    );
    expect(tel?.args.p_payload).toMatchObject({ billable_seconds: 600, reported_seconds: 543 });
  });

  it("defaults a missing tier to starter", async () => {
    const { supabase, rpcCalls } = makeSupabase({ business: { data: {}, error: null } });
    await meterForwardedCallSeconds(supabase, base);
    const call = rpcCalls.find((c) => c.fn === "voice_meter_forwarded_call");
    expect(call?.args.p_tier_cap_seconds).toBe(
      VOICE_RES_LIMITS.starter.voiceIncludedSecondsPerStripePeriod
    );
  });

  it("uses the standard tier cap for standard businesses", async () => {
    const { supabase, rpcCalls } = makeSupabase({
      business: { data: { tier: "standard" }, error: null }
    });
    await meterForwardedCallSeconds(supabase, base);
    const call = rpcCalls.find((c) => c.fn === "voice_meter_forwarded_call");
    expect(call?.args.p_tier_cap_seconds).toBe(
      VOICE_RES_LIMITS.standard.voiceIncludedSecondsPerStripePeriod
    );
  });

  it("resolves the enterprise cap from enterprise_limits", async () => {
    const { supabase, rpcCalls } = makeSupabase({
      business: {
        data: {
          tier: "enterprise",
          enterprise_limits: { voiceIncludedSecondsPerStripePeriod: 90000 }
        },
        error: null
      }
    });
    await meterForwardedCallSeconds(supabase, base);
    const call = rpcCalls.find((c) => c.fn === "voice_meter_forwarded_call");
    expect(call?.args.p_tier_cap_seconds).toBe(90000);
  });

  it("floors fractional reported seconds and clamps negatives to zero", async () => {
    const { supabase, rpcCalls } = makeSupabase({});
    await meterForwardedCallSeconds(supabase, { ...base, reportedSeconds: 42.9 });
    await meterForwardedCallSeconds(supabase, {
      ...base,
      callControlId: "v3:neg",
      reportedSeconds: -5
    });
    const calls = rpcCalls.filter((c) => c.fn === "voice_meter_forwarded_call");
    expect(calls[0].args.p_reported_seconds).toBe(42);
    expect(calls[1].args.p_reported_seconds).toBe(0);
  });

  it("returns duplicate when the RPC reports the call was already metered", async () => {
    const { supabase } = makeSupabase({
      meter: { data: { ok: true, duplicate: true, billable_seconds: 0 }, error: null }
    });
    expect(await meterForwardedCallSeconds(supabase, base)).toEqual({ status: "duplicate" });
  });

  it("returns zero for a zero-billable settle (no telemetry spam)", async () => {
    const { supabase, rpcCalls } = makeSupabase({
      meter: { data: { ok: true, duplicate: false, billable_seconds: 0 }, error: null }
    });
    expect(await meterForwardedCallSeconds(supabase, base)).toEqual({ status: "zero" });
    expect(
      rpcCalls.some(
        (c) => c.fn === "telemetry_record" && c.args.p_event_type === "voice_forwarded_call_metered"
      )
    ).toBe(false);
  });

  it("skips with no_call when the leg id is missing", async () => {
    const { supabase, rpcCalls } = makeSupabase({});
    expect(await meterForwardedCallSeconds(supabase, { ...base, callControlId: "" })).toEqual({
      status: "skipped",
      reason: "no_call"
    });
    expect(rpcCalls).toHaveLength(0);
  });

  it("skips with no_duration when Telnyx reported no call_duration", async () => {
    const { supabase, rpcCalls } = makeSupabase({});
    expect(
      await meterForwardedCallSeconds(supabase, { ...base, reportedSeconds: null })
    ).toEqual({ status: "skipped", reason: "no_duration" });
    expect(
      await meterForwardedCallSeconds(supabase, { ...base, reportedSeconds: Number.NaN })
    ).toEqual({ status: "skipped", reason: "no_duration" });
    expect(rpcCalls.filter((c) => c.fn === "voice_meter_forwarded_call")).toHaveLength(0);
    // Skips are telemetried so ops can backfill.
    expect(
      rpcCalls.filter(
        (c) => c.fn === "telemetry_record" && c.args.p_event_type === "voice_forwarded_meter_skipped"
      )
    ).toHaveLength(2);
  });

  it("skips with no_business when the business row is missing", async () => {
    const { supabase } = makeSupabase({
      business: { data: null, error: { message: "not found" } }
    });
    expect(await meterForwardedCallSeconds(supabase, base)).toEqual({
      status: "skipped",
      reason: "no_business"
    });
  });

  it("skips with no_period_bounds when there is no cached Stripe period", async () => {
    const { supabase } = makeSupabase({
      subscription: { data: { stripe_current_period_start: null }, error: null }
    });
    expect(await meterForwardedCallSeconds(supabase, base)).toEqual({
      status: "skipped",
      reason: "no_period_bounds"
    });
  });

  it("skips with no_period_bounds when the cached period has no end", async () => {
    const { supabase } = makeSupabase({
      subscription: {
        data: {
          stripe_current_period_start: "2026-07-01T00:00:00Z",
          stripe_current_period_end: null
        },
        error: null
      }
    });
    expect(await meterForwardedCallSeconds(supabase, base)).toEqual({
      status: "skipped",
      reason: "no_period_bounds"
    });
  });

  it("skips with period_stale when the cache is past its period end (never writes the old row)", async () => {
    // A stale cache would derive the OLD period's month-window key — a
    // different usage row than the (JIT-refreshing) reserve gate reads.
    const { supabase, rpcCalls } = makeSupabase({
      subscription: {
        data: {
          stripe_current_period_start: "2026-05-01T00:00:00Z",
          stripe_current_period_end: new Date(Date.now() - 10 * 60_000).toISOString()
        },
        error: null
      }
    });
    expect(await meterForwardedCallSeconds(supabase, base)).toEqual({
      status: "skipped",
      reason: "period_stale"
    });
    expect(rpcCalls.filter((c) => c.fn === "voice_meter_forwarded_call")).toHaveLength(0);
  });

  it("skips with rpc_error when the meter RPC fails", async () => {
    const { supabase } = makeSupabase({ meterError: { message: "boom" } });
    expect(await meterForwardedCallSeconds(supabase, base)).toEqual({
      status: "skipped",
      reason: "rpc_error"
    });
  });

  it("never throws — a throwing client maps to rpc_error", async () => {
    const supabase = {
      from() {
        throw new Error("kaput");
      },
      rpc: async () => ({ data: null, error: null })
    } as unknown as ForwardedMeterSupabase;
    expect(await meterForwardedCallSeconds(supabase, base)).toEqual({
      status: "skipped",
      reason: "rpc_error"
    });
  });

  it("treats a null RPC payload as zero billable", async () => {
    const { supabase } = makeSupabase({ meter: { data: null, error: null } });
    expect(await meterForwardedCallSeconds(supabase, base)).toEqual({ status: "zero" });
  });
});
