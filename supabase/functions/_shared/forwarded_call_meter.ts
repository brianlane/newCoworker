/**
 * Post-hoc meter for forwarded / transferred call minutes.
 *
 * The platform's Telnyx account pays carrier time for the FULL duration of
 * every leg of a tenant's call — including the human conversation after the AI
 * warm-transfers (`transfer_to_owner`), safe-mode forwards, per-caller
 * transfer rules, and handoff-chain calls a human answered. AI settlement only
 * bills the AI portion (it stops at bridge media end), and the pure-human
 * paths never reserved at all, so until Jul 2026 that carrier time was
 * unmetered. Policy parity with SMS: NOTHING is exempt from metering, but a
 * post-hoc meter never refuses — the call already happened; the reserve gate
 * (and the safe-mode pre-check) refuse the NEXT call once the pool is spent.
 *
 * `meterForwardedCallSeconds` resolves the tenant's tier cap and CACHED Stripe
 * period (no JIT refresh — this is bookkeeping, not admission control; the
 * monthly window derives via `deriveMonthlyQuotaWindow` exactly like
 * voice_reserve so both write the same usage row), then calls the idempotent
 * `voice_meter_forwarded_call` RPC (per-minute rounding, commit to
 * `voice_billing_period_usage.committed_included_seconds`).
 *
 * Best-effort by contract: NEVER throws — metering must not break webhook
 * handling. Unresolvable period/tier maps to a `skipped` result + telemetry so
 * ops can backfill.
 */
import { resolveEnterpriseVoiceReservation } from "./enterprise_limits.ts";
import { VOICE_RES_LIMITS } from "./voice_reservation_limits.ts";
import { deriveMonthlyQuotaWindow } from "./billing_period_window.ts";
import { telemetryRecord } from "./telemetry.ts";
import { STRIPE_PERIOD_ROLLOVER_GRACE_MS } from "./stripe_voice_period.ts";

type QueryResult = { data: unknown; error: { message: string } | null };

/** Structural Supabase shape (matches the chains used below). */
export type ForwardedMeterSupabase = {
  from: (table: string) => {
    select: (cols: string) => {
      eq: (
        col: string,
        val: unknown
      ) => {
        single: () => PromiseLike<QueryResult>;
        order: (
          col: string,
          opts: { ascending: boolean }
        ) => {
          limit: (n: number) => { maybeSingle: () => PromiseLike<QueryResult> };
        };
      };
    };
  };
  rpc: (
    fn: string,
    args?: Record<string, unknown>
  ) => PromiseLike<{ data: unknown; error: { message: string } | null }>;
};

export type ForwardedMeterResult =
  | { status: "metered"; billableSeconds: number }
  | { status: "duplicate" }
  | { status: "zero" }
  | {
      status: "skipped";
      reason:
        | "no_business"
        | "no_period_bounds"
        | "period_stale"
        | "rpc_error"
        | "no_call"
        | "no_duration";
    };

function tierCapSecondsFor(tier: string, enterpriseLimitsRaw: unknown): number {
  if (tier === "enterprise") {
    return resolveEnterpriseVoiceReservation(enterpriseLimitsRaw).tierCapSeconds;
  }
  if (tier === "standard") {
    return VOICE_RES_LIMITS.standard.voiceIncludedSecondsPerStripePeriod;
  }
  return VOICE_RES_LIMITS.starter.voiceIncludedSecondsPerStripePeriod;
}

/**
 * Meter one forwarded call's carrier seconds against the tenant's voice pool.
 * Idempotent per callControlId (safe on duplicate webhook deliveries).
 */
