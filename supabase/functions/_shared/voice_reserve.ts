/**
 * System-level voice budget gate.
 *
 * Any path that is about to spend Google/Gemini voice minutes (the inbound AI
 * receptionist, the HomeLight warm-handoff AI takeover, and any future voice
 * AiFlow) MUST pass through `reserveVoiceBudget` first. It resolves the tenant's
 * tier cap + concurrency, refreshes the Stripe billing period when stale, and
 * calls the `voice_reserve_for_call` RPC (the single source of truth for
 * concurrency + remaining-minutes accounting). A non-`ok` result means the call
 * must NOT use the AI bridge — the caller decides how to degrade (speak a
 * message and hang up for inbound; abort the takeover for the handoff chain).
 *
 * Centralizing this here keeps metering a system-level invariant rather than a
 * per-AiFlow concern: a new voice entry point gets budget enforcement for free
 * by calling this helper instead of re-implementing tier/period/reserve logic.
 *
 * Deno edge module: imported by telnyx-voice-inbound and telnyx-voice-call-end.
 */
import { resolveEnterpriseVoiceReservation } from "./enterprise_limits.ts";
import { VOICE_RES_LIMITS } from "./voice_reservation_limits.ts";
import { telemetryRecord } from "./telemetry.ts";
import {
  cacheLooksValidForQuotaAfterJitFailure,
  STRIPE_PERIOD_ROLLOVER_GRACE_MS,
  subscriptionPeriodNeedsRefresh,
  type SubscriptionPeriodRow
} from "./stripe_voice_period.ts";

/** Max wall-clock for the JIT Stripe subscription fetch before we give up (§4.2). */
export const STRIPE_JIT_FETCH_MS = 4500;

type QueryResult = { data: unknown; error: { message: string } | null };

/**
 * Minimal structural Supabase shape for this module (matches the chains used
 * below). Mirrors the structural-typing convention in telemetry.ts / system_log.ts
 * so the file type-checks under Node tsc without importing the esm.sh client.
 */
type ReserveSupabase = {
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
    update: (row: Record<string, unknown>) => {
      eq: (col: string, val: unknown) => PromiseLike<{ error: { message: string } | null }>;
    };
  };
  rpc: (
    fn: string,
    args?: Record<string, unknown>
  ) => PromiseLike<{ data: unknown; error: { message: string } | null }>;
};

export function tierCapSeconds(tier: string, enterpriseLimitsRaw: unknown): number {
  if (tier === "enterprise") {
    return resolveEnterpriseVoiceReservation(enterpriseLimitsRaw).tierCapSeconds;
  }
  if (tier === "standard") {
    return VOICE_RES_LIMITS.standard.voiceIncludedSecondsPerStripePeriod;
  }
  return VOICE_RES_LIMITS.starter.voiceIncludedSecondsPerStripePeriod;
}

export function maxConcurrent(tier: string, enterpriseLimitsRaw: unknown): number {
  if (tier === "enterprise") {
    return resolveEnterpriseVoiceReservation(enterpriseLimitsRaw).maxConcurrent;
  }
  if (tier === "standard") {
    return VOICE_RES_LIMITS.standard.maxConcurrentCalls;
  }
  return VOICE_RES_LIMITS.starter.maxConcurrentCalls;
}

