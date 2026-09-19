/**
 * Mint a Stripe Checkout session that resubscribes a canceled-in-grace
 * tenant. Shared by `/api/billing/reactivate` (owner Resume) and the
 * admin resubscribe-checkout route so both attach the same customer,
 * price, and `lifecycleAction=resubscribe` metadata the
 * `checkout.session.completed` webhook needs to restore the row.
 *
 * Not a new-signup link: no intro coupon, no 10DLC carrier fee (the
 * tenant already has a campaign). Attaches the existing Stripe customer
 * when we have one so Stripe does not open a duplicate customer.
 */

import { createCheckoutSession, resolvePriceId } from "@/lib/stripe/client";
import { isCanceledInGrace, type SubscriptionRow } from "@/lib/db/subscriptions";
import { getBusiness } from "@/lib/db/businesses";
import { getSubscription } from "@/lib/db/subscriptions";
import {
  getCustomerProfileById,
  LIFETIME_SUBSCRIPTION_CAP
} from "@/lib/db/customer-profiles";
import type { BillingPeriod } from "@/lib/plans/tier";

type ResubscribeCheckoutRefusal =
  | "business_not_found"
  | "subscription_not_found"
  | "subscription_not_in_grace"
  | "unsupported_reactivation_tier"
  | "unsupported_reactivation_period"
  | "no_owner_email"
  | "missing_customer_profile"
  | "lifetime_cap";

export type ResubscribeCheckoutResult =
  | {
      ok: true;
      url: string;
      sessionId: string;
      tier: "starter" | "standard";
      billingPeriod: BillingPeriod;
      ownerEmail: string;
    }
  | { ok: false; refusal: ResubscribeCheckoutRefusal; message: string };

const REFUSAL_MESSAGES: Record<ResubscribeCheckoutRefusal, string> = {
  business_not_found: "Business not found.",
  subscription_not_found: "This business has no subscription row.",
  subscription_not_in_grace:
    "Resubscribe Checkout is only available during the data-retention grace window.",
  unsupported_reactivation_tier: "Only Starter and Standard can resubscribe through Checkout.",
  unsupported_reactivation_period: "Unsupported billing period for resubscribe Checkout.",
  no_owner_email: "This business has no owner email on file.",
  missing_customer_profile:
    "This business has no customer profile, so resubscribe Checkout cannot check the lifetime cap.",
  lifetime_cap: "This customer has used every subscription their profile allows."
};

function refuse(refusal: ResubscribeCheckoutRefusal): ResubscribeCheckoutResult {
  return { ok: false, refusal, message: REFUSAL_MESSAGES[refusal] };
}

export type ResubscribeCheckoutSessionInput = {
  businessId: string;
  ownerEmail: string;
  tier: "starter" | "standard";
  billingPeriod: BillingPeriod;
  userId: string;
  customerProfileId: string | null;
  stripeCustomerId: string | null;
  appUrl?: string;
};

export type ResubscribeCheckoutSessionDeps = {
  createSession?: typeof createCheckoutSession;
};

/** Low-level session create used by the owner reactivate route (cap already checked). */
export async function createResubscribeCheckoutSession(
  input: ResubscribeCheckoutSessionInput,
  deps: ResubscribeCheckoutSessionDeps = {}
): Promise<{ id: string; url: string }> {
  /* c8 ignore next -- production default; unit tests inject createSession */
  const openSession = deps.createSession ?? createCheckoutSession;
  const appUrl = (input.appUrl ?? process.env.NEXT_PUBLIC_APP_URL ?? "http://127.0.0.1:3000").replace(
    /\/$/,
    ""
  );
  const priceId = resolvePriceId(input.tier, input.billingPeriod);
  const metadata: Record<string, string> = {
    businessId: input.businessId,
    tier: input.tier,
    billingPeriod: input.billingPeriod,
    userId: input.userId,
    lifecycleAction: "resubscribe",
    ...(input.customerProfileId ? { customerProfileId: input.customerProfileId } : {})
  };
  return openSession({
    priceId,
    successUrl: `${appUrl}/dashboard/billing?reactivated=1`,
    cancelUrl: `${appUrl}/dashboard/billing`,
    ...(input.stripeCustomerId
      ? { customer: input.stripeCustomerId }
      : { customerEmail: input.ownerEmail }),
    metadata
  });
}

