/**
 * Re-issue the Stripe Checkout link for a signup that has not paid.
 *
 * Signup is "build first, pay last": `/api/business/create` inserts the
 * business row, `/api/checkout` mints a Stripe Checkout session, and the
 * customer pays. When someone abandons at the payment step, or asks for the
 * link again days later, there was no way to hand them one. The only URL any
 * surface could produce was the questionnaire.
 *
 * That gap had teeth on 2026-08-24: a lead texted "I've done the
 * questionnaire, would you be able to send me the link for payment" and the
 * coworker replied with the questionnaire link, because that is the only
 * signup URL it knows. He was looped back to a form he had just finished.
 *
 * This module is the one place that answers "give me a payment link for this
 * business", so the admin console, the agent tool, and any future surface all
 * charge the same thing. It deliberately does NOT reimplement pricing: the
 * price id, the country surcharges, the carrier fee and the intro discount
 * all come from the same helpers `/api/checkout` uses, and
 * `createCheckoutSession` assembles the line items.
 *
 * Two things it does not carry over from the original attempt, because they
 * live in the customer's browser draft rather than on any row we can trust
 * later: promo codes and recurring usage-pack add-ons. A re-issued link is
 * the plain plan price. Callers surface that, rather than silently charging
 * someone a different number than they were quoted.
 */

import {
  createCheckoutSession,
  resolveIntroDiscountCouponId,
  resolvePriceId
} from "@/lib/stripe/client";
import {
  createSubscription,
  findCheckoutBlockingSubscription,
  getSubscription,
  type SubscriptionRow
} from "@/lib/db/subscriptions";
import { getBusiness } from "@/lib/db/businesses";
import { authUserExistsByEmail } from "@/lib/auth";
import { getCustomerProfileById, LIFETIME_SUBSCRIPTION_CAP } from "@/lib/db/customer-profiles";
import { resolveBusinessCountry } from "@/lib/plans/business-country";
import { getCommitmentMonths, renewalDateAfterMonths } from "@/lib/plans/tier";
import { CARRIER_REGISTRATION_FEE_CENTS } from "@/lib/plans/carrier-fee";
import { CANADA_MESSAGING_FEE_MONTHLY_CENTS } from "@/lib/plans/canadian-messaging";
import { MEXICO_MESSAGING_FEE_MONTHLY_CENTS } from "@/lib/plans/mexican-messaging";
import { logger } from "@/lib/logger";
import { randomUUID } from "crypto";
import type { BillingPeriod } from "@/lib/plans/tier";

/** Why a payment link was refused. Every one is a deliberate gate, not an error. */
export type SignupPaymentLinkRefusal =
  /** No such business. */
  | "business_not_found"
  /** Enterprise is quoted and invoiced, never self-serve Checkout. */
  | "tier_not_self_serve"
  /** Live or in-grace service already exists; plan changes belong to Billing. */
  | "already_subscribed"
  /**
   * The owner email already has a login. The anonymous post-payment
   * `admin.createUser` would collide with it, stranding them on a paid
   * checkout. Same gate `/api/checkout` enforces.
   */
  | "account_exists"
  /** The abuse profile has spent its lifetime subscription allotment. */
  | "lifetime_cap"
  /** The row still carries the onboarding sentinel, so we have no address to bill. */
  | "no_owner_email";

export type SignupPaymentLinkResult =
  | {
      ok: true;
      url: string;
      /**
       * Stripe's session id. Stripe expires an OPEN Checkout session 24 hours
       * after creation, so a link that has sat in an inbox longer than that
       * needs re-issuing; this id is what support looks the session up by.
       */
      sessionId: string;
      tier: "starter" | "standard";
      billingPeriod: BillingPeriod;
      ownerEmail: string;
      /** True when this reused the existing pending row rather than inserting one. */
      reusedPendingSubscription: boolean;
    }
  | { ok: false; refusal: SignupPaymentLinkRefusal; message: string };

