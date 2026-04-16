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
