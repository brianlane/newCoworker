import type Stripe from "stripe";

/**
 * Shared builders for fake Stripe objects and webhook events.
 *
 * Before this file, every test inlined its own literal:
 * `tests/stripe-webhook-route.test.ts` writes a fresh
 * `vi.mocked(verifyWebhook).mockReturnValue({...})` per case,
 * `tests/change-plan-orchestrator.test.ts` has a local `makeSession`, and
 * `tests/membership-pack-addon-grants.test.ts` has a local `makeInvoice`.
 * Nothing kept those shapes in step, so the metadata contract that the
 * webhook actually branches on lived in dozens of hand-typed copies.
 *
 * The pack metadata contract in particular is worth having in exactly one
 * place: `createVoiceBonusCheckoutSession` / `createUsagePackCheckoutSession`
 * mirror it onto `payment_intent_data.metadata`, which means a manual pack
 * purchase already emits a `payment_intent.succeeded` carrying `checkoutKind`
 * and the unit count. Any code that starts listening for that event has to
 * distinguish it from an auto-reload charge, and a test can only prove that
 * if it builds both objects from the same source of truth.
 */

export type UsagePackCheckoutKind =
  | "voice_bonus_seconds"
  | "sms_bonus_texts"
  | "chat_credit_micros";

/** The metadata key each pack kind carries its amount in. */
export const PACK_UNIT_METADATA_KEY: Record<UsagePackCheckoutKind, string> = {
  voice_bonus_seconds: "voiceSeconds",
  sms_bonus_texts: "smsTexts",
  chat_credit_micros: "creditMicros"
};

export function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

export function epochDaysFromNow(days: number): number {
  return Math.floor((Date.now() + days * 24 * 60 * 60 * 1000) / 1000);
}

export function makeCheckoutSession(
  over: Partial<Stripe.Checkout.Session> = {}
): Stripe.Checkout.Session {
  return {
    id: "cs_test_default",
    object: "checkout.session",
    mode: "subscription",
    status: "complete",
    payment_status: "paid",
    created: nowSec(),
    customer: "cus_test_default",
    subscription: "sub_test_default",
    invoice: null,
    amount_total: 4_320,
    currency: "usd",
    metadata: {},
    ...over
  } as unknown as Stripe.Checkout.Session;
}

/**
 * A one-time pack Checkout Session, built the way
 * `createUsagePackCheckoutSession` builds it: `mode: "payment"`, the kind and
 * the unit count in metadata.
 */
export function makePackCheckoutSession(params: {
  kind: UsagePackCheckoutKind;
  businessId: string;
  units: number;
  sessionId?: string;
  userId?: string;
  over?: Partial<Stripe.Checkout.Session>;
}): Stripe.Checkout.Session {
  const { kind, businessId, units, sessionId, userId, over = {} } = params;
  return makeCheckoutSession({
    id: sessionId ?? "cs_test_pack",
    mode: "payment",
    subscription: null,
    metadata: {
      checkoutKind: kind,
      businessId,
      [PACK_UNIT_METADATA_KEY[kind]]: String(units),
      userId: userId ?? "user_test"
    },
    ...over
  });
}

/** A `mode: "setup"` Checkout Session (card authorization, no charge). */
export function makeSetupSession(params: {
  businessId: string;
  setupIntentId?: string;
  sessionId?: string;
  customerId?: string;
  over?: Partial<Stripe.Checkout.Session>;
}): Stripe.Checkout.Session {
  const { businessId, setupIntentId, sessionId, customerId, over = {} } = params;
  return makeCheckoutSession({
    id: sessionId ?? "cs_test_setup",
    mode: "setup",
    subscription: null,
    amount_total: 0,
    setup_intent: setupIntentId ?? "seti_test_default",
    customer: customerId ?? "cus_test_default",
    metadata: { checkoutKind: "auto_reload_setup", businessId, userId: "user_test" },
    ...over
  } as Partial<Stripe.Checkout.Session>);
}

export function makePaymentIntent(
  over: Partial<Stripe.PaymentIntent> = {}
): Stripe.PaymentIntent {
  return {
    id: "pi_test_default",
    object: "payment_intent",
    status: "succeeded",
    amount: 1_000,
    amount_received: 1_000,
    currency: "usd",
    customer: "cus_test_default",
    payment_method: "pm_test_default",
    created: nowSec(),
    metadata: {},
    ...over
  } as unknown as Stripe.PaymentIntent;
}

/**
 * The PaymentIntent a MANUAL pack Checkout produces today: the session's
 * metadata is mirrored onto it verbatim by `payment_intent_data`, and there
 * is deliberately NO auto-reload marker. Use this to prove a listener does
 * not mistake an ordinary purchase for an auto-reload charge.
 */
export function makeManualPackPaymentIntent(params: {
  kind: UsagePackCheckoutKind;
  businessId: string;
  units: number;
  paymentIntentId?: string;
  over?: Partial<Stripe.PaymentIntent>;
}): Stripe.PaymentIntent {
  const { kind, businessId, units, paymentIntentId, over = {} } = params;
  return makePaymentIntent({
    id: paymentIntentId ?? "pi_test_manual_pack",
    metadata: {
      checkoutKind: kind,
      businessId,
      [PACK_UNIT_METADATA_KEY[kind]]: String(units),
      userId: "user_test"
    },
    ...over
  });
}

export function makeInvoice(over: Partial<Stripe.Invoice> = {}): Stripe.Invoice {
  return {
    id: "in_test_default",
    object: "invoice",
    amount_paid: 4_320,
    amount_due: 4_320,
    currency: "usd",
    created: nowSec(),
    subscription: "sub_test_default",
    ...over
  } as unknown as Stripe.Invoice;
}

/**
 * Overrides are loosely typed here, unlike the flat builders above.
 * `Stripe.Subscription.items` is an `ApiList` with required `has_more` / `url`
 * fields, so a test that only wants to blank the items array (to force the
 * period to be read from the top-level fields) cannot express that as a
 * `Partial<Stripe.Subscription>` without hand-filling list plumbing it does
 * not care about. The return is cast anyway, so the stricter type bought
 * autocomplete and no real safety.
 */
export function makeSubscription(over: Record<string, unknown> = {}): Stripe.Subscription {
  return {
    id: "sub_test_default",
    object: "subscription",
    status: "active",
    customer: "cus_test_default",
    cancel_at_period_end: false,
    current_period_start: epochDaysFromNow(-10),
    current_period_end: epochDaysFromNow(20),
    metadata: {},
    items: {
      object: "list",
      data: [
        {
          id: "si_test_default",
          price: {
            id: "price_test_default",
            recurring: { interval: "month", interval_count: 1 }
          }
        }
      ]
    },
    ...over
  } as unknown as Stripe.Subscription;
}

export function makeCharge(over: Partial<Stripe.Charge> = {}): Stripe.Charge {
  return {
    id: "ch_test_default",
    object: "charge",
    amount: 1_000,
    amount_refunded: 0,
    currency: "usd",
    payment_intent: "pi_test_default",
    invoice: null,
    refunded: false,
    ...over
  } as unknown as Stripe.Charge;
}

let eventSeq = 0;

export function makeEvent<T>(
  type: string,
  object: T,
  over: Partial<Stripe.Event> = {}
): Stripe.Event {
  eventSeq += 1;
  return {
    id: `evt_test_${eventSeq}`,
    object: "event",
    type,
    api_version: "2026-08-26.dahlia",
    created: nowSec(),
    livemode: false,
    data: { object },
    ...over
  } as unknown as Stripe.Event;
}