const REFUSAL_MESSAGES: Record<SignupPaymentLinkRefusal, string> = {
  business_not_found: "Business not found.",
  tier_not_self_serve:
    "Enterprise plans are invoiced, not paid through Checkout. Use an enterprise deal instead.",
  already_subscribed:
    "This account already has live service. Change the plan from Billing instead of issuing a new payment link.",
  account_exists:
    "That owner email already has a login, so a fresh signup checkout would collide with it. Have them sign in instead.",
  lifetime_cap: "This customer has used every subscription their profile allows.",
  no_owner_email: "This signup has no real owner email yet, so there is nobody to bill."
};

function refuse(refusal: SignupPaymentLinkRefusal): SignupPaymentLinkResult {
  return { ok: false, refusal, message: REFUSAL_MESSAGES[refusal] };
}

export type SignupPaymentLinkDeps = {
  getBusinessRow?: typeof getBusiness;
  getSubscriptionRow?: typeof getSubscription;
  findBlocking?: typeof findCheckoutBlockingSubscription;
  authUserExists?: typeof authUserExistsByEmail;
  getProfile?: typeof getCustomerProfileById;
  createSession?: typeof createCheckoutSession;
  createSubscriptionRow?: typeof createSubscription;
  appUrl?: string;
};

export type SignupPaymentLinkInput = {
  businessId: string;
  /**
   * Where to bill. Defaults to the business row's owner email, which is only
   * usable once the pending sentinel has been swapped for a real address; the
   * caller passes one explicitly for a signup that never got that far.
   */
  ownerEmail?: string;
  /** Defaults to whatever the customer last chose, then to the row's tier. */
  tier?: "starter" | "standard";
  billingPeriod?: BillingPeriod;
};

/** True for the `pending+<id>@onboarding.local` sentinel, which is not a real address. */
function isPendingSentinelEmail(email: string): boolean {
  return email.endsWith("@onboarding.local");
}

/**
 * Mint a Checkout link for an unpaid signup.
 *
 * The tier and billing period default to the customer's own last choice,
 * read off their most recent subscription row, so re-issuing a link never
 * silently moves someone onto a different plan than the one they picked.
 */
