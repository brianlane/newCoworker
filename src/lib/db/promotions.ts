/**
 * Admin promotions: the DB access layer.
 *
 * A `promotions` row is one promo code for the starter/standard memberships.
 * The row owns the whole lifecycle (active toggle, starts_at/ends_at window,
 * redemption cap, allowed tiers and periods); the Stripe coupon it points at
 * only prices the discount. `promotion_redemptions` records one row per
 * redeemed checkout, keyed by the Stripe session id so webhook retries cannot
 * double-count. See migration 20260821204012_promotions.
 */
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import type { BillingPeriod } from "@/lib/plans/tier";
import type { PromotionDuration, PromotionTier } from "@/lib/stripe/promotions";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export type PromotionRow = {
  id: string;
  code: string;
  name: string;
  /** Whole percentage points. Null when the promotion is a fixed amount off. */
  percent_off: number | null;
  /** Cents off. Null when the promotion is a percentage. */
  amount_off_cents: number | null;
  duration: PromotionDuration;
  duration_in_months: number | null;
  allowed_tiers: PromotionTier[];
  allowed_periods: BillingPeriod[];
  starts_at: string;
  ends_at: string | null;
  /** Null means unlimited. */
  max_redemptions: number | null;
  active: boolean;
  stripe_coupon_id: string;
  stripe_promotion_code_id: string;
  created_by: string;
  created_at: string;
  updated_at: string;
};

export type PromotionRedemptionRow = {
  id: string;
  promotion_id: string;
  business_id: string;
  tier: PromotionTier;
  billing_period: BillingPeriod;
  stripe_session_id: string;
  amount_discounted_cents: number;
  created_at: string;
};

/** Bounds mirrored from the table CHECKs so the API fails fast with a clear message. */
export const PROMOTION_CODE_MIN_LENGTH = 3;
export const PROMOTION_CODE_MAX_LENGTH = 40;
export const PROMOTION_AMOUNT_MIN_CENTS = 100;
export const PROMOTION_AMOUNT_MAX_CENTS = 100_000_000;
export const PROMOTION_DURATION_MAX_MONTHS = 36;

export type CreatePromotionInput = {
  code: string;
  name: string;
  percentOff: number | null;
  amountOffCents: number | null;
  duration: PromotionDuration;
  durationInMonths: number | null;
  allowedTiers: PromotionTier[];
  allowedPeriods: BillingPeriod[];
  startsAt: string;
  endsAt: string | null;
  maxRedemptions: number | null;
  active: boolean;
  stripeCouponId: string;
  stripePromotionCodeId: string;
  createdBy: string;
};

export async function createPromotion(
  data: CreatePromotionInput,
  client?: SupabaseClient
): Promise<PromotionRow> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data: row, error } = await db
    .from("promotions")
    .insert({
      code: data.code,
      name: data.name,
      percent_off: data.percentOff,
      amount_off_cents: data.amountOffCents,
      duration: data.duration,
      duration_in_months: data.durationInMonths,
      allowed_tiers: data.allowedTiers,
      allowed_periods: data.allowedPeriods,
      starts_at: data.startsAt,
      ends_at: data.endsAt,
      max_redemptions: data.maxRedemptions,
      active: data.active,
      stripe_coupon_id: data.stripeCouponId,
      stripe_promotion_code_id: data.stripePromotionCodeId,
      created_by: data.createdBy
    })
    .select("*")
    .single();
  if (error) throw new Error(`createPromotion: ${error.message}`);
  return row as PromotionRow;
}

/** Every promotion, newest first (admin table). */
export async function listPromotions(client?: SupabaseClient): Promise<PromotionRow[]> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("promotions")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) throw new Error(`listPromotions: ${error.message}`);
  return (data ?? []) as PromotionRow[];
}

export async function getPromotion(
  promotionId: string,
  client?: SupabaseClient
): Promise<PromotionRow | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("promotions")
    .select("*")
    .eq("id", promotionId)
    .maybeSingle();
  if (error) throw new Error(`getPromotion: ${error.message}`);
  return (data as PromotionRow | null) ?? null;
}

/**
 * Resolve a customer-entered code. The caller normalizes first
 * (`normalizePromotionCode`); codes are stored uppercase so this is an exact
 * match on the unique index.
 */
export async function getPromotionByCode(
  code: string,
  client?: SupabaseClient
): Promise<PromotionRow | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("promotions")
    .select("*")
    .eq("code", code)
    .maybeSingle();
  if (error) throw new Error(`getPromotionByCode: ${error.message}`);
  return (data as PromotionRow | null) ?? null;
}

export type UpdatePromotionPatch = {
  name?: string;
  percentOff?: number | null;
  amountOffCents?: number | null;
  duration?: PromotionDuration;
  durationInMonths?: number | null;
  allowedTiers?: PromotionTier[];
  allowedPeriods?: BillingPeriod[];
  startsAt?: string;
  endsAt?: string | null;
  maxRedemptions?: number | null;
  active?: boolean;
  stripeCouponId?: string;
  stripePromotionCodeId?: string;
};

