import { ensureCommitmentSchedule, getStripe, verifyWebhook } from "@/lib/stripe/client";
import {
  getSubscription,
  getSubscriptionByStripeSubscriptionId,
  stripeSubscriptionPeriodCache,
  updateSubscription,
  type SubscriptionPeriodStripeCache
} from "@/lib/db/subscriptions";
import { successResponse, errorResponse } from "@/lib/api-response";
import { logger } from "@/lib/logger";
import type Stripe from "stripe";

async function fetchSubscriptionPeriodCacheOrEmpty(
  subscriptionId: string,
  logMessage: string,
  logFields?: Record<string, unknown>
): Promise<SubscriptionPeriodStripeCache | Record<string, never>> {
  try {
    const stripeSub = await getStripe().subscriptions.retrieve(subscriptionId);
    return stripeSubscriptionPeriodCache(stripeSub);
  } catch (err) {
    logger.error(logMessage, {
      subscriptionId,
      ...logFields,
      error: err instanceof Error ? err.message : String(err)
    });
    return {};
  }
}

export async function POST(request: Request) {
  const signature = request.headers.get("stripe-signature");
  if (!signature) return errorResponse("VALIDATION_ERROR", "Missing stripe-signature", 400);

  const payload = await request.text();

  let event: Stripe.Event;
  try {
    event = verifyWebhook(payload, signature);
  } catch (err) {
    logger.error("Stripe webhook signature failed", {
      error: err instanceof Error ? err.message : String(err)
    });
    return errorResponse("FORBIDDEN", "Invalid webhook signature", 403);
  }

  try {
    switch (event.type) {
      case "checkout.session.completed":
      case "checkout.session.async_payment_succeeded": {
        const session = event.data.object as Stripe.Checkout.Session;
        await activateCheckoutSession(session, event.id);
        break;
      }

      case "checkout.session.async_payment_failed": {
        const session = event.data.object as Stripe.Checkout.Session;
        const businessId = session.metadata?.businessId;
        if (businessId) {
          const existing = await getSubscription(businessId);
          if (existing) {
            await updateSubscription(existing.id, { status: "past_due" });
          }
        }
        break;
      }

      case "customer.subscription.updated": {
        const sub = event.data.object as Stripe.Subscription;
        const businessId = sub.metadata?.businessId;
        if (businessId) {
          const existing = await getSubscription(businessId);
          if (existing) {
            type DbStatus = "active" | "past_due" | "canceled" | "pending";
            const statusMap: Record<string, DbStatus> = {
              active: "active",
              trialing: "active",
              past_due: "past_due",
              unpaid: "past_due",
              canceled: "canceled",
              incomplete_expired: "canceled",
              incomplete: "pending",
              paused: "past_due"
            };
            const status: DbStatus = statusMap[sub.status] ?? "pending";
            await updateSubscription(existing.id, {
              status,
              ...stripeSubscriptionPeriodCache(sub)
            });
          }
        }
        break;
      }

      case "customer.subscription.deleted": {
        const sub = event.data.object as Stripe.Subscription;
        const businessId = sub.metadata?.businessId;
        if (businessId) {
          const existing = await getSubscription(businessId);
          if (existing) {
            await updateSubscription(existing.id, { status: "canceled" });
          }
        }
        break;
      }

      case "invoice.paid": {
        const invoice = event.data.object as Stripe.Invoice;
        const subscriptionId = getInvoiceSubscriptionId(invoice);

        if (subscriptionId) {
          const existing = await getSubscriptionByStripeSubscriptionId(subscriptionId);
          if (existing) {
            const periodCache = await fetchSubscriptionPeriodCacheOrEmpty(
              subscriptionId,
              "Stripe subscription retrieve failed on invoice.paid"
            );
            await updateSubscription(existing.id, { status: "active", ...periodCache });
          }
        }
        break;
      }

      case "invoice.payment_failed": {
        const invoice = event.data.object as Stripe.Invoice;
        const subscriptionId = getInvoiceSubscriptionId(invoice);

        if (subscriptionId) {
          const existing = await getSubscriptionByStripeSubscriptionId(subscriptionId);
          if (existing) {
            const periodCache = await fetchSubscriptionPeriodCacheOrEmpty(
              subscriptionId,
              "Stripe subscription retrieve failed on invoice.payment_failed"
            );
            await updateSubscription(existing.id, { status: "past_due", ...periodCache });
          }
        }
        break;
      }

      default:
        logger.debug("Unhandled Stripe event", { type: event.type });
    }
  } catch (err) {
    logger.error("Stripe webhook processing error", {
      error: err instanceof Error ? err.message : String(err),
      eventType: event.type
    });
    return errorResponse("INTERNAL_SERVER_ERROR", "Webhook processing failed", 500);
  }

  return successResponse({ received: true, eventId: event.id });
}

