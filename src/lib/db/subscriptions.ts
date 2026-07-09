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
  /**
   * Term contracts only (§20260713000000_contract_auto_renew). false = roll
   * to month-to-month at the renewal price at term end (commitment schedule
   * in place); true = the Stripe subscription renews for another full term at
   * the contract price (schedule released). Toggled via /api/billing/auto-renew.
   */
  contract_auto_renew: boolean;
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

export type LiveSubscriptionBusinessIds = {
  /** Live (active/past_due) subscription BACKED BY A STRIPE PAYMENT. */
  stripeBacked: Set<string>;
  /**
   * Live subscription with NO Stripe linkage — admin-created enterprise
   * rows, internal pilots, skip-payment accounts. Nobody is being charged.
   */
  stripeless: Set<string>;
};

/**
 * Which of `businessIds` have ANY subscription in a live billing state
 * (`active` / `past_due`) — regardless of row age — split by whether a real
 * Stripe payment backs it. Deliberately NOT newest-row-wins like
 * {@link listSubscriptionsByBusinessIds}: a newer `pending` row (resubscribe
 * checkout in flight) must not shadow an older `active` one when the caller
 * is deciding whether a tenant is paying.
 *
 * The Stripe split exists for the VPS billing-posture cron: only a tenant
 * with a REAL payment relationship justifies auto-spending platform money
 * (re-enabling Hostinger renewal). A Stripe-less active row — the Residency
 * Pilot's internal subscription, admin-created enterprise accounts — must
 * never trigger an automatic billing change; those are surfaced report-only.
 * A business with both kinds of rows counts as stripeBacked.
 */
export async function listBusinessIdsWithLiveSubscription(
  businessIds: string[],
  client?: SupabaseClient
): Promise<LiveSubscriptionBusinessIds> {
  if (businessIds.length === 0) return { stripeBacked: new Set(), stripeless: new Set() };
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("subscriptions")
    .select("business_id, stripe_subscription_id")
    .in("business_id", businessIds)
    .in("status", ["active", "past_due"]);

  if (error) throw new Error(`listBusinessIdsWithLiveSubscription: ${error.message}`);
  const rows = (data ?? []) as Array<{
    business_id: string;
    stripe_subscription_id: string | null;
  }>;
  const stripeBacked = new Set(
    rows.filter((r) => r.stripe_subscription_id !== null).map((r) => r.business_id)
  );
  const stripeless = new Set(
    rows
      .filter((r) => r.stripe_subscription_id === null && !stripeBacked.has(r.business_id))
      .map((r) => r.business_id)
  );
  return { stripeBacked, stripeless };
}

/**
 * Which of `businessIds` have ANY subscription row that is Stripe-linked and
 * not canceled — i.e. Stripe either IS billing (active/past_due) or MAY
 * start billing any second (a paid checkout's `pending` row whose webhook
 * is still activating). Any-row semantics like
 * {@link listBusinessIdsWithLiveSubscription}, but deliberately wider: this
 * is the "would deleting this account orphan Stripe billing?" predicate,
 * shared by the release-to-pool guard and the adopt-time cascade's
 * delete guard.
 */
export async function listBusinessIdsWithStripeLinkedSubscription(
  businessIds: string[],
  client?: SupabaseClient
): Promise<Set<string>> {
  if (businessIds.length === 0) return new Set();
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("subscriptions")
    .select("business_id")
    .in("business_id", businessIds)
    .not("stripe_subscription_id", "is", null)
    .neq("status", "canceled");

  if (error) throw new Error(`listBusinessIdsWithStripeLinkedSubscription: ${error.message}`);
  return new Set(((data ?? []) as Array<{ business_id: string }>).map((r) => r.business_id));
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
      | "contract_auto_renew"
    >
  >,
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db.from("subscriptions").update(update).eq("id", id);
  if (error) throw new Error(`updateSubscription: ${error.message}`);
}

/**
 * Conditional update: applies `update` ONLY if the row still has
 * `wiped_at IS NULL`. Returns the updated row when the predicate
 * matched, or `null` when the row was wiped between caller's read and
 * this write (i.e. an interleaved grace-sweep finalized the prior
 * lifetime).
 *
 * Used by `runResubscribeFromCheckout` to avoid silently resurrecting
 * a row whose data backup has already been deleted by the grace-sweep.
 * Without this guard the orchestrator's final
 * `updateSubscription({status:"active", wiped_at:null, ...})` would
 * overwrite the wipe stamp and leave us with a row that claims active
 * service on a fresh VPS that has none of the customer's data.
 */
