/**
 * `daily_usage` helpers and soft limit checks for the Next.js app.
 *
 * **Enforcement** for billable SMS/voice is RPC- and Edge-first (e.g. `try_reserve_sms_outbound_slot`,
 * `check_sms_monthly_limit`, `voice_reserve_for_call`). Call those paths (or `sendTelnyxSms` with
 * `meterBusinessId`) for anything that must not bypass caps. Use `checkLimitReached` only for optional
 * preflight UX; `incrementUsage` is a thin wrapper over the `increment_usage` RPC if you need to
 * mutate counters from Node (most metering is handled inside Supabase functions / Telnyx webhooks).
 *
 * For **Stripe-period included voice + bonus** display logic, see `getVoiceBillingSnapshotForBusiness` in
 * `voice-usage.ts` (read-only; caps in `getTierLimits` / `VOICE_RES_LIMITS`).
 */
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import type { PlanTier } from "@/lib/plans/tier";
import { getTierLimits } from "@/lib/plans/limits";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export type DailyUsageRow = {
  id: string;
  business_id: string;
  usage_date: string;
  voice_minutes_used: number;
  sms_sent: number;
  calls_made: number;
  peak_concurrent_calls: number;
  created_at: string;
  updated_at: string;
};

export type UsageField = "voice_minutes_used" | "sms_sent" | "calls_made" | "peak_concurrent_calls";

export type LimitCheckResult = {
  allowed: boolean;
  reason?: string;
  field?: UsageField;
};

function calendarMonthStartUtcYmd(): string {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  return `${y}-${String(m).padStart(2, "0")}-01`;
}

export async function getTodayUsage(
  businessId: string,
  client?: SupabaseClient
): Promise<DailyUsageRow | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const today = new Date().toISOString().slice(0, 10);

  const { data, error } = await db
    .from("daily_usage")
    .select()
    .eq("business_id", businessId)
    .eq("usage_date", today)
    .single();

  if (error) return null;
  return data as DailyUsageRow;
}

/** Sum SMS and outbound calls for the current UTC calendar month from `daily_usage`. */
export async function getCalendarMonthUsageTotals(
  businessId: string,
  client?: SupabaseClient
): Promise<{ sms_sent: number; calls_made: number }> {
  const db = client ?? (await createSupabaseServiceClient());
  const monthStart = calendarMonthStartUtcYmd();
  const { data, error } = await db
    .from("daily_usage")
    .select("sms_sent, calls_made")
    .eq("business_id", businessId)
    .gte("usage_date", monthStart);

  if (error) {
    console.error("getCalendarMonthUsageTotals", error);
    throw new Error(`getCalendarMonthUsageTotals: ${error.message}`);
  }

  let sms = 0;
  let calls = 0;
  for (const row of data ?? []) {
    const r = row as { sms_sent?: number | null; calls_made?: number | null };
    sms += Number(r.sms_sent ?? 0);
    calls += Number(r.calls_made ?? 0);
  }
  return { sms_sent: sms, calls_made: calls };
}

/**
 * FLEET-WIDE current-UTC-calendar-month usage rollup (admin dashboard
 * platform-cost estimate):
 *
 * - SMS from `daily_usage.sms_sent` (live writer: the `increment_usage`
 *   RPC on every metered send).
 * - Voice minutes from `voice_settlements.billable_seconds` — the settled
 *   Telnyx ground truth. `daily_usage.voice_minutes_used` is deliberately
 *   NOT used: it has no live production writer (voice quota moved to the
 *   Stripe-period Telnyx pool), so summing it would report ~zero voice
 *   cost forever.
 *
 * Both reads page in 1000-row chunks — PostgREST silently caps a single
 * request at 1000 rows, which would otherwise under-report usage without
 * any error as the fleet grows. Orderings (`id`; `created_at` +
 * `call_control_id`, the settlements PK) keep `.range()` page boundaries
 * deterministic.
 */
