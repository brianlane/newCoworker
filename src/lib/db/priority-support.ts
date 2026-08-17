/**
 * Priority support subscriptions: DB access layer.
 *
 * A row mirrors the tenant's SECOND Stripe subscription, the $400/month
 * priority support add-on. Stripe stays authoritative; this table exists so
 * the dashboard and admin surfaces can render "is it renewing" without a
 * Stripe round trip on every page load, the same role
 * `subscriptions.membership_pack_addons` plays for usage packs.
 *
 * Coverage itself is NOT stored here. It lives on
 * `businesses.priority_support_until`, pushed forward by each paid invoice
 * through `extendPrioritySupport`. This table answers "is it renewing"; that
 * column answers "how many days are left".
 *
 * One live row per business is enforced in Postgres by a partial unique index
 * (`... (business_id) where status <> 'canceled'`), so a raced double click or
 * a retried webhook collides there rather than opening a second $400/month
 * subscription. Callers must treat an insert conflict as "already subscribed",
 * never as a transient error to retry.
 */
import { createSupabaseServiceClient } from "@/lib/supabase/server";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export type PrioritySupportSubscriptionStatus = "active" | "canceling" | "canceled";

export type PrioritySupportSubscriptionRow = {
  id: string;
  business_id: string;
  stripe_subscription_id: string;
  stripe_customer_id: string | null;
  stripe_session_id: string | null;
  status: PrioritySupportSubscriptionStatus;
  started_at: string;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  canceled_at: string | null;
  created_by: string;
  created_at: string;
};

const COLUMNS =
  "id,business_id,stripe_subscription_id,stripe_customer_id,stripe_session_id,status," +
  "started_at,current_period_end,cancel_at_period_end,canceled_at,created_by,created_at";

/**
 * The tenant's live row (active or winding down), or null. A canceled row is
 * history and never returned here, which is what makes "can this tenant buy
 * priority support" a single call.
 */
export async function getLivePrioritySupportSubscription(
  businessId: string,
  client?: SupabaseClient
): Promise<PrioritySupportSubscriptionRow | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("priority_support_subscriptions")
    .select(COLUMNS)
    .eq("business_id", businessId)
    .neq("status", "canceled")
    .maybeSingle();
  if (error) throw new Error(`getLivePrioritySupportSubscription: ${error.message}`);
  return (data as PrioritySupportSubscriptionRow | null) ?? null;
}

export async function getPrioritySupportSubscriptionByStripeId(
  stripeSubscriptionId: string,
  client?: SupabaseClient
): Promise<PrioritySupportSubscriptionRow | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("priority_support_subscriptions")
    .select(COLUMNS)
    .eq("stripe_subscription_id", stripeSubscriptionId)
    .maybeSingle();
  if (error) throw new Error(`getPrioritySupportSubscriptionByStripeId: ${error.message}`);
  return (data as PrioritySupportSubscriptionRow | null) ?? null;
}

/**
 * Record a completed priority-support Checkout.
 *
 * Idempotent for webhook retries in two ways: `stripe_subscription_id` is
 * unique, so a replayed event returns the existing row instead of inserting a
 * second one; and the partial unique index rejects a genuinely different
 * second subscription for the same business. Both come back as a conflict,
 * which we resolve by reading the existing row rather than throwing, so a
 * Stripe retry never turns into a 500 that Stripe retries again.
 */
export async function recordPrioritySupportSubscription(
  data: {
    businessId: string;
    stripeSubscriptionId: string;
    stripeCustomerId: string | null;
    stripeSessionId: string | null;
    currentPeriodEnd: Date | null;
    createdBy: string;
  },
  client?: SupabaseClient
): Promise<{ row: PrioritySupportSubscriptionRow; duplicate: boolean }> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data: inserted, error } = await db
    .from("priority_support_subscriptions")
    .insert({
      business_id: data.businessId,
      stripe_subscription_id: data.stripeSubscriptionId,
      stripe_customer_id: data.stripeCustomerId,
      stripe_session_id: data.stripeSessionId,
      current_period_end: data.currentPeriodEnd?.toISOString() ?? null,
      created_by: data.createdBy
    })
    .select(COLUMNS)
    .maybeSingle();

  if (!error && inserted) {
    return {
      row: inserted as unknown as PrioritySupportSubscriptionRow,
      duplicate: false
    };
  }

  // 23505 = unique_violation, from either the stripe id or the one-live-row
  // index. Both mean "this tenant already has it", not a failure to report.
  if (error && error.code !== "23505") {
    throw new Error(`recordPrioritySupportSubscription: ${error.message}`);
  }

  const existing = await getPrioritySupportSubscriptionByStripeId(
    data.stripeSubscriptionId,
    db
  );
  if (existing) return { row: existing, duplicate: true };

  const live = await getLivePrioritySupportSubscription(data.businessId, db);
  if (live) return { row: live, duplicate: true };

  throw new Error(
    `recordPrioritySupportSubscription: conflict with no resolvable row for ${data.businessId}`
  );
}

/**
 * Mirror the live Stripe state onto the row. Called from
 * `customer.subscription.created|updated`, so it must tolerate a subscription
 * we have no row for (an event that raced the checkout handler) by doing
 * nothing rather than inserting a half-formed row: the checkout handler is the
 * single authoritative site for planting the linkage, the same rule the
 * membership mirror follows.
 */
export async function mirrorPrioritySupportSubscription(
  stripeSubscriptionId: string,
  data: {
    status: PrioritySupportSubscriptionStatus;
    currentPeriodEnd: Date | null;
    cancelAtPeriodEnd: boolean;
  },
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db
    .from("priority_support_subscriptions")
    .update({
      status: data.status,
      current_period_end: data.currentPeriodEnd?.toISOString() ?? null,
      cancel_at_period_end: data.cancelAtPeriodEnd,
      ...(data.status === "canceled" ? { canceled_at: new Date().toISOString() } : {})
    })
    .eq("stripe_subscription_id", stripeSubscriptionId);
  if (error) throw new Error(`mirrorPrioritySupportSubscription: ${error.message}`);
}

/** Terminal state, from `customer.subscription.deleted` or a teardown sweep. */
export async function markPrioritySupportSubscriptionCanceled(
  stripeSubscriptionId: string,
  canceledAt: Date,
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db
    .from("priority_support_subscriptions")
    .update({
      status: "canceled",
      cancel_at_period_end: false,
      canceled_at: canceledAt.toISOString()
    })
    .eq("stripe_subscription_id", stripeSubscriptionId);
  if (error) throw new Error(`markPrioritySupportSubscriptionCanceled: ${error.message}`);
}
