/**
 * Read-only voice quota snapshot for dashboard / preflight UX (§4). Enforcement remains on Edge RPCs.
 */
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { getTierLimits } from "@/lib/plans/limits";
import type { PlanTier } from "@/lib/plans/tier";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export type VoiceBillingSnapshot = {
  stripePeriodStart: string | null;
  tierCapSeconds: number;
  committedIncludedSeconds: number;
  reservedIncludedInflight: number;
  includedHeadroomSeconds: number;
  bonusSecondsAvailable: number;
};

/**
 * Current Stripe-period included headroom + bonus pool (approximate; inflight = sum of reservation rows).
 */
export async function getVoiceBillingSnapshotForBusiness(
  businessId: string,
  client?: SupabaseClient
): Promise<VoiceBillingSnapshot | null> {
  const db = client ?? (await createSupabaseServiceClient());

  const { data: biz, error: bizErr } = await db
    .from("businesses")
    .select("tier, enterprise_limits")
    .eq("id", businessId)
    .maybeSingle();
  if (bizErr || !biz) return null;

  const tier = String(biz.tier ?? "starter") as PlanTier;
  const entRaw = tier === "enterprise" ? biz.enterprise_limits : undefined;
  const limits = getTierLimits(tier, entRaw);

  const { data: sub, error: subErr } = await db
    .from("subscriptions")
    .select("stripe_current_period_start")
    .eq("business_id", businessId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (subErr || !sub?.stripe_current_period_start) return null;

  const periodStart = sub.stripe_current_period_start as string;

  const { data: usageRow } = await db
    .from("voice_billing_period_usage")
    .select("tier_cap_seconds, committed_included_seconds")
    .eq("business_id", businessId)
    .eq("stripe_period_start", periodStart)
    .maybeSingle();

  const tierCap = Number(usageRow?.tier_cap_seconds ?? limits.voiceIncludedSecondsPerStripePeriod);
  const committed = Number(usageRow?.committed_included_seconds ?? 0);

  const { data: resvRows } = await db
    .from("voice_reservations")
    .select("reserved_included_seconds")
    .eq("business_id", businessId)
    .eq("stripe_period_start_key", periodStart)
    .in("state", ["pending_answer", "active"]);

  let reservedSum = 0;
  for (const r of resvRows ?? []) {
    reservedSum += Number((r as { reserved_included_seconds?: number }).reserved_included_seconds ?? 0);
  }

  const nowIso = new Date().toISOString();
  const { data: bonusRows } = await db
    .from("voice_bonus_grants")
    .select("seconds_remaining")
    .eq("business_id", businessId)
    .is("voided_at", null)
    .gt("expires_at", nowIso);

  let bonus = 0;
  for (const g of bonusRows ?? []) {
    bonus += Number((g as { seconds_remaining?: number }).seconds_remaining ?? 0);
  }

  const headroom = Math.max(0, tierCap - committed - reservedSum);

  return {
    stripePeriodStart: periodStart,
    tierCapSeconds: tierCap,
    committedIncludedSeconds: committed,
    reservedIncludedInflight: reservedSum,
    includedHeadroomSeconds: headroom,
    bonusSecondsAvailable: bonus
  };
}