async function fetchStripeSubscriptionPeriods(
  stripeSecret: string,
  stripeSubscriptionId: string
): Promise<{ start: string; end: string } | null> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), STRIPE_JIT_FETCH_MS);
  try {
    const res = await fetch(
      `https://api.stripe.com/v1/subscriptions/${encodeURIComponent(stripeSubscriptionId)}`,
      { headers: { Authorization: `Bearer ${stripeSecret}` }, signal: ac.signal }
    );
    if (!res.ok) {
      console.error("Stripe subscription HTTP", res.status, (await res.text()).slice(0, 500));
      return null;
    }
    const j = (await res.json()) as { current_period_start?: unknown; current_period_end?: unknown };
    if (typeof j.current_period_start !== "number" || typeof j.current_period_end !== "number") {
      return null;
    }
    return {
      start: new Date(j.current_period_start * 1000).toISOString(),
      end: new Date(j.current_period_end * 1000).toISOString()
    };
  } catch (e) {
    // Timeout (abort) or network error → treat as a failed JIT refresh so the
    // caller falls back to the §4.2 cached-period heuristic instead of throwing.
    console.error("Stripe subscription fetch error", e);
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function persistSubscriptionPeriodCache(
  supabase: ReserveSupabase,
  row: SubscriptionPeriodRow,
  start: string,
  end: string
): Promise<boolean> {
  const stripe_subscription_cached_at = new Date().toISOString();
  const { error } = await supabase
    .from("subscriptions")
    .update({
      stripe_current_period_start: start,
      stripe_current_period_end: end,
      stripe_subscription_cached_at
    })
    .eq("id", row.id);
  if (error) {
    console.error("subscriptions period cache update", error);
    return false;
  }
  return true;
}

/**
 * Why a reservation was refused. `*_error`/`no_*`/`*_stale` are system faults
 * (caller should speak a generic system-error); `concurrent_limit` and
 * `quota_exhausted` are expected capacity/budget refusals.
 */
export type VoiceReserveBlockReason =
  | "no_business"
  | "sub_db_error"
  | "no_subscription"
  | "jit_stripe_fail_block"
  | "period_cache_stale"
  | "no_period_bounds"
  | "reserve_error"
  | "concurrent_limit"
  | "quota_exhausted";

export type VoiceReserveResult =
  | { ok: true; grantSeconds: number; duplicate: boolean }
  | { ok: false; reason: VoiceReserveBlockReason };

/**
 * Resolve tier + Stripe period and atomically reserve voice minutes for a call.
 * Idempotent per `callControlId` (the RPC returns `duplicate` for a repeat).
 * Emits the §4.2 JIT telemetry internally so every voice path reports it
 * consistently. Never throws — failures map to a `VoiceReserveBlockReason`.
 */
export async function reserveVoiceBudget(
  supabase: ReserveSupabase,
  opts: {
    businessId: string;
    callControlId: string;
    stripeSecret: string;
    minGrantSeconds?: number;
    maxGrantSeconds?: number;
  }
): Promise<VoiceReserveResult> {
  const { businessId, callControlId, stripeSecret } = opts;
  const minGrantSeconds = opts.minGrantSeconds ?? 60;
  const maxGrantSeconds = opts.maxGrantSeconds ?? 900;

  const { data: biz, error: bizErr } = await supabase
    .from("businesses")
    .select("tier, enterprise_limits")
    .eq("id", businessId)
    .single();
  if (bizErr || !biz) {
    console.error("voice_reserve: business", bizErr);
    return { ok: false, reason: "no_business" };
  }
  const bizRow = biz as { tier?: unknown; enterprise_limits?: unknown };

  const tier = String(bizRow.tier ?? "starter");
  const entRaw = tier === "enterprise" ? bizRow.enterprise_limits : null;
  const cap = tierCapSeconds(tier, entRaw);
  const concurrent = maxConcurrent(tier, entRaw);

  const { data: sub, error: subErr } = await supabase
    .from("subscriptions")
    .select(
      "id, stripe_subscription_id, stripe_current_period_start, stripe_current_period_end, stripe_subscription_cached_at"
    )
    .eq("business_id", businessId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (subErr) {
    console.error("voice_reserve: subscription", subErr);
    return { ok: false, reason: "sub_db_error" };
  }
  const subRow = sub as {
    id?: unknown;
    stripe_subscription_id?: unknown;
    stripe_current_period_start?: unknown;
    stripe_current_period_end?: unknown;
    stripe_subscription_cached_at?: unknown;
  } | null;
  if (!subRow?.id) {
    console.error("voice_reserve: no subscription row", { businessId });
    return { ok: false, reason: "no_subscription" };
  }

  let periodRow: SubscriptionPeriodRow = {
    id: subRow.id as string,
    stripe_subscription_id: (subRow.stripe_subscription_id as string | null) ?? null,
    stripe_current_period_start: (subRow.stripe_current_period_start as string | null) ?? null,
    stripe_current_period_end: (subRow.stripe_current_period_end as string | null) ?? null,
    stripe_subscription_cached_at: (subRow.stripe_subscription_cached_at as string | null) ?? null
  };

  const needsJit = subscriptionPeriodNeedsRefresh(periodRow, stripeSecret);
  let jitFailed = false;
  if (needsJit) {
    // needsJit ⇒ subscriptionPeriodNeedsRefresh required both a Stripe secret and
    // a stripe_subscription_id, so `sid` is always present here.
    const sid = periodRow.stripe_subscription_id as string;
    const fetched = await fetchStripeSubscriptionPeriods(stripeSecret, sid);
    if (fetched) {
      periodRow = {
        ...periodRow,
        stripe_current_period_start: fetched.start,
        stripe_current_period_end: fetched.end,
        stripe_subscription_cached_at: new Date().toISOString()
      };
      const okWrite = await persistSubscriptionPeriodCache(
        supabase,
        periodRow,
        fetched.start,
        fetched.end
      );
      if (!okWrite) {
        console.error("voice_reserve: Stripe period refreshed but DB cache write failed", {
          businessId
        });
      }
    } else {
      jitFailed = true;
      console.error("voice_reserve: JIT Stripe subscription fetch failed (§4.2)", { businessId });
    }
  }

  if (jitFailed) {
    if (cacheLooksValidForQuotaAfterJitFailure(periodRow, Date.now())) {
      await telemetryRecord(supabase, "jit_stripe_fail_proceed_cached", { business_id: businessId });
    } else {
      await telemetryRecord(supabase, "jit_stripe_fail_block", { business_id: businessId });
      return { ok: false, reason: "jit_stripe_fail_block" };
    }
  }

  const pastEnd =
    !!periodRow.stripe_current_period_end &&
    Date.now() >
      new Date(periodRow.stripe_current_period_end as string).getTime() +
        STRIPE_PERIOD_ROLLOVER_GRACE_MS;
  if (pastEnd) {
    console.error("voice_reserve: stripe period cache past period_end", { businessId });
    return { ok: false, reason: "period_cache_stale" };
  }

  if (!periodRow.stripe_current_period_start || !periodRow.stripe_current_period_end) {
    console.error("voice_reserve: missing cached Stripe billing period bounds", { businessId });
    return { ok: false, reason: "no_period_bounds" };
  }

  const periodStart = new Date(periodRow.stripe_current_period_start as string).toISOString();

  const { data: reserveResult, error: resErr } = await supabase.rpc("voice_reserve_for_call", {
    p_business_id: businessId,
    p_call_control_id: callControlId,
    p_tier: tier,
    p_max_concurrent: concurrent,
    p_stripe_period_start: periodStart,
    p_tier_cap_seconds: cap,
    p_min_grant_seconds: minGrantSeconds,
    p_max_grant_seconds: maxGrantSeconds
  });
  if (resErr) {
    console.error("voice_reserve: reserve RPC", resErr);
    return { ok: false, reason: "reserve_error" };
  }

  const res = reserveResult as {
    ok?: boolean;
    reason?: string;
    grant_seconds?: number;
    duplicate?: boolean;
  };
  if (!res?.ok) {
    return {
      ok: false,
      reason: res?.reason === "concurrent_limit" ? "concurrent_limit" : "quota_exhausted"
    };
  }
  return {
    ok: true,
    grantSeconds: typeof res.grant_seconds === "number" ? res.grant_seconds : 0,
    duplicate: Boolean(res.duplicate)
  };
}

/**
 * Result of a pre-dial availability probe.
 *   - ok: a reservation of at least minGrantSeconds could be granted now.
 *   - blocked: definitively over budget / at the concurrency cap — the caller
 *     should NOT dial (don't ring the callee for an over-budget tenant).
 *   - indeterminate: we couldn't decide cheaply (no/stale cached billing
 *     period, missing rows, RPC error). The caller should proceed to dial and
 *     rely on the authoritative post-dial reserveVoiceBudget (which performs the
 *     JIT Stripe refresh) as the real gate — failing OPEN here only risks one
 *     wasted pre-answer dial, never billed minutes.
 */
export type VoiceAvailability =
  | { status: "ok"; remainingSeconds: number; bonusSeconds: number }
  | { status: "blocked"; reason: "concurrent_limit" | "quota_exhausted" }
  | {
      status: "indeterminate";
      reason: "no_business" | "no_period_bounds" | "period_stale" | "check_error";
    };

/**
 * READ-ONLY pre-dial budget gate for outbound voice. Resolves the tenant's
 * tier cap + concurrency and the CACHED Stripe period (no JIT refresh — the
 * post-dial reserve owns that), then calls the read-only
 * `voice_check_availability` RPC. Never throws: anything it can't resolve maps
 * to `indeterminate` so origination falls through to the authoritative reserve.
 *
 * Why this exists: `reserveVoiceBudget` keys a reservation by a Telnyx
 * call_control_id, which only exists once dialing has started. To honor
 * "metered before spend" WITHOUT minting a reservation, callers probe here
 * first and skip dialing entirely when the answer is a definitive refusal.
 */
export async function checkVoiceBudgetAvailable(
  supabase: ReserveSupabase,
  opts: { businessId: string; minGrantSeconds?: number }
): Promise<VoiceAvailability> {
  const { businessId } = opts;
  const minGrantSeconds = opts.minGrantSeconds ?? 60;

  const { data: biz, error: bizErr } = await supabase
    .from("businesses")
    .select("tier, enterprise_limits")
    .eq("id", businessId)
    .single();
  if (bizErr || !biz) {
    console.error("voice_check: business", bizErr);
    return { status: "indeterminate", reason: "no_business" };
  }
  const bizRow = biz as { tier?: unknown; enterprise_limits?: unknown };
  const tier = String(bizRow.tier ?? "starter");
  const entRaw = tier === "enterprise" ? bizRow.enterprise_limits : null;
  const cap = tierCapSeconds(tier, entRaw);
  const concurrent = maxConcurrent(tier, entRaw);

  const { data: sub, error: subErr } = await supabase
    .from("subscriptions")
    .select("stripe_current_period_start, stripe_current_period_end")
    .eq("business_id", businessId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (subErr) {
    console.error("voice_check: subscription", subErr);
    return { status: "indeterminate", reason: "check_error" };
  }
  const subRow = sub as {
    stripe_current_period_start?: unknown;
    stripe_current_period_end?: unknown;
  } | null;
  const periodStartRaw = (subRow?.stripe_current_period_start as string | null) ?? null;
  const periodEndRaw = (subRow?.stripe_current_period_end as string | null) ?? null;
  if (!periodStartRaw || !periodEndRaw) {
    return { status: "indeterminate", reason: "no_period_bounds" };
  }

  // A stale cached period would make the headroom math wrong; defer to the
  // post-dial reserve, which refreshes the period from Stripe before deciding.
  if (Date.now() > new Date(periodEndRaw).getTime() + STRIPE_PERIOD_ROLLOVER_GRACE_MS) {
    return { status: "indeterminate", reason: "period_stale" };
  }

  const periodStart = new Date(periodStartRaw).toISOString();
  const { data: availData, error: availErr } = await supabase.rpc("voice_check_availability", {
    p_business_id: businessId,
    p_max_concurrent: concurrent,
    p_stripe_period_start: periodStart,
    p_tier_cap_seconds: cap,
    p_min_grant_seconds: minGrantSeconds
  });
  if (availErr) {
    console.error("voice_check: rpc", availErr);
    return { status: "indeterminate", reason: "check_error" };
  }
  const avail = availData as {
    ok?: boolean;
    reason?: string;
    remaining_seconds?: number;
    bonus_seconds_available?: number;
  } | null;
  if (avail?.ok === true) {
    return {
      status: "ok",
      remainingSeconds: typeof avail.remaining_seconds === "number" ? avail.remaining_seconds : 0,
      bonusSeconds:
        typeof avail.bonus_seconds_available === "number" ? avail.bonus_seconds_available : 0
    };
  }
  return {
    status: "blocked",
    reason: avail?.reason === "concurrent_limit" ? "concurrent_limit" : "quota_exhausted"
  };
}
