import { createSupabaseServiceClient } from "@/lib/supabase/server";
import type { BillingPeriod } from "@/lib/plans/tier";

export type { BillingPeriod };

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export type CancelReason =
  | "user_refund"
  | "user_period_end"
  | "payment_failed"
  | "admin_force"
  | "upgrade_switch";

export type SubscriptionRow = {
  id: string;
  business_id: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  tier: "starter" | "standard" | "enterprise";
  /**
   * DB status enum. App code never writes `past_due` — payment failures flip
   * directly to `canceled` with `grace_ends_at` set, per the lifecycle plan.
   * `past_due` is kept in the type for back-compat with historical rows.
   */
  status: "active" | "past_due" | "canceled" | "pending";
  billing_period: BillingPeriod | null;
  renewal_at: string | null;
  commitment_months: number | null;
  /** Stripe subscription.current_period_start (UTC), for voice ledger §4 */
  stripe_current_period_start: string | null;
  stripe_current_period_end: string | null;
  stripe_subscription_cached_at: string | null;
  /** Lifecycle bookkeeping (§20260501000000_subscription_lifecycle) */
  customer_profile_id: string | null;
  canceled_at: string | null;
  cancel_reason: CancelReason | null;
  /** Data-retention deadline. canceled_in_grace ≡ canceled + grace_ends_at>now + wiped_at null. */
  grace_ends_at: string | null;
  wiped_at: string | null;
  vps_stopped_at: string | null;
  /** Hostinger billing subscription id, used to DELETE /api/billing/v1/subscriptions/{id}. */
  hostinger_billing_subscription_id: string | null;
  cancel_at_period_end: boolean;
  stripe_refund_id: string | null;
  refund_amount_cents: number | null;
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
  data: {
    id: string;
    business_id: string;
    stripe_customer_id: string | null;
    stripe_subscription_id: string | null;
    tier: "starter" | "standard" | "enterprise";
    status: "active" | "past_due" | "canceled" | "pending";
    billing_period?: BillingPeriod | null;
    renewal_at?: string | null;
    commitment_months?: number | null;
    stripe_current_period_start?: string | null;
    stripe_current_period_end?: string | null;
    stripe_subscription_cached_at?: string | null;
    customer_profile_id?: string | null;
    hostinger_billing_subscription_id?: string | null;
  },
  client?: SupabaseClient
): Promise<SubscriptionRow> {
  const db = client ?? (await createSupabaseServiceClient());
  const {
    stripe_current_period_start = null,
    stripe_current_period_end = null,
    stripe_subscription_cached_at = null,
    customer_profile_id = null,
    hostinger_billing_subscription_id = null,
    ...rest
  } = data;
  const { data: row, error } = await db
    .from("subscriptions")
    .insert({
      ...rest,
      stripe_current_period_start,
      stripe_current_period_end,
      stripe_subscription_cached_at,
      customer_profile_id,
      hostinger_billing_subscription_id
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
      | "customer_profile_id"
      | "canceled_at"
      | "cancel_reason"
      | "grace_ends_at"
      | "wiped_at"
      | "vps_stopped_at"
      | "hostinger_billing_subscription_id"
      | "cancel_at_period_end"
      | "stripe_refund_id"
      | "refund_amount_cents"
      | "tier"
      | "billing_period"
      | "renewal_at"
      | "commitment_months"
    >
  >,
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db.from("subscriptions").update(update).eq("id", id);
  if (error) throw new Error(`updateSubscription: ${error.message}`);
}

/**
 * Returns true if the subscription is in the data-retention grace window:
 * canceled, a grace deadline is set in the future, and the wipe hasn't run.
 * Keeps lifecycle callers from duplicating this predicate.
 */
export function isCanceledInGrace(
  row: Pick<SubscriptionRow, "status" | "grace_ends_at" | "wiped_at">,
  now: Date = new Date()
): boolean {
  if (row.status !== "canceled") return false;
  if (row.wiped_at !== null) return false;
  if (!row.grace_ends_at) return false;
  return new Date(row.grace_ends_at).getTime() > now.getTime();
}

/**
 * Lists subscriptions that are canceled, past their grace deadline, and have
 * not yet been wiped. Used by the daily subscription-grace-sweep cron.
 *
 * Ordered oldest-first so a misbehaving wipe for a single row cannot starve
 * even older rows on later runs.
 */
export async function listGraceExpiredSubscriptions(
  now: Date = new Date(),
  limit = 50,
  client?: SupabaseClient
): Promise<SubscriptionRow[]> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("subscriptions")
    .select()
    .eq("status", "canceled")
    .is("wiped_at", null)
    .not("grace_ends_at", "is", null)
    .lt("grace_ends_at", now.toISOString())
    .order("grace_ends_at", { ascending: true })
    .limit(limit);
  if (error) throw new Error(`listGraceExpiredSubscriptions: ${error.message}`);
  return (data ?? []) as SubscriptionRow[];
}
