import Stripe from "stripe";
import type { BillingPeriod } from "@/lib/plans/tier";

export function getStripe(secretKey?: string): Stripe {
  const key = secretKey ?? process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY is not configured");
  return new Stripe(key, { apiVersion: "2026-02-25.clover" });
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
};

export async function createCheckoutSession(params: CheckoutParams): Promise<{
  id: string;
  url: string;
}> {
  const stripe = getStripe();
  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    line_items: [{ price: params.priceId, quantity: 1 }],
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
