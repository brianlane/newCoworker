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
 */
export function stripeSubscriptionPeriodCache(
  sub: unknown
): SubscriptionPeriodStripeCache | Record<string, never> {
  if (sub == null || typeof sub !== "object") {
    return {};
  }
  const s = sub as { current_period_start?: unknown; current_period_end?: unknown };
  if (typeof s.current_period_start !== "number" || typeof s.current_period_end !== "number") {
    return {};
  }
  return subscriptionPeriodCacheFromStripe({
    current_period_start: s.current_period_start,
    current_period_end: s.current_period_end
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