export async function createSignupPaymentLink(
  input: SignupPaymentLinkInput,
  deps: SignupPaymentLinkDeps = {}
): Promise<SignupPaymentLinkResult> {
  /* c8 ignore start -- production defaults; unit tests inject every dep */
  const readBusiness = deps.getBusinessRow ?? getBusiness;
  const readSubscription = deps.getSubscriptionRow ?? getSubscription;
  const findBlocking = deps.findBlocking ?? findCheckoutBlockingSubscription;
  const authExists = deps.authUserExists ?? authUserExistsByEmail;
  const readProfile = deps.getProfile ?? getCustomerProfileById;
  const openSession = deps.createSession ?? createCheckoutSession;
  const insertSubscription = deps.createSubscriptionRow ?? createSubscription;
  const appUrl = deps.appUrl ?? process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  /* c8 ignore stop */

  const business = await readBusiness(input.businessId);
  if (!business) return refuse("business_not_found");

  const existing: SubscriptionRow | null = await readSubscription(input.businessId);

  const tier = input.tier ?? pickSelfServeTier(existing?.tier ?? business.tier);
  if (!tier) return refuse("tier_not_self_serve");

  const billingPeriod: BillingPeriod =
    input.billingPeriod ?? existing?.billing_period ?? "biennial";

  // Read once, used twice: the lifetime cap below, and the billing address
  // when the row itself has none.
  const profileId = existing?.customer_profile_id ?? business.customer_profile_id ?? null;
  const profile = profileId ? await readProfile(profileId) : null;

  // The case this whole module exists for is a signup that never finished, so
  // its `businesses.owner_email` is still `pending+<id>@onboarding.local`. The
  // real address was captured at checkout and lives on the customer profile,
  // so an operator does not have to go dig it out of the draft to send a link.
  const rowEmail = business.owner_email;
  const ownerEmail =
    input.ownerEmail ??
    (rowEmail && !isPendingSentinelEmail(rowEmail) ? rowEmail : profile?.normalized_email) ??
    null;
  if (!ownerEmail) return refuse("no_owner_email");

  // Same re-onboarding hard stop /api/checkout enforces: an account with live
  // or in-grace service changes plans from Billing, it does not start a
  // second subscription.
  if (await findBlocking([input.businessId])) return refuse("already_subscribed");

  if (await authExists(ownerEmail)) return refuse("account_exists");

  // The lifetime cap is abuse protection, so a link minted by an admin or an
  // agent must respect it exactly as the self-serve route does. The count
  // only increments on `checkout.session.completed`, so re-issuing a link to
  // an abandoned cart never burns one.
  if (profile && profile.lifetime_subscription_count >= LIFETIME_SUBSCRIPTION_CAP) {
    return refuse("lifetime_cap");
  }

  // Classified from the stored row, which provisioning also reads, so the
  // surcharge and the DID country cannot diverge.
  const country = resolveBusinessCountry({
    phone: business.phone ?? null,
    timezone: business.timezone ?? null
  });
  const canadian = country === "CA";
  const mexican = country === "MX";

  const commitmentMonths = getCommitmentMonths(billingPeriod);

  // Reuse the pending row rather than inserting a second one. The Stripe
  // webhook resolves by newest-first, so stacking rows would leave an
  // orphan `pending` behind on every re-issue.
  const reusedPendingSubscription = existing?.status === "pending";
  if (!reusedPendingSubscription) {
    await insertSubscription({
      id: randomUUID(),
      business_id: input.businessId,
      stripe_customer_id: null,
      stripe_subscription_id: null,
      tier,
      status: "pending",
      billing_period: billingPeriod,
      renewal_at: renewalDateAfterMonths(new Date(), commitmentMonths).toISOString(),
      commitment_months: commitmentMonths,
      customer_profile_id: profileId
    });
  }

  const session = await openSession({
    priceId: resolvePriceId(tier, billingPeriod),
    successUrl: `${appUrl}/onboard/success?session_id={CHECKOUT_SESSION_ID}`,
    // A re-issued link is opened from a text or an email, not from Step 3, so
    // cancelling returns to pricing rather than to a questionnaire the
    // customer has usually already finished.
    cancelUrl: `${appUrl}/pricing`,
    customerEmail: ownerEmail,
    discountCouponId: resolveIntroDiscountCouponId(tier, billingPeriod),
    // Mexican signups skip the US 10DLC charge, matching /api/checkout.
    oneTimeCarrierFeeCents: mexican ? 0 : CARRIER_REGISTRATION_FEE_CENTS,
    ...(canadian
      ? { canadaFee: { monthlyCents: CANADA_MESSAGING_FEE_MONTHLY_CENTS, billingPeriod } }
      : {}),
    ...(mexican
      ? { mexicoFee: { monthlyCents: MEXICO_MESSAGING_FEE_MONTHLY_CENTS, billingPeriod } }
      : {}),
    metadata: {
      businessId: input.businessId,
      tier,
      billingPeriod,
      userId: input.businessId,
      ...(profileId ? { customerProfileId: profileId } : {}),
      ...(canadian ? { canadianMessagingFee: "1" } : {}),
      ...(mexican ? { mexicanMessagingFee: "1" } : {}),
      reissued: "1"
    }
  });

  logger.info("signup-payment-link: issued", {
    businessId: input.businessId,
    tier,
    billingPeriod,
    reusedPendingSubscription
  });

  return {
    ok: true,
    url: session.url,
    sessionId: session.id,
    tier,
    billingPeriod,
    ownerEmail,
    reusedPendingSubscription
  };
}

/** Enterprise is quoted and invoiced, so it never gets a self-serve link. */
function pickSelfServeTier(tier: string): "starter" | "standard" | null {
  return tier === "starter" || tier === "standard" ? tier : null;
}
