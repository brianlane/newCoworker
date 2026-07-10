/**
 * Enterprise deals — DB access layer.
 *
 * A row is a bespoke recurring price for ONE enterprise business: the admin
 * sets a one-time setup fee + a monthly price; the owner pays through the
 * public /enterprise-offer/<pay_token> link (mode=subscription Stripe
 * Checkout with inline price_data — this row IS the pricing source of truth,
 * never a client-supplied amount). Lifecycle: open → active (Stripe webhook)
 * or open → revoked (admin); active → canceled when the underlying Stripe
 * subscription ends. See migration 20260806000000_enterprise_deals.
 */
import { createSupabaseServiceClient } from "@/lib/supabase/server";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export type EnterpriseDealStatus = "open" | "active" | "revoked" | "canceled";

export type EnterpriseDealRow = {
  id: string;
  business_id: string;
  setup_cents: number;
  monthly_cents: number;
  status: EnterpriseDealStatus;
  created_by: string;
  created_at: string;
  activated_at: string | null;
  stripe_session_id: string | null;
  stripe_subscription_id: string | null;
  /** Unguessable capability behind the public /enterprise-offer/<pay_token> link. */
  pay_token: string;
};

/** Bounds mirrored from the table CHECKs so the API fails fast with a clear message. */
export const ENTERPRISE_DEAL_SETUP_MIN_CENTS = 0;
export const ENTERPRISE_DEAL_MONTHLY_MIN_CENTS = 100;
export const ENTERPRISE_DEAL_MAX_CENTS = 100_000_000;

export async function createEnterpriseDeal(
  data: {
    businessId: string;
    setupCents: number;
    monthlyCents: number;
    createdBy: string;
  },
  client?: SupabaseClient
): Promise<EnterpriseDealRow> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data: row, error } = await db
    .from("enterprise_deals")
    .insert({
      business_id: data.businessId,
      setup_cents: data.setupCents,
      monthly_cents: data.monthlyCents,
      created_by: data.createdBy
    })
    .select("*")
    .single();
  if (error) throw new Error(`createEnterpriseDeal: ${error.message}`);
  return row as EnterpriseDealRow;
}

/** All deals for a business, newest first (admin panel). */
export async function listEnterpriseDeals(
  businessId: string,
  client?: SupabaseClient
): Promise<EnterpriseDealRow[]> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("enterprise_deals")
    .select("*")
    .eq("business_id", businessId)
    .order("created_at", { ascending: false });
  if (error) throw new Error(`listEnterpriseDeals: ${error.message}`);
  return (data ?? []) as EnterpriseDealRow[];
}

/**
 * Every ACTIVE deal across all businesses (admin dashboard MRR — the deal's
 * monthly price is enterprise's real revenue; the tier table carries $0).
 */
export async function listActiveEnterpriseDeals(
  client?: SupabaseClient
): Promise<EnterpriseDealRow[]> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("enterprise_deals")
    .select("*")
    .eq("status", "active");
  if (error) throw new Error(`listActiveEnterpriseDeals: ${error.message}`);
  return (data ?? []) as EnterpriseDealRow[];
}

/** Single deal by id, or null when it doesn't exist. */
export async function getEnterpriseDeal(
  dealId: string,
  client?: SupabaseClient
): Promise<EnterpriseDealRow | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("enterprise_deals")
    .select("*")
    .eq("id", dealId)
    .maybeSingle();
  if (error) throw new Error(`getEnterpriseDeal: ${error.message}`);
  return (data as EnterpriseDealRow | null) ?? null;
}

/** Resolve the deal behind a public payment link, or null. */
export async function getEnterpriseDealByPayToken(
  payToken: string,
  client?: SupabaseClient
): Promise<EnterpriseDealRow | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("enterprise_deals")
    .select("*")
    .eq("pay_token", payToken)
    .maybeSingle();
  if (error) throw new Error(`getEnterpriseDealByPayToken: ${error.message}`);
  return (data as EnterpriseDealRow | null) ?? null;
}

