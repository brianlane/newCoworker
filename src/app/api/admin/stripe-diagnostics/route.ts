/**
 * Admin: one-call raw-Stripe view for a tenant (BizBlasts
 * `stripe_diagnostics` analog) — the customer, live subscription (+ any
 * commitment schedule), and recent invoices as Stripe reports them, so
 * billing investigations don't require hopping to the Stripe dashboard and
 * cross-referencing ids by hand.
 */
import { z } from "zod";
import Stripe from "stripe";
import { requireAdmin } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { getSubscription, stripeSubscriptionPeriodCache } from "@/lib/db/subscriptions";
import { getStripe } from "@/lib/stripe/client";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function centsToUsd(amount: number | null | undefined): string | null {
  if (typeof amount !== "number") return null;
  return `$${(amount / 100).toFixed(2)}`;
}

function isoFromUnix(seconds: number | null | undefined): string | null {
  if (typeof seconds !== "number") return null;
  return new Date(seconds * 1000).toISOString();
}

export async function GET(request: Request) {
  try {
    await requireAdmin();
    const url = new URL(request.url);
    const parsed = z.string().uuid().safeParse(url.searchParams.get("businessId"));
    if (!parsed.success) return errorResponse("VALIDATION_ERROR", "businessId is required");
    const businessId = parsed.data;

    const row = await getSubscription(businessId);
    if (!row) {
      return successResponse({
        dbSubscription: null,
        customer: null,
        subscription: null,
        schedule: null,
        invoices: []
      });
    }

    const stripe = getStripe();

    let customer: Record<string, unknown> | null = null;
    if (row.stripe_customer_id) {
      try {
        const c = await stripe.customers.retrieve(row.stripe_customer_id);
        if (!("deleted" in c && c.deleted)) {
          const cust = c as Stripe.Customer;
          customer = {
            id: cust.id,
            email: cust.email,
            name: cust.name,
            created: isoFromUnix(cust.created),
            delinquent: cust.delinquent ?? null,
            currency: cust.currency ?? null
          };
        } else {
          customer = { id: row.stripe_customer_id, deleted: true };
        }
      } catch (err) {
        customer = {
          id: row.stripe_customer_id,
          error: err instanceof Error ? err.message : String(err)
        };
      }
    }

    let subscription: Record<string, unknown> | null = null;
    let schedule: Record<string, unknown> | null = null;
    let scheduleId: string | null = null;
    if (row.stripe_subscription_id) {
      try {
        const sub = await stripe.subscriptions.retrieve(row.stripe_subscription_id);
        // Same period resolution the billing cache uses: handles legacy
        // top-level period fields AND basil-era per-item periods aggregated
        // across every item — first-item-only can be blank or wrong.
        const period = stripeSubscriptionPeriodCache(sub);
        subscription = {
          id: sub.id,
          status: sub.status,
          cancelAtPeriodEnd: sub.cancel_at_period_end,
          currentPeriodStart:
            "stripe_current_period_start" in period ? period.stripe_current_period_start : null,
          currentPeriodEnd:
            "stripe_current_period_end" in period ? period.stripe_current_period_end : null,
          items: sub.items.data.map((item) => ({
            priceId: item.price.id,
            nickname: item.price.nickname ?? null,
            amount: centsToUsd(item.price.unit_amount),
            interval: item.price.recurring
              ? `${item.price.recurring.interval_count ?? 1} ${item.price.recurring.interval}`
              : null,
            quantity: item.quantity ?? 1
          }))
        };
        scheduleId = typeof sub.schedule === "string" ? sub.schedule : sub.schedule?.id ?? null;
      } catch (err) {
        subscription = {
          id: row.stripe_subscription_id,
          error: err instanceof Error ? err.message : String(err)
        };
      }
    }
    // Separate try/catch: a schedule-retrieve failure must not clobber the
    // subscription payload that already loaded successfully.
    if (scheduleId) {
      try {
        const sched = await stripe.subscriptionSchedules.retrieve(scheduleId);
        schedule = {
          id: sched.id,
          status: sched.status,
          endBehavior: sched.end_behavior,
          phases: sched.phases.map((phase) => ({
            start: isoFromUnix(phase.start_date),
            end: isoFromUnix(phase.end_date),
            prices: phase.items.map((item) =>
              typeof item.price === "string" ? item.price : item.price.id
            )
          }))
        };
      } catch (err) {
        schedule = {
          id: scheduleId,
          error: err instanceof Error ? err.message : String(err)
        };
      }
    }

    let invoices: Array<Record<string, unknown>> = [];
    if (row.stripe_customer_id) {
      try {
        const list = await stripe.invoices.list({
          customer: row.stripe_customer_id,
          limit: 5
        });
        invoices = list.data.map((inv) => ({
          id: inv.id,
          status: inv.status,
          total: centsToUsd(inv.total),
          amountPaid: centsToUsd(inv.amount_paid),
          created: isoFromUnix(inv.created),
          hostedInvoiceUrl: inv.hosted_invoice_url ?? null
        }));
      } catch (err) {
        logger.warn("admin.stripe-diagnostics: invoice list failed", {
          businessId,
          error: err instanceof Error ? err.message : String(err)
        });
      }
    }

    return successResponse({
      dbSubscription: {
        status: row.status,
        billingPeriod: row.billing_period ?? null,
        stripeCustomerId: row.stripe_customer_id ?? null,
        stripeSubscriptionId: row.stripe_subscription_id ?? null,
        renewalAt: row.renewal_at ?? null,
        graceEndsAt: row.grace_ends_at ?? null,
        wipedAt: row.wiped_at ?? null
      },
      customer,
      subscription,
      schedule,
      invoices
    });
  } catch (err) {
    return handleRouteError(err);
  }
}