/**
 * Apply an admin edit. The code itself is immutable (it is the customer-facing
 * identity and may already be printed on a campaign); everything else is
 * editable, which is exactly why the window and cap live on this row rather
 * than on the immutable Stripe coupon.
 */
export async function updatePromotion(
  promotionId: string,
  patch: UpdatePromotionPatch,
  client?: SupabaseClient
): Promise<PromotionRow | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (patch.name !== undefined) update.name = patch.name;
  if (patch.percentOff !== undefined) update.percent_off = patch.percentOff;
  if (patch.amountOffCents !== undefined) update.amount_off_cents = patch.amountOffCents;
  if (patch.duration !== undefined) update.duration = patch.duration;
  if (patch.durationInMonths !== undefined) update.duration_in_months = patch.durationInMonths;
  if (patch.allowedTiers !== undefined) update.allowed_tiers = patch.allowedTiers;
  if (patch.allowedPeriods !== undefined) update.allowed_periods = patch.allowedPeriods;
  if (patch.startsAt !== undefined) update.starts_at = patch.startsAt;
  if (patch.endsAt !== undefined) update.ends_at = patch.endsAt;
  if (patch.maxRedemptions !== undefined) update.max_redemptions = patch.maxRedemptions;
  if (patch.active !== undefined) update.active = patch.active;
  if (patch.stripeCouponId !== undefined) update.stripe_coupon_id = patch.stripeCouponId;
  if (patch.stripePromotionCodeId !== undefined) {
    update.stripe_promotion_code_id = patch.stripePromotionCodeId;
  }

  const { data, error } = await db
    .from("promotions")
    .update(update)
    .eq("id", promotionId)
    .select("*")
    .maybeSingle();
  if (error) throw new Error(`updatePromotion: ${error.message}`);
  return (data as PromotionRow | null) ?? null;
}

/**
 * Hard delete. The API only calls this for a promotion with zero redemptions;
 * the `on delete restrict` foreign key is the backstop that keeps attribution
 * from ever being deleted out from under the stats.
 */
export async function deletePromotion(
  promotionId: string,
  client?: SupabaseClient
): Promise<boolean> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("promotions")
    .delete()
    .eq("id", promotionId)
    .select("id");
  if (error) throw new Error(`deletePromotion: ${error.message}`);
  return ((data as unknown[] | null) ?? []).length > 0;
}

/** Every redemption, newest first. Small table: the admin page aggregates in memory. */
export async function listPromotionRedemptions(
  client?: SupabaseClient
): Promise<PromotionRedemptionRow[]> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("promotion_redemptions")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) throw new Error(`listPromotionRedemptions: ${error.message}`);
  return (data ?? []) as PromotionRedemptionRow[];
}

/** Redemptions for ONE promotion, newest first (the per-promotion detail view). */
export async function listRedemptionsForPromotion(
  promotionId: string,
  client?: SupabaseClient
): Promise<PromotionRedemptionRow[]> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("promotion_redemptions")
    .select("*")
    .eq("promotion_id", promotionId)
    .order("created_at", { ascending: false });
  if (error) throw new Error(`listRedemptionsForPromotion: ${error.message}`);
  return (data ?? []) as PromotionRedemptionRow[];
}

/**
 * How many times a promotion has been redeemed, the number the cap is checked
 * against. Uses a HEAD count so validation never pulls the rows themselves.
 */
export async function countPromotionRedemptions(
  promotionId: string,
  client?: SupabaseClient
): Promise<number> {
  const db = client ?? (await createSupabaseServiceClient());
  const { count, error } = await db
    .from("promotion_redemptions")
    .select("id", { count: "exact", head: true })
    .eq("promotion_id", promotionId);
  if (error) throw new Error(`countPromotionRedemptions: ${error.message}`);
  return count ?? 0;
}

/**
 * Record a redemption (Stripe webhook). Idempotent under webhook retries via
 * the unique index on `stripe_session_id`: a duplicate insert is ignored
 * rather than raising, so a re-delivered `checkout.session.completed` cannot
 * inflate the stats or burn a second slot against the cap.
 */
export async function recordPromotionRedemption(
  data: {
    promotionId: string;
    businessId: string;
    tier: PromotionTier;
    billingPeriod: BillingPeriod;
    stripeSessionId: string;
    amountDiscountedCents: number;
  },
  client?: SupabaseClient
): Promise<boolean> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data: rows, error } = await db
    .from("promotion_redemptions")
    .upsert(
      {
        promotion_id: data.promotionId,
        business_id: data.businessId,
        tier: data.tier,
        billing_period: data.billingPeriod,
        stripe_session_id: data.stripeSessionId,
        amount_discounted_cents: data.amountDiscountedCents
      },
      { onConflict: "stripe_session_id", ignoreDuplicates: true }
    )
    .select("id");
  if (error) throw new Error(`recordPromotionRedemption: ${error.message}`);
  return ((rows as unknown[] | null) ?? []).length > 0;
}