/**
 * Revoke an OPEN deal (admin). Guarded on status so a concurrent payment
 * wins over the revoke: an activated deal stays active. Returns whether a
 * row actually flipped.
 */
export async function revokeEnterpriseDeal(
  dealId: string,
  client?: SupabaseClient
): Promise<boolean> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("enterprise_deals")
    .update({ status: "revoked" })
    .eq("id", dealId)
    .eq("status", "open")
    .select("id");
  if (error) throw new Error(`revokeEnterpriseDeal: ${error.message}`);
  return ((data as unknown[] | null) ?? []).length > 0;
}

/**
 * Mark a deal active (Stripe webhook, checkout.session.completed) — an
 * ATOMIC CLAIM, not a blind write (same pattern as markWhiteGloveOfferPaid).
 * The update only matches when the deal is still OPEN, or was already
 * activated by THIS same Stripe session (webhook retry → idempotent re-write
 * of identical values). Everything else returns "not_claimable" and the
 * caller must cancel the fresh Stripe subscription instead of linking it:
 *
 *  - already active from a DIFFERENT session — the customer started two
 *    subscriptions (two pay tabs both reached Stripe before the first
 *    completion landed);
 *  - revoked/canceled — a stale Checkout session (created while the deal was
 *    open, completed after an admin revoke or after the deal's subscription
 *    ended) must NOT resurrect an old price. Unlike the one-time white-glove
 *    claim (where a revoke-racing payment still flips to paid because the
 *    money is real), silently reviving a dead RECURRING deal could put two
 *    live deals on one business (unique-index blowup → endless webhook
 *    retries) or bill a price the admin withdrew; support refunds the first
 *    invoice out-of-band instead.
 */
export async function markEnterpriseDealActive(
  dealId: string,
  data: { activatedAt: Date; stripeSessionId: string; stripeSubscriptionId: string | null },
  client?: SupabaseClient
): Promise<"active" | "not_claimable"> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data: rows, error } = await db
    .from("enterprise_deals")
    .update({
      status: "active",
      activated_at: data.activatedAt.toISOString(),
      stripe_session_id: data.stripeSessionId,
      stripe_subscription_id: data.stripeSubscriptionId
    })
    .eq("id", dealId)
    // Retry idempotency (the and() arm) applies only while the deal is still
    // ACTIVE — a late retry of the original completion must not resurrect a
    // deal that has since been revoked/canceled.
    .or(`status.eq.open,and(status.eq.active,stripe_session_id.eq.${data.stripeSessionId})`)
    .select("id");
  if (error) throw new Error(`markEnterpriseDealActive: ${error.message}`);
  return ((rows as unknown[] | null) ?? []).length > 0 ? "active" : "not_claimable";
}

/**
 * Flip an ACTIVE deal to 'canceled' when its underlying Stripe subscription
 * ends (customer.subscription.deleted). Frees the one-live-deal-per-business
 * slot so the admin can author a new deal for a returning tenant. Returns
 * whether a row actually flipped (false = no active deal for that sub, e.g.
 * a non-enterprise subscription).
 */
export async function markEnterpriseDealCanceledByStripeSubscriptionId(
  stripeSubscriptionId: string,
  client?: SupabaseClient
): Promise<boolean> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("enterprise_deals")
    .update({ status: "canceled" })
    .eq("stripe_subscription_id", stripeSubscriptionId)
    .eq("status", "active")
    .select("id");
  if (error) {
    throw new Error(`markEnterpriseDealCanceledByStripeSubscriptionId: ${error.message}`);
  }
  return ((data as unknown[] | null) ?? []).length > 0;
}

/** The emailable public payment link for a deal (durable; never expires). */
export function enterpriseDealPayUrl(deal: Pick<EnterpriseDealRow, "pay_token">): string {
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
  return `${appUrl}/enterprise-offer/${deal.pay_token}`;
}
