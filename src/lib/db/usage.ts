import { createSupabaseServiceClient } from "@/lib/supabase/server";
import type { PlanTier } from "@/lib/plans/tier";
import { TIER_LIMITS } from "@/lib/plans/limits";

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

export async function incrementUsage(
  businessId: string,
  field: UsageField,
  amount: number,
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const today = new Date().toISOString().slice(0, 10);

  // Upsert: insert with initial value or increment existing
  const { data: existing } = await db
    .from("daily_usage")
    .select("id," + field)
    .eq("business_id", businessId)
    .eq("usage_date", today)
    .single();

  if (existing) {
    const currentVal = (existing as Record<string, unknown>)[field] as number ?? 0;
    const { error } = await db
      .from("daily_usage")
      .update({
        [field]: currentVal + amount,
        updated_at: new Date().toISOString()
      })
      .eq("business_id", businessId)
      .eq("usage_date", today);

    if (error) throw new Error(`incrementUsage update: ${error.message}`);
  } else {
    const { error } = await db
      .from("daily_usage")
      .insert({
        business_id: businessId,
        usage_date: today,
        [field]: amount
      });

    if (error) throw new Error(`incrementUsage insert: ${error.message}`);
  }
}

export async function checkLimitReached(
  businessId: string,
  tier: PlanTier,
  client?: SupabaseClient
): Promise<LimitCheckResult> {
  const limits = TIER_LIMITS[tier];

  // Enterprise and standard have no daily caps (Infinity)
  if (
    limits.voiceMinutesPerDay === Infinity &&
    limits.smsPerDay === Infinity &&
    limits.callsPerDay === Infinity
  ) {
    return { allowed: true };
  }

  const usage = await getTodayUsage(businessId, client);

  if (!usage) {
    return { allowed: true };
  }

  if (usage.voice_minutes_used >= limits.voiceMinutesPerDay) {
    return {
      allowed: false,
      reason: `Daily voice limit reached (${limits.voiceMinutesPerDay} minutes/day)`,
      field: "voice_minutes_used"
    };
  }

  if (usage.sms_sent >= limits.smsPerDay) {
    return {
      allowed: false,
      reason: `Daily SMS limit reached (${limits.smsPerDay} SMS/day)`,
      field: "sms_sent"
    };
  }

  if (usage.calls_made >= limits.callsPerDay) {
    return {
      allowed: false,
      reason: `Daily call limit reached (${limits.callsPerDay} calls/day)`,
      field: "calls_made"
    };
  }

  return { allowed: true };
}
