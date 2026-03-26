import { verifyWebhook } from "@/lib/stripe/client";
import { updateSubscription } from "@/lib/db/subscriptions";
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
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        const businessId = session.metadata?.businessId;
        const tier = (session.metadata?.tier ?? "starter") as "starter" | "standard" | "enterprise";

        if (businessId) {
          const customerId =
            typeof session.customer === "string" ? session.customer : session.customer?.id ?? null;
          const subscriptionId =
            typeof session.subscription === "string"
              ? session.subscription
              : session.subscription?.id ?? null;

          // Update subscription to active
          const { getSubscription } = await import("@/lib/db/subscriptions");
          const existing = await getSubscription(businessId);
          if (existing) {
            await updateSubscription(existing.id, {
              status: "active",
              stripe_customer_id: customerId,
              stripe_subscription_id: subscriptionId
            });
          }

          // Trigger provisioning asynchronously
          const { orchestrateProvisioning } = await import("@/lib/provisioning/orchestrate");
          orchestrateProvisioning({ businessId, tier }).catch((err) => {
            logger.error("Provisioning failed after checkout", {
              businessId,
              error: err instanceof Error ? err.message : String(err)
            });
          });
        }
        break;
      }

      case "customer.subscription.updated": {
        const sub = event.data.object as Stripe.Subscription;
        const businessId = sub.metadata?.businessId;
        if (businessId) {
          const { getSubscription } = await import("@/lib/db/subscriptions");
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
          const { getSubscription } = await import("@/lib/db/subscriptions");
          const existing = await getSubscription(businessId);
          if (existing) {
            await updateSubscription(existing.id, { status: "canceled" });
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
