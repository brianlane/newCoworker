import { createSupabaseServiceClient } from "@/lib/supabase/server";
import type { BillingPeriod } from "@/lib/plans/tier";

export type { BillingPeriod };

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export type SubscriptionRow = {
  id: string;
  business_id: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  tier: "starter" | "standard" | "enterprise";
  status: "active" | "past_due" | "canceled" | "pending";
  billing_period: BillingPeriod | null;
  renewal_at: string | null;
  commitment_months: number | null;
  /** Stripe subscription.current_period_start (UTC), for voice ledger §4 */
  stripe_current_period_start: string | null;
  stripe_current_period_end: string | null;
  stripe_subscription_cached_at: string | null;
  created_at: string;
};

/** Map Stripe Subscription billing period fields into our cache columns (voice §4.2). */
export function subscriptionPeriodCacheFromStripe(sub: {
  current_period_start: number;
  current_period_end: number;
}): Pick<
  SubscriptionRow,
  "stripe_current_period_start" | "stripe_current_period_end" | "stripe_subscription_cached_at"
> {
  return {
    stripe_current_period_start: new Date(sub.current_period_start * 1000).toISOString(),
    stripe_current_period_end: new Date(sub.current_period_end * 1000).toISOString(),
    stripe_subscription_cached_at: new Date().toISOString()
  };
}

export type SubscriptionPeriodStripeCache = ReturnType<typeof subscriptionPeriodCacheFromStripe>;

/**
 * Stripe SDK typings omit period fields on some Subscription shapes; narrow at runtime.
 *
 * Stripe API version `2025-03-31.basil` moved `current_period_start` /
 * `current_period_end` off the top-level Subscription and onto each
 * `SubscriptionItem`. This helper now reads both shapes:
 *
 *   1. Top-level `sub.current_period_{start,end}` (legacy / pinned API ≤ 2025-03-30).
 *   2. `sub.items.data[].current_period_{start,end}` (basil and later), taking the
 *      subscription-wide window as `[min(start), max(end)]` across items. For
 *      the common single-item subscription this is identical to the old fields.
 *
 * Returns `{}` when neither shape yields two finite integer seconds. Idempotent
 * and call-safe for unknown inputs.
 */
export function stripeSubscriptionPeriodCache(
  sub: unknown
): SubscriptionPeriodStripeCache | Record<string, never> {
  if (sub == null || typeof sub !== "object") {
    return {};
  }
  const s = sub as {
    current_period_start?: unknown;
    current_period_end?: unknown;
    items?: { data?: Array<{ current_period_start?: unknown; current_period_end?: unknown }> };
  };

  let start: number | null = null;
  let end: number | null = null;

  if (typeof s.current_period_start === "number" && typeof s.current_period_end === "number") {
    start = s.current_period_start;
    end = s.current_period_end;
  }

  const items = s.items?.data;
  if (Array.isArray(items) && items.length > 0) {
    const starts: number[] = [];
    const ends: number[] = [];
    for (const it of items) {
      if (typeof it.current_period_start === "number") starts.push(it.current_period_start);
      if (typeof it.current_period_end === "number") ends.push(it.current_period_end);
    }
    if (starts.length > 0 && ends.length > 0) {
      const itemStart = Math.min(...starts);
      const itemEnd = Math.max(...ends);
      if (start == null || end == null) {
        start = itemStart;
        end = itemEnd;
      }
    }
  }

  if (start == null || end == null || !Number.isFinite(start) || !Number.isFinite(end)) {
    return {};
  }
  return subscriptionPeriodCacheFromStripe({
    current_period_start: start,
    current_period_end: end
  });
}

export async function createSubscription(
  data: Omit<
    SubscriptionRow,
    | "created_at"
    | "billing_period"
    | "renewal_at"
    | "commitment_months"
    | "stripe_current_period_start"
    | "stripe_current_period_end"
    | "stripe_subscription_cached_at"
  > & {
    billing_period?: BillingPeriod | null;
    renewal_at?: string | null;
    commitment_months?: number | null;
    stripe_current_period_start?: string | null;
    stripe_current_period_end?: string | null;
    stripe_subscription_cached_at?: string | null;
  },
  client?: SupabaseClient
): Promise<SubscriptionRow> {
  const db = client ?? (await createSupabaseServiceClient());
  const {
    stripe_current_period_start = null,
    stripe_current_period_end = null,
    stripe_subscription_cached_at = null,
    ...rest
  } = data;
  const { data: row, error } = await db
    .from("subscriptions")
    .insert({
      ...rest,
      stripe_current_period_start,
      stripe_current_period_end,
      stripe_subscription_cached_at
    })
    .select()
    .single();

  if (error) throw new Error(`createSubscription: ${error.message}`);
  return row as SubscriptionRow;
}

export async function getSubscription(
  businessId: string,
  client?: SupabaseClient
): Promise<SubscriptionRow | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("subscriptions")
    .select()
    .eq("business_id", businessId)
    .order("created_at", { ascending: false })
    .limit(1)
    .single();

  if (error) return null;
  return data as SubscriptionRow;
}

export async function getSubscriptionByStripeSubscriptionId(
  stripeSubscriptionId: string,
  client?: SupabaseClient
): Promise<SubscriptionRow | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("subscriptions")
    .select()
    .eq("stripe_subscription_id", stripeSubscriptionId)
    .order("created_at", { ascending: false })
    .limit(1)
    .single();

  if (error) return null;
  return data as SubscriptionRow;
}

export async function listSubscriptionsByBusinessIds(
  businessIds: string[],
  client?: SupabaseClient
): Promise<Map<string, SubscriptionRow>> {
  if (businessIds.length === 0) return new Map();
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("subscriptions")
    .select()
    .in("business_id", businessIds)
    .order("created_at", { ascending: false });

  if (error) throw new Error(`listSubscriptionsByBusinessIds: ${error.message}`);

  const map = new Map<string, SubscriptionRow>();
  for (const row of (data ?? []) as SubscriptionRow[]) {
    if (!map.has(row.business_id)) {
      map.set(row.business_id, row);
    }
  }
  return map;
}

export async function updateSubscription(
  id: string,
  update: Partial<
    Pick<
      SubscriptionRow,
      | "status"
      | "stripe_subscription_id"
      | "stripe_customer_id"
      | "stripe_current_period_start"
      | "stripe_current_period_end"
      | "stripe_subscription_cached_at"
    >
  >,
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db.from("subscriptions").update(update).eq("id", id);
  if (error) throw new Error(`updateSubscription: ${error.message}`);
}