export async function updateSubscriptionIfNotWiped(
  id: string,
  update: Parameters<typeof updateSubscription>[1],
  client?: SupabaseClient
): Promise<SubscriptionRow | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("subscriptions")
    .update(update)
    .eq("id", id)
    .is("wiped_at", null)
    .select();
  if (error) throw new Error(`updateSubscriptionIfNotWiped: ${error.message}`);
  const rows = (data ?? []) as SubscriptionRow[];
  return rows[0] ?? null;
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
 * A Stripe billing period at most this long is a MONTHLY cycle (rollover
 * phase), not a prepaid 12/24-month term. 32 days > any calendar month.
 */
const MONTHLY_PERIOD_MAX_MS = 32 * 24 * 60 * 60 * 1000;

/**
 * True when a term (12/24-month) subscription has finished its commitment
 * and is in the month-to-month rollover phase. This is when the billing page
 * offers "Start a new contract" at the contract rate, and when
 * /api/billing/change-plan allows a same-plan re-contract. Monthly plans
 * have no commitment and never qualify.
 *
 * Two signals are BOTH required:
 * - `renewal_at` (stamped at checkout as start + commitment months) has
 *   passed — the original term is over; and
 * - the cached Stripe billing period is monthly-length — with auto-renew ON
 *   the subscription renews for another FULL prepaid term (12/24-month
 *   period) but `renewal_at` is never advanced, so a past `renewal_at`
 *   alone cannot distinguish "rolling month-to-month" from "inside a
 *   renewed contract". Missing/unparseable period bounds fail toward
 *   "still committed" (no cap exemption, no re-contract CTA).
 */
export function isCommitmentElapsed(
  row: Pick<
    SubscriptionRow,
    "billing_period" | "renewal_at" | "stripe_current_period_start" | "stripe_current_period_end"
  >,
  now: Date = new Date()
): boolean {
  if (!row.billing_period || row.billing_period === "monthly") return false;
  if (!row.renewal_at) return false;
  const at = new Date(row.renewal_at).getTime();
  if (!Number.isFinite(at) || at > now.getTime()) return false;
  if (!row.stripe_current_period_start || !row.stripe_current_period_end) return false;
  const periodStart = new Date(row.stripe_current_period_start).getTime();
  const periodEnd = new Date(row.stripe_current_period_end).getTime();
  if (!Number.isFinite(periodStart) || !Number.isFinite(periodEnd)) return false;
  return periodEnd - periodStart <= MONTHLY_PERIOD_MAX_MS;
}

/**
 * True when `row` represents live (or plausibly-live) paid service that a
 * fresh onboarding checkout must NOT shadow with a new `pending` row:
 *
 * - `active` — live service; the Billing page (change-plan / reactivate) is
 *   the only legitimate way to alter it.
 * - canceled-in-grace — the customer can still reactivate the existing
 *   subscription with its data intact; a parallel new signup would fork it.
 * - any non-canceled row that already has a `stripe_subscription_id` — a paid
 *   checkout whose webhook processing may still be in flight.
 *
 * Deliberately NOT blocking: unpaid `pending` rows (abandoned checkouts must
 * stay retryable) and fully-canceled/wiped rows (a past customer may sign up
 * again from scratch).
 */
export function isCheckoutBlockingSubscription(
  row: Pick<SubscriptionRow, "status" | "grace_ends_at" | "wiped_at" | "stripe_subscription_id">,
  now: Date = new Date()
): boolean {
  if (row.status === "active") return true;
  if (isCanceledInGrace(row, now)) return true;
  return row.status !== "canceled" && row.stripe_subscription_id !== null;
}

/**
 * Finds a subscription row across `businessIds` that must block a NEW
 * onboarding checkout (see `isCheckoutBlockingSubscription`). Scans every
 * row — not just the latest per business — because an abandoned `pending`
 * row can sit on top of (and hide) an older `active` one, which is exactly
 * the shadowing incident this guard exists to prevent.
 *
 * Throws on a query error: this is a security gate, and failing open on a
 * transient DB blip would let a duplicate paid subscription through.
 */
export async function findCheckoutBlockingSubscription(
  businessIds: string[],
  now: Date = new Date(),
  client?: SupabaseClient
): Promise<SubscriptionRow | null> {
  if (businessIds.length === 0) return null;
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("subscriptions")
    .select()
    .in("business_id", businessIds)
    .order("created_at", { ascending: false });
  if (error) throw new Error(`findCheckoutBlockingSubscription: ${error.message}`);
  for (const row of (data ?? []) as SubscriptionRow[]) {
    if (isCheckoutBlockingSubscription(row, now)) return row;
  }
  return null;
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
