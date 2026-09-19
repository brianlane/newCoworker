/**
 * Read-only voice quota snapshot for dashboard / preflight UX (§4). Enforcement remains on Edge RPCs.
 *
 * PLAN-card display (included + unexpired pack grant size) lives in
 * `src/lib/plans/usage-meters.ts`. Auto-reload still uses remaining
 * headroom (`includedHeadroomSeconds + bonusSecondsAvailable`), not the
 * PLAN denominator.
 */
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { getTierLimits } from "@/lib/plans/limits";
import type { PlanTier } from "@/lib/plans/tier";
import { deriveMonthlyQuotaWindow } from "../../../supabase/functions/_shared/billing_period_window";
import { soonestExpiryAt } from "@/lib/billing/usage-period";
import { sumUsageGrants } from "@/lib/plans/usage-meters";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export type VoiceBillingSnapshot = {
  stripePeriodStart: string | null;
  tierCapSeconds: number;
  committedIncludedSeconds: number;
  reservedIncludedInflight: number;
  includedHeadroomSeconds: number;
  bonusSecondsAvailable: number;
  /**
   * Full grant size (`seconds_purchased`) of unexpired, unvoided packs.
   * PLAN denominator adds this, not leftover `bonusSecondsAvailable`.
   */
  bonusSecondsPurchased: number;
  /**
   * Seconds already drawn from those same unexpired packs
   * (`purchased - remaining` per grant). PLAN numerator adds this on top
   * of `committedIncludedSeconds`.
   */
  bonusSecondsConsumed: number;
  /**
   * Expiry of the soonest-expiring bonus grant that still HOLDS minutes.
   * Packs expire in tranches, so this is the next date the displayed bonus
   * balance drops. Null when no live pack has minutes left.
   */
  bonusSoonestExpiresAt: string | null;
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

  // Mirror the Edge reserve path's quota key: the current month-window within
  // the Stripe period (prepaid 12/24-month plans have a term-long period but
  // included minutes reset monthly). Normalized through Date to match
  // voice_reserve.ts exactly.
  const quotaWindow = deriveMonthlyQuotaWindow(
    sub.stripe_current_period_start as string,
    Date.now()
  );
  const periodStart = new Date(quotaWindow.startIso).toISOString();

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
    .select("seconds_purchased, seconds_remaining, expires_at")
    .eq("business_id", businessId)
    .is("voided_at", null)
    .gt("expires_at", nowIso);

  const grantInputs: { purchased: number; remaining: number }[] = [];
  // Expiries come from the rows already fetched for the balance rather than a
  // second query. A drained grant is skipped: its expiry is not a date any
  // displayed balance disappears on, so surfacing it would be misleading.
  const liveExpiries: (string | null)[] = [];
  for (const g of bonusRows ?? []) {
    const row = g as {
      seconds_purchased?: number;
      seconds_remaining?: number;
      expires_at?: string | null;
    };
    grantInputs.push({
      purchased: row.seconds_purchased ?? 0,
      remaining: row.seconds_remaining ?? 0
    });
    const seconds = Number(row.seconds_remaining ?? 0);
    if (seconds > 0) liveExpiries.push(row.expires_at ?? null);
  }
  const bonusTotals = sumUsageGrants(grantInputs);

  const headroom = Math.max(0, tierCap - committed - reservedSum);

  return {
    stripePeriodStart: periodStart,
    tierCapSeconds: tierCap,
    committedIncludedSeconds: committed,
    reservedIncludedInflight: reservedSum,
    includedHeadroomSeconds: headroom,
    bonusSecondsAvailable: bonusTotals.remaining,
    bonusSecondsPurchased: bonusTotals.purchased,
    bonusSecondsConsumed: bonusTotals.consumed,
    bonusSoonestExpiresAt: soonestExpiryAt(liveExpiries)
  };
}
