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
    metadata: params.metadata ?? {},
    subscription_data: { metadata: params.metadata ?? {} }
  });

  if (!session.url) throw new Error("Stripe checkout session URL is null");
  return { id: session.id, url: session.url };
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

function periodToEnvSuffix(period: BillingPeriod): string {
  const map: Record<BillingPeriod, string> = {
    biennial: "24MO",
    annual: "12MO",
    monthly: "1MO"
  };
  return map[period];
}
