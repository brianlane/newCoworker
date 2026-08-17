import Stripe from "stripe";
import type { BillingPeriod } from "@/lib/plans/tier";
import { getCommitmentMonths } from "@/lib/plans/tier";
import { CARRIER_REGISTRATION_FEE_NAME } from "@/lib/plans/carrier-fee";
import { CANADA_MESSAGING_FEE_NAME } from "@/lib/plans/canadian-messaging";
import { MEXICO_MESSAGING_FEE_NAME } from "@/lib/plans/mexican-messaging";
import {
  PRIORITY_SUPPORT_CHECKOUT_KIND,
  PRIORITY_SUPPORT_LINE_NAME,
  PRIORITY_SUPPORT_MONTHLY_CENTS,
  PRIORITY_SUPPORT_SUBSCRIPTION_KIND
} from "@/lib/plans/priority-support";

export function getStripe(secretKey?: string): Stripe {
  const key = secretKey ?? process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY is not configured");
  return new Stripe(key, { apiVersion: "2026-07-29.dahlia" });
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
   * Admin promotion redeemed at signup. Stripe allows exactly ONE discount on
   * a Checkout Session, so this WINS over `discountCouponId` (the monthly
   * intro coupon) when both are present. The order summary applies the same
   * precedence, so what the customer previewed is what Stripe charges. We pass
   * the promotion code rather than its coupon so the redemption also lands on
   * the code's `times_redeemed` in the Stripe dashboard.
   */
  discountPromotionCodeId?: string;
  /**
   * One-time 10DLC carrier-registration pass-through (Phase C3), added as an
   * inline `price_data` line so no per-environment Stripe product setup is
   * needed. Set by the NEW-SIGNUP checkout only: plan changes and
   * reactivations reuse the tenant's existing campaign and must not re-charge
   * it. Billed once on the first invoice; the 30-day refund carves it out.
   */
  oneTimeCarrierFeeCents?: number;
  /**
   * Canadian messaging surcharge: a RECURRING labeled line item riding the
   * subscription (Canadian carriers charge per-message pass-through fees US
   * traffic doesn't). Stripe requires every item on a subscription to share
   * the billing interval, so the fee bills at the plan's cadence: monthly
   * plans pay `monthlyCents` each month; term plans pay `monthlyCents × term`
   * upfront alongside the prepaid plan. Set only when the signup is detected
   * as Canadian (see isCanadianBusiness); existing tenants are grandfathered.
   */
  canadaFee?: { monthlyCents: number; billingPeriod: BillingPeriod };
  /**
   * Mexican messaging surcharge: same shape and cadence rules as
   * `canadaFee` (a Mexican tenant's US +1 number texts and calls +52 at
   * international rates). Set only when the signup resolves to Mexico (see
   * isMexicanBusiness); existing tenants are grandfathered. The two fees
   * are mutually exclusive by construction: resolveBusinessCountry returns
   * one country.
   */
  mexicoFee?: { monthlyCents: number; billingPeriod: BillingPeriod };
  /**
   * Optional recurring usage-pack add-ons (voice / SMS / chat) on the
   * membership subscription. `unitAmountCents` is already
   * discountedMonthly × commitment months; `billingPeriod` sets the matching
   * Stripe recurring interval (same lockstep rule as the Canada fee).
   */
  packAddonLines?: ReadonlyArray<{
    name: string;
    unitAmountCents: number;
    quantity: number;
    billingPeriod: BillingPeriod;
  }>;
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
  if ((params.canadaFee?.monthlyCents ?? 0) > 0 && params.canadaFee) {
    const months = getCommitmentMonths(params.canadaFee.billingPeriod);
    lineItems.push({
      price_data: {
        currency: "usd",
        product_data: { name: CANADA_MESSAGING_FEE_NAME },
        unit_amount: params.canadaFee.monthlyCents * months,
        recurring: { interval: "month", interval_count: months }
      },
      quantity: 1
    });
  }
  if ((params.mexicoFee?.monthlyCents ?? 0) > 0 && params.mexicoFee) {
    const months = getCommitmentMonths(params.mexicoFee.billingPeriod);
    lineItems.push({
      price_data: {
        currency: "usd",
        product_data: { name: MEXICO_MESSAGING_FEE_NAME },
        unit_amount: params.mexicoFee.monthlyCents * months,
        recurring: { interval: "month", interval_count: months }
      },
      quantity: 1
    });
  }
  for (const pack of params.packAddonLines ?? []) {
    if (pack.unitAmountCents <= 0 || pack.quantity <= 0) continue;
    const months = getCommitmentMonths(pack.billingPeriod);
    lineItems.push({
      price_data: {
        currency: "usd",
        product_data: { name: pack.name },
        unit_amount: pack.unitAmountCents,
        recurring: { interval: "month", interval_count: months }
      },
      quantity: pack.quantity
    });
  }
  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    line_items: lineItems,
    success_url: params.successUrl,
    cancel_url: params.cancelUrl,
    customer_email: params.customerEmail,
    billing_address_collection: "auto",
    discounts: params.discountPromotionCodeId
      ? [{ promotion_code: params.discountPromotionCodeId }]
      : params.discountCouponId
        ? [{ coupon: params.discountCouponId }]
        : undefined,
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
    const futureItemCount = futurePhase?.items.length ?? 0;
    const futurePrice = futurePhase?.items[0]?.price;
    const futurePriceId = typeof futurePrice === "string" ? futurePrice : futurePrice?.id;
    // Idempotent only when the renewal phase matches the plan price AND
    // carries every subscription item: a schedule built before an add-on
    // (e.g. the Canadian messaging surcharge) existed must be repaired, or
    // the add-on silently drops at term rollover.
    if (futurePriceId === renewalPriceId && futureItemCount === subscription.items.data.length) {
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

  // Preserve any add-on items beyond the plan (e.g. the Canadian messaging
  // surcharge) in BOTH phases: rewriting the phases with only the plan item
  // would silently strip a live add-on from the subscription and drop it at
  // renewal.
  const addOnItems = subscription.items.data
    .slice(1)
    .map((item) => ({ price: item.price.id, quantity: item.quantity ?? 1 }));

  // Phase 2 rolls the plan onto the MONTHLY renewal price, and Stripe
  // requires every item in a phase to share the billing interval, so a
  // term-cadence add-on (e.g. the Canada fee billed ×24 upfront) must be
  // converted to its monthly equivalent (same product, unit ÷ term months).
  const renewalAddOnItems = subscription.items.data.slice(1).map((item) => {
    const price = item.price;
    const quantity = item.quantity ?? 1;
    const intervalMonths =
      price.recurring?.interval === "year"
        ? (price.recurring.interval_count ?? 1) * 12
        : price.recurring?.interval_count ?? 1;
    if (price.recurring?.interval === "month" && intervalMonths === 1) {
      return { price: price.id, quantity };
    }
    const productId = typeof price.product === "string" ? price.product : price.product.id;
    return {
      price_data: {
        currency: price.currency,
        product: productId,
        unit_amount: Math.round((price.unit_amount ?? 0) / Math.max(intervalMonths, 1)),
        recurring: { interval: "month" as const, interval_count: 1 }
      },
      quantity
    };
  });

  await stripe.subscriptionSchedules.update(schedule.id, {
    end_behavior: "release",
    proration_behavior: "none",
    phases: [
      {
        start_date: currentPhase.start_date,
        end_date: currentPhase.end_date,
        items: [
          { price: currentItem.price.id, quantity: currentItem.quantity ?? 1 },
          ...addOnItems
        ]
      },
      {
        start_date: currentPhase.end_date,
        items: [
          { price: renewalPriceId, quantity: currentItem.quantity ?? 1 },
          ...renewalAddOnItems
        ]
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
 * Inline `price_data`: the catalog in src/lib/plans/white-glove.ts is the
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
  /** enterprise_deals.id: the row is the pricing source of truth. */
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
 * (custom per deal, no per-environment Stripe product/price setup), plus an
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
        product_data: { name: `Enterprise plan: ${params.businessName}` },
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

export type PrioritySupportCheckoutParams = {
  businessId: string;
  successUrl: string;
  cancelUrl: string;
  /** Existing Stripe customer, so the add-on lands on the same payer. */
  customerId?: string;
  customerEmail?: string;
  /** Absent when an admin generates a pay link for the owner to open. */
  userId?: string;
};

/**
 * Hosted Checkout for the $400/month priority support add-on.
 *
 * A SEPARATE `mode: "subscription"` from the tenant's membership, on the same
 * customer.
 *
 * NOT because Stripe forbids the alternative. It was documented that way and
 * that was wrong: Stripe only requires each item's recurring period to be a
 * multiple of the shortest, so `month/1` rides a `month/24` subscription fine
 * (verified 2026-08-17, debug/priority-support-stripe-testmode.ts). It stays
 * separate for lifecycle reasons: change-plan rebuilds the membership from the
 * selector's lines and would destroy a line item, the 409 `plan_unchanged`
 * guard blocks adding one mid-term, and the 30-day refund carve-out matches
 * lines on the membership invoice. Full reasoning in
 * src/lib/plans/priority-support.ts.
 *
 * Hosted Checkout rather than creating the subscription off-session against
 * the card already on file: that card was collected under the MEMBERSHIP's
 * subscription mandate, which does not cover starting a second recurring
 * charge. Auto-reload made the same call for the same reason (see
 * createAutoReloadSetupSession below).
 *
 * No `billing_cycle_anchor` and no `proration_behavior`: Stripe's defaults
 * start the cycle at creation and charge the full $400, which is what we want.
 * The tenant gets a second bill date rather than a partial first month.
 *
 * `subscriptionKind` is mirrored onto `subscription_data.metadata` and is
 * load-bearing, not decorative. The webhook's `invoice.paid` handler resolves
 * an unrecognized subscription by its `businessId` metadata; without this
 * marker to gate on, a paid priority-support invoice would be attributed to
 * the MEMBERSHIP row and overwrite its cached billing period with this
 * subscription's monthly window.
 */
export async function createPrioritySupportCheckoutSession(
  params: PrioritySupportCheckoutParams
): Promise<{ id: string; url: string }> {
  const stripe = getStripe();
  const metadata: Record<string, string> = {
    checkoutKind: PRIORITY_SUPPORT_CHECKOUT_KIND,
    subscriptionKind: PRIORITY_SUPPORT_SUBSCRIPTION_KIND,
    businessId: params.businessId,
    ...(params.userId ? { userId: params.userId } : {})
  };
  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    line_items: [
      {
        price_data: {
          currency: "usd",
          product_data: { name: PRIORITY_SUPPORT_LINE_NAME },
          unit_amount: PRIORITY_SUPPORT_MONTHLY_CENTS,
          recurring: { interval: "month" }
        },
        quantity: 1
      }
    ],
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

/**
 * Wind the priority support add-on down at the end of the period the tenant
 * already paid for. Never an immediate cancel: coverage runs to
 * `current_period_end` and then lapses on its own, because
 * `businesses.priority_support_until` was already stamped that far out and is
 * only ever moved forward by payment.
 */
export async function cancelPrioritySupportSubscription(
  subscriptionId: string
): Promise<Stripe.Subscription> {
  const stripe = getStripe();
  return stripe.subscriptions.update(subscriptionId, { cancel_at_period_end: true });
}

/**
 * Undo a wind-down: the tenant changed their mind while still inside the period
 * they already paid for, so the subscription is alive and merely flagged to
 * stop. Clearing the flag resumes it with no new charge until the normal
 * renewal, which is the only correct "restart" for that state. Opening a fresh
 * subscription instead would double-bill, and the one-live-row index rejects it.
 */
export async function resumePrioritySupportSubscription(
  subscriptionId: string
): Promise<Stripe.Subscription> {
  const stripe = getStripe();
  return stripe.subscriptions.update(subscriptionId, { cancel_at_period_end: false });
}

/**
 * Card authorization for auto-reload, as a hosted `mode: "setup"` Checkout.
 *
 * The membership card on file was collected under a SUBSCRIPTION mandate,
 * which does not cover ad-hoc merchant-initiated top-ups. Rather than reuse it
 * implicitly, auto-reload asks the tenant to authorize a card explicitly.
 * Setup-mode Checkout creates a SetupIntent whose `usage` already defaults to
 * `off_session`, which is the mandate we need, so we do not set it here (the
 * pinned API version does not accept it on `setup_intent_data` anyway).
 *
 * Hosted Checkout rather than Elements: no card form, no Stripe.js, and no new
 * PCI surface in this app, matching every other payment path in the repo.
 */
export async function createAutoReloadSetupSession(params: {
  customerId: string;
  businessId: string;
  userId: string;
  successUrl: string;
  cancelUrl: string;
  /**
   * One line shown on Stripe's own page saying what this card will be used
   * for. Stripe's default setup-mode text says only that the card is being
   * saved, which is not what the tenant is actually agreeing to.
   *
   * Goes in `custom_text.submit`, which Stripe documents as displayed
   * ALONGSIDE the confirmation button, so it is read before authorizing.
   * `after_submit` renders below the button and is the weaker slot for
   * something the tenant is supposed to agree to first.
   *
   * Belt and braces only: the same consent renders in our own UI before the
   * redirect, so a tenant has read it even if Stripe changes how this field
   * displays.
   */
  consentNote?: string;
}): Promise<{ id: string; url: string }> {
  const stripe = getStripe();
  const metadata: Record<string, string> = {
    checkoutKind: "auto_reload_setup",
    businessId: params.businessId,
    userId: params.userId
  };
  const session = await stripe.checkout.sessions.create({
    mode: "setup",
    customer: params.customerId,
    payment_method_types: ["card"],
    success_url: params.successUrl,
    cancel_url: params.cancelUrl,
    metadata,
    setup_intent_data: { metadata },
    // Stripe caps this at 1200 characters and rejects longer ones.
    custom_text: params.consentNote
      ? { submit: { message: params.consentNote.slice(0, 1200) } }
      : {}
  });
  if (!session.url) throw new Error("Stripe setup session URL is null");
  return { id: session.id, url: session.url };
}

export type OffSessionPackChargeParams = {
  customerId: string;
  paymentMethodId: string;
  amountCents: number;
  /** From the Stripe Price, never hardcoded: tenants are not all in USD. */
  currency: string;
  businessId: string;
  checkoutKind: "voice_bonus_seconds" | "sms_bonus_texts" | "chat_credit_micros";
  /** Metadata key matching checkoutKind: voiceSeconds / smsTexts / creditMicros. */
  unitKey: "voiceSeconds" | "smsTexts" | "creditMicros";
  unitValue: number;
  packId: string;
  /** Our ledger row id. Becomes the Stripe idempotency key. */
  eventId: number;
  receiptEmail?: string;
};

/**
 * Charge the authorized card without the tenant present.
 *
 * Two details are load-bearing:
 *
 * 1. `autoReload: "1"`. The manual pack Checkouts mirror their metadata onto
 *    `payment_intent_data`, so an ordinary purchase ALREADY emits a
 *    `payment_intent.succeeded` carrying `checkoutKind` and the unit count.
 *    Any listener keyed on `checkoutKind` alone would grant twice for every
 *    manual purchase, once under `cs_` and once under `pi_`, and the two
 *    distinct keys mean the grant RPC's idempotency cannot catch it. This
 *    marker is what separates the two.
 *
 * 2. `idempotencyKey`. This is what prevents a double charge when we crash
 *    after Stripe accepted the request but before we recorded the intent id.
 *    It is derived from the ledger row, and a stale attempt is RESUMED (same
 *    row, same key) rather than re-claimed, so Stripe replays the original
 *    PaymentIntent instead of creating a second one.
 *
 * `allow_redirects: "never"` because nobody is at the keyboard to complete a
 * redirect-based method.
 */
export async function createOffSessionPackCharge(
  params: OffSessionPackChargeParams
): Promise<Stripe.PaymentIntent> {
  const stripe = getStripe();
  const metadata: Record<string, string> = {
    checkoutKind: params.checkoutKind,
    businessId: params.businessId,
    [params.unitKey]: String(params.unitValue),
    autoReload: "1",
    packId: params.packId,
    autoReloadEventId: String(params.eventId)
  };
  return stripe.paymentIntents.create(
    {
      customer: params.customerId,
      payment_method: params.paymentMethodId,
      amount: params.amountCents,
      currency: params.currency,
      confirm: true,
      off_session: true,
      automatic_payment_methods: { enabled: true, allow_redirects: "never" },
      description: `Auto-reload: ${params.packId}`,
      receipt_email: params.receiptEmail,
      metadata
    },
    { idempotencyKey: `auto_reload:${params.eventId}` }
  );
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