export async function getFleetCalendarMonthUsageTotals(
  client?: SupabaseClient
): Promise<{ smsSent: number; voiceMinutes: number }> {
  const db = client ?? (await createSupabaseServiceClient());
  const monthStartYmd = calendarMonthStartUtcYmd();
  const pageSize = 1000;

  let smsSent = 0;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await db
      .from("daily_usage")
      .select("sms_sent")
      .gte("usage_date", monthStartYmd)
      .order("id", { ascending: true })
      .range(from, from + pageSize - 1);

    if (error) throw new Error(`getFleetCalendarMonthUsageTotals: ${error.message}`);

    const rows = data ?? [];
    for (const row of rows) {
      smsSent += Number((row as { sms_sent?: number | null }).sms_sent ?? 0);
    }
    if (rows.length < pageSize) break;
  }

  let billableSeconds = 0;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await db
      .from("voice_settlements")
      .select("billable_seconds")
      .gte("created_at", `${monthStartYmd}T00:00:00.000Z`)
      .order("created_at", { ascending: true })
      .order("call_control_id", { ascending: true })
      .range(from, from + pageSize - 1);

    if (error) throw new Error(`getFleetCalendarMonthUsageTotals: ${error.message}`);

    const rows = data ?? [];
    for (const row of rows) {
      billableSeconds += Number(
        (row as { billable_seconds?: number | null }).billable_seconds ?? 0
      );
    }
    if (rows.length < pageSize) break;
  }

  return { smsSent, voiceMinutes: billableSeconds / 60 };
}

export type BusinessMonthUsage = {
  smsSent: number;
  voiceMinutes: number;
  callsMade: number;
  peakConcurrentCalls: number;
};

export type UsageWindow = {
  /** Inclusive UTC start day, YYYY-MM-DD. */
  startYmd: string;
  /** Exclusive UTC end day, YYYY-MM-DD; omit for an open-ended window. */
  endYmdExclusive?: string;
};

/**
 * Peak concurrent calls from a set of [start, end) call intervals: sweep
 * the start/+1 and end/-1 events in time order, counting the maximum
 * simultaneously-open calls. An end at the exact instant of another
 * call's start does NOT overlap it (ends sort before starts).
 */
export function peakConcurrentFromIntervals(
  intervals: Array<{ startMs: number; endMs: number }>
): number {
  const events: Array<{ atMs: number; delta: 1 | -1 }> = [];
  for (const { startMs, endMs } of intervals) {
    events.push({ atMs: startMs, delta: 1 });
    events.push({ atMs: endMs, delta: -1 });
  }
  events.sort((a, b) => a.atMs - b.atMs || a.delta - b.delta);
  let open = 0;
  let peak = 0;
  for (const event of events) {
    open += event.delta;
    if (open > peak) peak = open;
  }
  return peak;
}

/**
 * Per-business variant of {@link getFleetCalendarMonthUsageTotals} for the
 * admin Usage page and the margin engine, grouped by business. Same paging
 * + ordering rationale. Defaults to the current UTC calendar month; pass
 * `window` for a historical month. Sources:
 *
 * - SMS from `daily_usage.sms_sent` (live writer: the SMS reserve RPCs).
 * - Voice minutes AND call counts from `voice_settlements` — each row is
 *   one settled call. `daily_usage.calls_made` is deliberately NOT used:
 *   like `voice_minutes_used`, it has no live production writer (the SMS
 *   reserve path inserts it as zero), so reading it rendered permanent
 *   zeros next to real settled minutes.
 * - Peak concurrent calls from `voice_call_transcripts` started_at/ended_at
 *   overlap (missed calls excluded, same population as the owner analytics
 *   page; `daily_usage.peak_concurrent_calls` is dead for the same reason
 *   as `calls_made`). Rows without `ended_at` (in-progress or stuck) are
 *   skipped rather than treated as open forever. Central read only: a
 *   vps-residency tenant's purged transcript history can undercount its
 *   peak — acceptable for this operator-facing health metric.
 */