export async function meterForwardedCallSeconds(
  supabase: ForwardedMeterSupabase,
  opts: {
    businessId: string;
    /** The metered leg's call_control_id (idempotency key). */
    callControlId: string;
    /** Telnyx-reported call_duration for the leg, in seconds. */
    reportedSeconds: number | null;
    /** Ledger tag: warm_transfer | handoff_chain | ... */
    context: string;
  }
): Promise<ForwardedMeterResult> {
  const { businessId, callControlId, reportedSeconds, context } = opts;
  try {
    if (!callControlId) return { status: "skipped", reason: "no_call" };
    if (reportedSeconds == null || !Number.isFinite(reportedSeconds)) {
      // A hangup without call_duration gives us nothing defensible to bill.
      await telemetryRecord(supabase, "voice_forwarded_meter_skipped", {
        business_id: businessId,
        call_control_id: callControlId,
        context,
        reason: "no_duration"
      });
      return { status: "skipped", reason: "no_duration" };
    }

    const { data: biz, error: bizErr } = await supabase
      .from("businesses")
      .select("tier, enterprise_limits")
      .eq("id", businessId)
      .single();
    if (bizErr || !biz) {
      await telemetryRecord(supabase, "voice_forwarded_meter_skipped", {
        business_id: businessId,
        call_control_id: callControlId,
        context,
        reason: "no_business"
      });
      return { status: "skipped", reason: "no_business" };
    }
    const bizRow = biz as { tier?: unknown; enterprise_limits?: unknown };
    const tier = String(bizRow.tier ?? "starter");
    const cap = tierCapSecondsFor(tier, tier === "enterprise" ? bizRow.enterprise_limits : null);

    const { data: sub } = await supabase
      .from("subscriptions")
      .select("stripe_current_period_start, stripe_current_period_end")
      .eq("business_id", businessId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const subRow = sub as {
      stripe_current_period_start?: unknown;
      stripe_current_period_end?: unknown;
    } | null;
    const periodStartRaw = (subRow?.stripe_current_period_start as string | null) ?? null;
    const periodEndRaw = (subRow?.stripe_current_period_end as string | null) ?? null;
    if (!periodStartRaw || !periodEndRaw) {
      await telemetryRecord(supabase, "voice_forwarded_meter_skipped", {
        business_id: businessId,
        call_control_id: callControlId,
        context,
        reason: "no_period_bounds"
      });
      return { status: "skipped", reason: "no_period_bounds" };
    }
    // A cache past its period end would derive a month-window key for the OLD
    // Stripe period — a different usage row than the reserve gate (which JIT-
    // refreshes) reads, so the commit would be invisible to the cap. Skip with
    // telemetry instead; ops can backfill once the cache refreshes. Same
    // staleness rule as checkVoiceBudgetAvailable.
    if (Date.now() > new Date(periodEndRaw).getTime() + STRIPE_PERIOD_ROLLOVER_GRACE_MS) {
      await telemetryRecord(supabase, "voice_forwarded_meter_skipped", {
        business_id: businessId,
        call_control_id: callControlId,
        context,
        reason: "period_stale"
      });
      return { status: "skipped", reason: "period_stale" };
    }

    // Same month-window key as voice_reserve/checkVoiceBudgetAvailable — the
    // meter must write the SAME usage row the gate reads.
    const periodStart = new Date(
      deriveMonthlyQuotaWindow(periodStartRaw, Date.now()).startIso
    ).toISOString();

    const { data: rpcData, error: rpcErr } = await supabase.rpc("voice_meter_forwarded_call", {
      p_business_id: businessId,
      p_call_control_id: callControlId,
      p_reported_seconds: Math.max(0, Math.floor(reportedSeconds)),
      p_stripe_period_start: periodStart,
      p_tier_cap_seconds: cap,
      p_context: context
    });
    if (rpcErr) {
      console.error("voice_meter_forwarded_call rpc", rpcErr);
      await telemetryRecord(supabase, "voice_forwarded_meter_skipped", {
        business_id: businessId,
        call_control_id: callControlId,
        context,
        reason: "rpc_error",
        detail: rpcErr.message
      });
      return { status: "skipped", reason: "rpc_error" };
    }
    const res = rpcData as {
      ok?: boolean;
      duplicate?: boolean;
      billable_seconds?: number;
    } | null;
    if (res?.duplicate) return { status: "duplicate" };
    const billable = typeof res?.billable_seconds === "number" ? res.billable_seconds : 0;
    if (billable <= 0) return { status: "zero" };
    await telemetryRecord(supabase, "voice_forwarded_call_metered", {
      business_id: businessId,
      call_control_id: callControlId,
      context,
      reported_seconds: Math.floor(reportedSeconds),
      billable_seconds: billable
    });
    return { status: "metered", billableSeconds: billable };
  } catch (err) {
    console.error("meterForwardedCallSeconds threw", err);
    return { status: "skipped", reason: "rpc_error" };
  }
}