async function activateCheckoutSession(session: Stripe.Checkout.Session, eventId: string) {
  if (
    session.mode === "payment" &&
    session.metadata?.checkoutKind === "voice_bonus_seconds"
  ) {
    await applyVoiceBonusGrantFromCheckout(session, eventId);
    return;
  }

  const businessId = session.metadata?.businessId;
  const tier = (session.metadata?.tier ?? "starter") as "starter" | "standard" | "enterprise";
  const billingPeriod = session.metadata?.billingPeriod as "monthly" | "annual" | "biennial" | undefined;

  if (!businessId) return;

  const customerId =
    typeof session.customer === "string" ? session.customer : session.customer?.id ?? null;
  const subscriptionId =
    typeof session.subscription === "string"
      ? session.subscription
      : session.subscription?.id ?? null;

  const existing = await getSubscription(businessId);
  const periodCache = subscriptionId
    ? await fetchSubscriptionPeriodCacheOrEmpty(
        subscriptionId,
        "Stripe subscription retrieve failed after checkout",
        { businessId }
      )
    : {};

  if (existing) {
    await updateSubscription(existing.id, {
      status: "active",
      stripe_customer_id: customerId,
      stripe_subscription_id: subscriptionId,
      ...periodCache
    });
  }

  if (subscriptionId && billingPeriod && tier !== "enterprise") {
    try {
      await ensureCommitmentSchedule({
        subscriptionId,
        tier,
        billingPeriod
      });
    } catch (err) {
      logger.error("Stripe commitment schedule setup failed", {
        businessId,
        subscriptionId,
        billingPeriod,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  const { getBusiness } = await import("@/lib/db/businesses");
  const business = await getBusiness(businessId);
  const alreadyOnline = business?.status === "online";
  const alreadyActivated =
    existing?.status === "active" &&
    !!subscriptionId &&
    existing.stripe_subscription_id === subscriptionId;

  if (alreadyOnline || alreadyActivated) {
    logger.info("Skipping duplicate provisioning trigger", {
      businessId,
      eventId,
      alreadyOnline,
      alreadyActivated
    });
    return;
  }

  const { orchestrateProvisioning } = await import("@/lib/provisioning/orchestrate");
  orchestrateProvisioning({ businessId, tier }).catch((err) => {
    logger.error("Provisioning failed after checkout", {
      businessId,
      error: err instanceof Error ? err.message : String(err)
    });
  });
}

/** A la carte voice seconds: Checkout Session payment mode + metadata (see .env.example). §4.1 */
async function applyVoiceBonusGrantFromCheckout(session: Stripe.Checkout.Session, eventId: string) {
  const businessId = session.metadata?.businessId?.trim();
  const rawSeconds =
    session.metadata?.voiceSeconds ?? session.metadata?.voice_seconds ?? "";
  const seconds = Number.parseInt(String(rawSeconds), 10);

  if (!businessId || !Number.isFinite(seconds) || seconds <= 0) {
    logger.warn("voice_bonus_seconds checkout missing businessId or voiceSeconds", {
      eventId,
      sessionId: session.id,
      businessId: businessId ?? null
    });
    return;
  }

  const subRow = await getSubscription(businessId);
  if (!subRow?.stripe_subscription_id) {
    logger.warn("voice_bonus_seconds: no subscription or stripe_subscription_id; grant blocked", {
      eventId,
      businessId,
      sessionId: session.id
    });
    return;
  }
  if (subRow.status !== "active") {
    logger.warn("voice_bonus_seconds: DB subscription not active; grant blocked", {
      eventId,
      businessId,
      status: subRow.status
    });
    return;
  }

  let stripeSub: Stripe.Subscription;
  try {
    stripeSub = await getStripe().subscriptions.retrieve(subRow.stripe_subscription_id);
  } catch (err) {
    logger.error("voice_bonus_seconds: Stripe subscription retrieve failed", {
      eventId,
      businessId,
      subscriptionId: subRow.stripe_subscription_id,
      error: err instanceof Error ? err.message : String(err)
    });
    return;
  }

  const stripeStatus = stripeSub.status;
  if (stripeStatus !== "active" && stripeStatus !== "trialing") {
    logger.warn("voice_bonus_seconds: Stripe subscription not entitled; grant blocked", {
      eventId,
      businessId,
      stripeStatus
    });
    return;
  }

  const periodCache = stripeSubscriptionPeriodCache(stripeSub);
  const endIso =
    "stripe_current_period_end" in periodCache ? periodCache.stripe_current_period_end : undefined;
  if (!endIso) {
    logger.warn("voice_bonus_seconds: missing billing period end from Stripe subscription; grant blocked", {
      eventId,
      businessId
    });
    return;
  }

  const periodEnd = new Date(endIso);
  const createdSec =
    typeof session.created === "number" && Number.isFinite(session.created)
      ? session.created
      : Math.floor(Date.now() / 1000);
  const purchasedAt = new Date(createdSec * 1000);
  const plus30Ms = purchasedAt.getTime() + 30 * 24 * 60 * 60 * 1000;
  const expiresAt = periodEnd.getTime() >= plus30Ms ? periodEnd : new Date(plus30Ms);

  const { createSupabaseServiceClient } = await import("@/lib/supabase/server");
  const db = await createSupabaseServiceClient();
  const { data, error } = await db.rpc("apply_voice_bonus_grant_from_checkout", {
    p_business_id: businessId,
    p_checkout_session_id: session.id,
    p_seconds_purchased: seconds,
    p_expires_at: expiresAt.toISOString()
  });

  if (error) {
    logger.error("apply_voice_bonus_grant_from_checkout failed", {
      eventId,
      sessionId: session.id,
      businessId,
      error: error.message
    });
    return;
  }

  const payload = data as { ok?: boolean; reason?: string } | null;
  if (payload && payload.ok === false && payload.reason === "no_active_subscription") {
    logger.warn("voice_bonus_seconds: RPC rejected grant (subscription)", {
      eventId,
      sessionId: session.id,
      businessId
    });
    return;
  }

  logger.info("Voice bonus grant recorded", { eventId, sessionId: session.id, businessId, result: data });

  if (payload?.ok === true) {
    const { error: armErr } = await db.rpc("voice_sync_low_balance_alert_armed", {
      p_threshold_seconds: 300
    });
    if (armErr) {
      logger.warn("voice_sync_low_balance_alert_armed after bonus failed", {
        businessId,
        error: armErr.message
      });
    }
  }
}

function getInvoiceSubscriptionId(invoice: Stripe.Invoice): string | null {
  const subscription = invoice.parent?.subscription_details?.subscription;
  if (!subscription) return null;
  return typeof subscription === "string" ? subscription : subscription.id;
}
