import Stripe from "stripe";
import type { BillingPeriod } from "@/lib/plans/tier";
import { CARRIER_REGISTRATION_FEE_NAME } from "@/lib/plans/carrier-fee";

export function getStripe(secretKey?: string): Stripe {
  const key = secretKey ?? process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY is not configured");
  return new Stripe(key, { apiVersion: "2026-06-24.dahlia" });
}

export function verifyWebhook(payload: string, signature: string, secret?: string): Stripe.Event {
  const webhookSecret = secret ?? process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) throw new Error("STRIPE_WEBHOOK_SECRET is not configured");
  try {
    return getStripe().webhooks.constructEvent(payload, signature, webhookSecret);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Webhook signature verification failed: ${msg}`);
  }
}

export type CheckoutParams = {
  priceId: string;
  successUrl: string;
  cancelUrl: string;
  customerEmail?: string;
  metadata?: Record<string, string>;
  discountCouponId?: string;
  /**
   * One-time 10DLC carrier-registration pass-through (Phase C3), added as an
   * inline `price_data` line so no per-environment Stripe product setup is
   * needed. Set by the NEW-SIGNUP checkout only — plan changes and
   * reactivations reuse the tenant's existing campaign and must not re-charge
   * it. Billed once on the first invoice; the 30-day refund carves it out.
   */
  oneTimeCarrierFeeCents?: number;
};

export async function createCheckoutSession(params: CheckoutParams): Promise<{
  id: string;
  url: string;
}> {
  const stripe = getStripe();
  const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = [
    { price: params.priceId, quantity: 1 }
  ];
  if ((params.oneTimeCarrierFeeCents ?? 0) > 0) {
    lineItems.push({
      price_data: {
        currency: "usd",
        product_data: { name: CARRIER_REGISTRATION_FEE_NAME },
        unit_amount: params.oneTimeCarrierFeeCents
      },
      quantity: 1
    });
  }
  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    line_items: lineItems,
    success_url: params.successUrl,
    cancel_url: params.cancelUrl,
    customer_email: params.customerEmail,
    billing_address_collection: "auto",
    discounts: params.discountCouponId ? [{ coupon: params.discountCouponId }] : undefined,
    metadata: params.metadata ?? {},
    subscription_data: { metadata: params.metadata ?? {} }
  });

  if (!session.url) throw new Error("Stripe checkout session URL is null");
  return { id: session.id, url: session.url };
}

export async function ensureCommitmentSchedule(params: {
  subscriptionId: string;
  tier: "starter" | "standard";
  billingPeriod: BillingPeriod;
}): Promise<string | null> {
  if (params.billingPeriod === "monthly") return null;

  const stripe = getStripe();
  const renewalPriceId = resolveRenewalPriceId(params.tier, params.billingPeriod);
  const subscription = await stripe.subscriptions.retrieve(params.subscriptionId);
  const existingScheduleId =
    typeof subscription.schedule === "string"
      ? subscription.schedule
      : subscription.schedule?.id ?? null;
  const currentItem = subscription.items.data[0];

  if (!currentItem) {
    throw new Error(`Subscription ${params.subscriptionId} has no items to schedule`);
  }

  let schedule: Stripe.SubscriptionSchedule;
  if (existingScheduleId) {
    schedule = await stripe.subscriptionSchedules.retrieve(existingScheduleId);
    const futurePhase = schedule.phases[1];
    const futurePrice = futurePhase?.items[0]?.price;
    const futurePriceId = typeof futurePrice === "string" ? futurePrice : futurePrice?.id;
    if (futurePriceId === renewalPriceId) {
      return schedule.id;
    }
  } else {
    schedule = await stripe.subscriptionSchedules.create({
      from_subscription: params.subscriptionId
    });
  }

  const currentPhase = schedule.current_phase;
  if (!currentPhase) {
    throw new Error(`Subscription schedule ${schedule.id} has no current phase`);
  }

  await stripe.subscriptionSchedules.update(schedule.id, {
    end_behavior: "release",
    proration_behavior: "none",
    phases: [
      {
        start_date: currentPhase.start_date,
        end_date: currentPhase.end_date,
        items: [{ price: currentItem.price.id, quantity: currentItem.quantity ?? 1 }]
      },
      {
        start_date: currentPhase.end_date,
        items: [{ price: renewalPriceId, quantity: currentItem.quantity ?? 1 }]
      }
    ]
  });

  return schedule.id;
}

/**
 * Release the commitment schedule so the Stripe subscription naturally renews
 * for another FULL TERM at the contract price (auto-renew ON). Inverse of
 * `ensureCommitmentSchedule`, which pins phase 2 to the monthly renewal price
 * (auto-renew OFF / month-to-month rollover).
 *
 * Idempotent: no schedule (already released, or never created) is a no-op.
 * Returns the released schedule id, or null when there was nothing to release.
 */
export async function releaseCommitmentSchedule(subscriptionId: string): Promise<string | null> {
  const stripe = getStripe();
  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  const scheduleId =
    typeof subscription.schedule === "string"
      ? subscription.schedule
      : subscription.schedule?.id ?? null;
  if (!scheduleId) return null;
  await stripe.subscriptionSchedules.release(scheduleId);
  return scheduleId;
}

export type VoiceBonusCheckoutParams = {
  priceId: string;
  businessId: string;
  voiceSeconds: number;
  successUrl: string;
  cancelUrl: string;
  customerEmail?: string;
  customerId?: string;
  userId: string;
};

/**
 * One-time Stripe Checkout Session for a voice-bonus pack (§4.1). Must be
 * `mode=payment`; metadata shape is what the Stripe webhook handler expects so
 * `apply_voice_bonus_grant_from_checkout` can record the grant. We pin the
 * Stripe customer when available (otherwise `customer_creation: "always"`)
 * so refunds/disputes on this charge can be traced back to the business.
 */
export async function createVoiceBonusCheckoutSession(
  params: VoiceBonusCheckoutParams
): Promise<{ id: string; url: string }> {
  if (!Number.isInteger(params.voiceSeconds) || params.voiceSeconds <= 0) {
    throw new Error("voiceSeconds must be a positive integer");
  }
  const stripe = getStripe();
  const metadata: Record<string, string> = {
    checkoutKind: "voice_bonus_seconds",
    businessId: params.businessId,
    voiceSeconds: String(params.voiceSeconds),
    userId: params.userId
  };
  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    line_items: [{ price: params.priceId, quantity: 1 }],
    success_url: params.successUrl,
    cancel_url: params.cancelUrl,
    customer: params.customerId,
    customer_email: params.customerId ? undefined : params.customerEmail,
    customer_creation: params.customerId ? undefined : "always",
    billing_address_collection: "auto",
    metadata,
    payment_intent_data: { metadata }
  });
  if (!session.url) throw new Error("Stripe checkout session URL is null");
  return { id: session.id, url: session.url };
}

export type UsagePackCheckoutParams = {
  priceId: string;
  businessId: string;
  successUrl: string;
  cancelUrl: string;
  customerEmail?: string;
  customerId?: string;
  userId: string;
};

/**
 * Shared body for the one-time usage-pack Checkout Sessions (SMS texts +
 * chat credit). Same shape as the voice-bonus session: `mode=payment`,
 * metadata mirrored onto the payment intent so refunds/disputes can be traced
 * back to the originating checkout.
 */
async function createUsagePackCheckoutSession(
  params: UsagePackCheckoutParams,
  metadata: Record<string, string>
): Promise<{ id: string; url: string }> {
  const stripe = getStripe();
  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    line_items: [{ price: params.priceId, quantity: 1 }],
    success_url: params.successUrl,
    cancel_url: params.cancelUrl,
    customer: params.customerId,
    customer_email: params.customerId ? undefined : params.customerEmail,
    customer_creation: params.customerId ? undefined : "always",
    billing_address_collection: "auto",
    metadata,
    payment_intent_data: { metadata }
  });
  if (!session.url) throw new Error("Stripe checkout session URL is null");
  return { id: session.id, url: session.url };
}

/**
 * One-time Checkout Session for an SMS bonus pack. Metadata shape is what the
 * Stripe webhook expects so `apply_sms_bonus_grant_from_checkout` records the
 * grant.
 */
export async function createSmsBonusCheckoutSession(
  params: UsagePackCheckoutParams & { smsTexts: number }
): Promise<{ id: string; url: string }> {
  if (!Number.isInteger(params.smsTexts) || params.smsTexts <= 0) {
    throw new Error("smsTexts must be a positive integer");
  }
  return createUsagePackCheckoutSession(params, {
    checkoutKind: "sms_bonus_texts",
    businessId: params.businessId,
    smsTexts: String(params.smsTexts),
    userId: params.userId
  });
}

/**
 * One-time Checkout Session for a Gemini chat spend-credit pack. Metadata
 * shape is what the Stripe webhook expects so
 * `apply_chat_credit_grant_from_checkout` records the grant.
 */
export async function createChatCreditCheckoutSession(
  params: UsagePackCheckoutParams & { creditMicros: number }
): Promise<{ id: string; url: string }> {
  if (!Number.isInteger(params.creditMicros) || params.creditMicros <= 0) {
    throw new Error("creditMicros must be a positive integer");
  }
  return createUsagePackCheckoutSession(params, {
    checkoutKind: "chat_credit_micros",
    businessId: params.businessId,
    creditMicros: String(params.creditMicros),
    userId: params.userId
  });
}

export type WhiteGloveCheckoutParams = {
  /** Fixed catalog id ("setup"/"buildout"), or "custom" for admin offers. */
  packageId: string;
  packageName: string;
  amountCents: number;
  /** Absent for PROSPECT offers paid via the public /offer link (no account yet). */
  businessId?: string;
  /**
   * Custom admin-authored offer id (white_glove_offers.id). When set, the
   * webhook marks THAT row paid instead of stamping a fixed package on the
   * business.
   */
  offerId?: string;
  successUrl: string;
  cancelUrl: string;
  customerEmail?: string;
  customerId?: string;
  /** Absent for unauthenticated prospect payments. */
  userId?: string;
};

/**
 * One-time Checkout Session for a white-glove onboarding package (Phase C5).
 * Inline `price_data` — the catalog in src/lib/plans/white-glove.ts is the
 * pricing source of truth, so no per-environment Stripe product setup is
 * needed. Metadata shape is what the Stripe webhook expects
 * (`checkoutKind: "white_glove_package"`), mirrored onto the payment intent
 * so refunds/disputes trace back to the purchase.
 */
export async function createWhiteGloveCheckoutSession(
  params: WhiteGloveCheckoutParams
): Promise<{ id: string; url: string }> {
  if (!Number.isInteger(params.amountCents) || params.amountCents <= 0) {
    throw new Error("amountCents must be a positive integer");
  }
  const stripe = getStripe();
  const metadata: Record<string, string> = {
    checkoutKind: "white_glove_package",
    ...(params.businessId ? { businessId: params.businessId } : {}),
    whiteGlovePackage: params.packageId,
    ...(params.offerId ? { whiteGloveOfferId: params.offerId } : {}),
    ...(params.userId ? { userId: params.userId } : {})
  };
  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    line_items: [
      {
        price_data: {
          currency: "usd",
          product_data: { name: params.packageName },
          unit_amount: params.amountCents
        },
        quantity: 1
      }
    ],
    success_url: params.successUrl,
    cancel_url: params.cancelUrl,
    customer: params.customerId,
    customer_email: params.customerId ? undefined : params.customerEmail,
    customer_creation: params.customerId ? undefined : "always",
    billing_address_collection: "auto",
    metadata,
    payment_intent_data: { metadata }
  });
  if (!session.url) throw new Error("Stripe checkout session URL is null");
  return { id: session.id, url: session.url };
}

export type EnterpriseDealCheckoutParams = {
  /** enterprise_deals.id — the row is the pricing source of truth. */
  dealId: string;
  businessId: string;
  businessName: string;
  monthlyCents: number;
  /** One-time setup fee billed on the first invoice; 0 omits the line. */
  setupCents: number;
  successUrl: string;
  cancelUrl: string;
  customerEmail?: string;
  customerId?: string;
};

/**
 * Recurring Checkout Session for an admin-authored enterprise deal: a
 * `mode=subscription` session whose monthly price is inline `price_data`
 * (custom per deal — no per-environment Stripe product/price setup), plus an
 * optional one-time setup-fee line billed on the first invoice. Metadata
 * shape is what the Stripe webhook expects (`checkoutKind:
 * "enterprise_deal"`); it is mirrored onto the subscription so later
 * subscription lifecycle events can be traced back to the business.
 */
export async function createEnterpriseDealCheckoutSession(
  params: EnterpriseDealCheckoutParams
): Promise<{ id: string; url: string }> {
  if (!Number.isInteger(params.monthlyCents) || params.monthlyCents <= 0) {
    throw new Error("monthlyCents must be a positive integer");
  }
  if (!Number.isInteger(params.setupCents) || params.setupCents < 0) {
    throw new Error("setupCents must be a non-negative integer");
  }
  const stripe = getStripe();
  const metadata: Record<string, string> = {
    checkoutKind: "enterprise_deal",
    enterpriseDealId: params.dealId,
    businessId: params.businessId,
    tier: "enterprise"
  };
  const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = [
    {
      price_data: {
        currency: "usd",
        product_data: { name: `Enterprise plan — ${params.businessName}` },
        unit_amount: params.monthlyCents,
        recurring: { interval: "month" }
      },
      quantity: 1
    }
  ];
  if (params.setupCents > 0) {
    lineItems.push({
      price_data: {
        currency: "usd",
        product_data: { name: "Enterprise setup (one-time)" },
        unit_amount: params.setupCents
      },
      quantity: 1
    });
  }
  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    line_items: lineItems,
    success_url: params.successUrl,
    cancel_url: params.cancelUrl,
    customer: params.customerId,
    customer_email: params.customerId ? undefined : params.customerEmail,
    billing_address_collection: "auto",
    metadata,
    subscription_data: { metadata }
  });
  if (!session.url) throw new Error("Stripe checkout session URL is null");
  return { id: session.id, url: session.url };
}

export async function createCustomerPortalSession(params: {
  customerId: string;
  returnUrl: string;
}): Promise<{ url: string }> {
  const stripe = getStripe();
  const session = await stripe.billingPortal.sessions.create({
    customer: params.customerId,
    return_url: params.returnUrl
  });
  return { url: session.url };
}

export function resolvePriceId(
  tier: "starter" | "standard",
  period: BillingPeriod = "biennial"
): string {
  const envKey = `STRIPE_${tier.toUpperCase()}_${periodToEnvSuffix(period)}_PRICE_ID`;
  const priceId = process.env[envKey];
  if (!priceId) throw new Error(`Stripe Price ID not configured for tier: ${tier}, period: ${period} (env: ${envKey})`);
  return priceId;
}

export function resolveIntroDiscountCouponId(
  tier: "starter" | "standard",
  period: BillingPeriod
): string | undefined {
  if (period !== "monthly") return undefined;

  const envKey = `STRIPE_${tier.toUpperCase()}_${periodToEnvSuffix(period)}_INTRO_COUPON_ID`;
  const couponId = process.env[envKey];
  if (!couponId) {
    throw new Error(
      `Stripe intro coupon not configured for tier: ${tier}, period: ${period} (env: ${envKey})`
    );
  }
  return couponId;
}

export function resolveRenewalPriceId(
  tier: "starter" | "standard",
  period: Exclude<BillingPeriod, "monthly">
): string {
  const envKey = `STRIPE_${tier.toUpperCase()}_${periodToEnvSuffix(period)}_RENEWAL_PRICE_ID`;
  const priceId = process.env[envKey];
  if (!priceId) {
    throw new Error(
      `Stripe renewal Price ID not configured for tier: ${tier}, period: ${period} (env: ${envKey})`
    );
  }
  return priceId;
}

function periodToEnvSuffix(period: BillingPeriod): string {
  const map: Record<BillingPeriod, string> = {
    biennial: "24MO",
    annual: "12MO",
    monthly: "1MO"
  };
  return map[period];
}