export async function getFleetCalendarMonthUsageByBusiness(
  client?: SupabaseClient,
  window?: UsageWindow
): Promise<Map<string, BusinessMonthUsage>> {
  const db = client ?? (await createSupabaseServiceClient());
  const monthStartYmd = window?.startYmd ?? calendarMonthStartUtcYmd();
  const monthEndYmd = window?.endYmdExclusive ?? null;
  const pageSize = 1000;

  const byBusiness = new Map<string, BusinessMonthUsage>();
  const entry = (businessId: string): BusinessMonthUsage => {
    let usage = byBusiness.get(businessId);
    if (!usage) {
      usage = { smsSent: 0, voiceMinutes: 0, callsMade: 0, peakConcurrentCalls: 0 };
      byBusiness.set(businessId, usage);
    }
    return usage;
  };

  for (let from = 0; ; from += pageSize) {
    let query = db
      .from("daily_usage")
      .select("business_id, sms_sent")
      .gte("usage_date", monthStartYmd);
    if (monthEndYmd !== null) query = query.lt("usage_date", monthEndYmd);
    const { data, error } = await query
      .order("id", { ascending: true })
      .range(from, from + pageSize - 1);

    if (error) throw new Error(`getFleetCalendarMonthUsageByBusiness: ${error.message}`);

    const rows = data ?? [];
    for (const row of rows) {
      const r = row as { business_id?: string; sms_sent?: number | null };
      if (!r.business_id) continue;
      entry(r.business_id).smsSent += Number(r.sms_sent ?? 0);
    }
    if (rows.length < pageSize) break;
  }

  for (let from = 0; ; from += pageSize) {
    let query = db
      .from("voice_settlements")
      .select("business_id, billable_seconds")
      .gte("created_at", `${monthStartYmd}T00:00:00.000Z`);
    if (monthEndYmd !== null) query = query.lt("created_at", `${monthEndYmd}T00:00:00.000Z`);
    const { data, error } = await query
      .order("created_at", { ascending: true })
      .order("call_control_id", { ascending: true })
      .range(from, from + pageSize - 1);

    if (error) throw new Error(`getFleetCalendarMonthUsageByBusiness: ${error.message}`);

    const rows = data ?? [];
    for (const row of rows) {
      const r = row as { business_id?: string; billable_seconds?: number | null };
      if (!r.business_id) continue;
      const usage = entry(r.business_id);
      usage.voiceMinutes += Number(r.billable_seconds ?? 0) / 60;
      usage.callsMade += 1;
    }
    if (rows.length < pageSize) break;
  }

  const intervalsByBusiness = new Map<string, Array<{ startMs: number; endMs: number }>>();
  for (let from = 0; ; from += pageSize) {
    let query = db
      .from("voice_call_transcripts")
      .select("business_id, started_at, ended_at")
      .neq("status", "missed")
      .gte("started_at", `${monthStartYmd}T00:00:00.000Z`);
    if (monthEndYmd !== null) query = query.lt("started_at", `${monthEndYmd}T00:00:00.000Z`);
    const { data, error } = await query
      .order("started_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, from + pageSize - 1);

    if (error) throw new Error(`getFleetCalendarMonthUsageByBusiness: ${error.message}`);

    const rows = data ?? [];
    for (const row of rows) {
      const r = row as {
        business_id?: string;
        started_at?: string | null;
        ended_at?: string | null;
      };
      if (!r.business_id || !r.started_at || !r.ended_at) continue;
      const startMs = Date.parse(r.started_at);
      const endMs = Date.parse(r.ended_at);
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) continue;
      let intervals = intervalsByBusiness.get(r.business_id);
      if (!intervals) {
        intervals = [];
        intervalsByBusiness.set(r.business_id, intervals);
      }
      intervals.push({ startMs, endMs });
    }
    if (rows.length < pageSize) break;
  }
  for (const [businessId, intervals] of intervalsByBusiness) {
    entry(businessId).peakConcurrentCalls = peakConcurrentFromIntervals(intervals);
  }

  return byBusiness;
}

export async function incrementUsage(
  businessId: string,
  field: UsageField,
  amount: number,
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());

  const { error } = await db.rpc("increment_usage", {
    p_business_id: businessId,
    p_field: field,
    p_amount: amount
  });

  if (error) throw new Error(`incrementUsage: ${error.message}`);
}

export async function checkLimitReached(
  businessId: string,
  tier: PlanTier,
  client?: SupabaseClient,
  enterpriseLimitsOverride?: unknown
): Promise<LimitCheckResult> {
  const limits = getTierLimits(tier, enterpriseLimitsOverride);

  if (limits.voiceMinutesPerDay === Infinity && limits.smsPerMonth === Infinity) {
    return { allowed: true };
  }

  if (limits.voiceMinutesPerDay !== Infinity) {
    const usage = await getTodayUsage(businessId, client);
    const voiceUsed = usage?.voice_minutes_used ?? 0;
    if (voiceUsed >= limits.voiceMinutesPerDay) {
      return {
        allowed: false,
        reason: `Daily voice limit reached (${limits.voiceMinutesPerDay} minutes/day)`,
        field: "voice_minutes_used"
      };
    }
  }

  if (limits.smsPerMonth !== Infinity) {
    let month: { sms_sent: number; calls_made: number };
    try {
      month = await getCalendarMonthUsageTotals(businessId, client);
    } catch (e) {
      console.error("checkLimitReached: monthly usage unavailable", e);
      return {
        allowed: false,
        reason: "Cannot verify monthly SMS usage. Please try again shortly.",
        field: "sms_sent"
      };
    }
    if (month.sms_sent >= limits.smsPerMonth) {
      return {
        allowed: false,
        reason: `Monthly SMS limit reached (${limits.smsPerMonth} SMS/month)`,
        field: "sms_sent"
      };
    }
  }

  return { allowed: true };
}