export type AdminResubscribeCheckoutInput = {
  businessId: string;
  /** Optional override; defaults to the canceled row's tier, else Standard. */
  tier?: "starter" | "standard";
  billingPeriod?: BillingPeriod;
  now?: Date;
};

export type AdminResubscribeCheckoutDeps = {
  getBusinessRow?: typeof getBusiness;
  getSubscriptionRow?: typeof getSubscription;
  getProfile?: typeof getCustomerProfileById;
  createSession?: typeof createResubscribeCheckoutSession;
  appUrl?: string;
};

/**
 * Admin entry: load the canceled-in-grace row and mint the same Checkout
 * the owner Resume button would. Refuses outside grace so the webhook
 * restore path (`runResubscribeFromCheckout`) cannot abort-and-refund
 * a paid session.
 */
export async function createAdminResubscribeCheckout(
  input: AdminResubscribeCheckoutInput,
  deps: AdminResubscribeCheckoutDeps = {}
): Promise<ResubscribeCheckoutResult> {
  /* c8 ignore start -- production defaults; unit tests inject every dep */
  const readBusiness = deps.getBusinessRow ?? getBusiness;
  const readSubscription = deps.getSubscriptionRow ?? getSubscription;
  const readProfile = deps.getProfile ?? getCustomerProfileById;
  const openSession = deps.createSession ?? createResubscribeCheckoutSession;
  const appUrl = deps.appUrl ?? process.env.NEXT_PUBLIC_APP_URL ?? "http://127.0.0.1:3000";
  /* c8 ignore stop */
  const now = input.now ?? new Date();

  const business = await readBusiness(input.businessId);
  if (!business) return refuse("business_not_found");

  const existing: SubscriptionRow | null = await readSubscription(input.businessId);
  if (!existing) return refuse("subscription_not_found");
  if (!isCanceledInGrace(existing, now)) return refuse("subscription_not_in_grace");

  const ownerEmail = business.owner_email?.trim() ?? "";
  if (!ownerEmail) return refuse("no_owner_email");

  // Enterprise (or any non-self-serve row) resubscribes at Standard unless
  // the operator passed an explicit starter/standard override.
  const tier = input.tier ?? pickSelfServeTier(existing.tier) ?? "standard";
  const billingPeriod: BillingPeriod =
    input.billingPeriod ?? existing.billing_period ?? "monthly";
  if (
    billingPeriod !== "monthly" &&
    billingPeriod !== "annual" &&
    billingPeriod !== "biennial"
  ) {
    return refuse("unsupported_reactivation_period");
  }

  if (!existing.customer_profile_id) return refuse("missing_customer_profile");
  const profile = await readProfile(existing.customer_profile_id);
  if (!profile) return refuse("missing_customer_profile");
  if (profile.lifetime_subscription_count >= LIFETIME_SUBSCRIPTION_CAP) {
    return refuse("lifetime_cap");
  }

  const session = await openSession({
    businessId: input.businessId,
    ownerEmail,
    tier,
    billingPeriod,
    userId: input.businessId,
    customerProfileId: existing.customer_profile_id,
    stripeCustomerId: existing.stripe_customer_id,
    appUrl
  });

  return {
    ok: true,
    url: session.url,
    sessionId: session.id,
    tier,
    billingPeriod,
    ownerEmail
  };
}

function pickSelfServeTier(tier: string): "starter" | "standard" | null {
  return tier === "starter" || tier === "standard" ? tier : null;
}
