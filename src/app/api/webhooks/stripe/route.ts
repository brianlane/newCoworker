import { ensureCommitmentSchedule, verifyWebhook } from "@/lib/stripe/client";
import { getSubscription, getSubscriptionByStripeSubscriptionId, updateSubscription } from "@/lib/db/subscriptions";
import { successResponse, errorResponse } from "@/lib/api-response";
import { logger } from "@/lib/logger";
import type Stripe from "stripe";

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
            await updateSubscription(existing.id, { status });
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
            await updateSubscription(existing.id, { status: "active" });
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
            await updateSubscription(existing.id, { status: "past_due" });
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
  if (existing) {
    await updateSubscription(existing.id, {
      status: "active",
      stripe_customer_id: customerId,
      stripe_subscription_id: subscriptionId
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

function getInvoiceSubscriptionId(invoice: Stripe.Invoice): string | null {
  const subscription = invoice.parent?.subscription_details?.subscription;
  if (!subscription) return null;
  return typeof subscription === "string" ? subscription : subscription.id;
}
