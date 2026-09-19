/**
 * Stripe Customer Portal / Dashboard / API canceled a subscription without
 * going through `/api/billing/cancel`. The `customer.subscription.deleted`
 * fallback used to stamp grace with `cancel_reason` null and send no mail.
 *
 * This module is the honest recovery:
 *   * still-active row → `externalStripeCancel` lifecycle (skip Stripe cancel)
 *   * already-canceled, null reason → stamp `stripe_external` + owner/ops mail
 */

import { after as nextAfter } from "next/server";
import { logger } from "@/lib/logger";
import { sendOwnerEmail } from "@/lib/email/client";
import { sendOpsSubscriptionCanceledEmail } from "@/lib/email/ops-notify";
import { buildCancelConfirmationEmail } from "@/lib/email/templates/cancel-confirmation";
import { resolveOwnerUiLocaleForEmail } from "@/lib/i18n/owner-locale";
import { planLifecycleAction } from "@/lib/billing/lifecycle";
import {
  executeLifecyclePlanFastPhase,
  executeLifecyclePlanSlowPhase
} from "@/lib/billing/lifecycle-executor";
import { loadLifecycleContextForBusiness } from "@/lib/billing/lifecycle-loader";
import {
  getSubscriptionByStripeSubscriptionId,
  updateSubscription,
  type SubscriptionRow
} from "@/lib/db/subscriptions";
import { getBusiness } from "@/lib/db/businesses";
import { GRACE_WINDOW_MS } from "@/lib/billing/lifecycle";

export type ExternalCancelDispatch = "lifecycle" | "notify_only" | "skipped";

export function stripeCancellationDetailsLabel(sub: {
  cancellation_details?: {
    reason?: string | null;
    feedback?: string | null;
    comment?: string | null;
  } | null;
}): string | null {
  const details = sub.cancellation_details;
  if (!details) return null;
  const parts = [details.reason, details.feedback, details.comment]
    .map((p) => (typeof p === "string" ? p.trim() : ""))
    .filter((p) => p.length > 0);
  return parts.length > 0 ? parts.join(" / ") : null;
}

export async function dispatchExternalStripeCancel(args: {
  existing: SubscriptionRow;
  eventId: string;
  stripeSubscriptionId: string;
  cancellationDetails: string | null;
  now?: Date;
  after?: typeof nextAfter;
  /**
   * Re-read before deciding. `invoice.payment_failed` stamps
   * `cancel_reason=payment_failed` then Stripe-cancels; the resulting
   * `customer.subscription.deleted` often still holds a stale in-memory
   * row with a null reason. Without a fresh read we would overwrite
   * payment_failed with stripe_external (Scar Fairy, Sep 16 2026).
   */
  readLatest?: typeof getSubscriptionByStripeSubscriptionId;
}): Promise<ExternalCancelDispatch> {
  const { eventId, stripeSubscriptionId, cancellationDetails } = args;
  const now = args.now ?? new Date();
  const schedule = args.after ?? nextAfter;
  const readLatest = args.readLatest ?? getSubscriptionByStripeSubscriptionId;
  const latest = (await readLatest(stripeSubscriptionId)) ?? args.existing;
  const existing = latest;

  if (existing.cancel_reason != null && existing.cancel_reason !== "stripe_external") {
    return "skipped";
  }

  if (existing.status === "active") {
    const ctxRes = await loadLifecycleContextForBusiness(existing.business_id, {
      subscription: existing
    });
    if (ctxRes?.ok) {
      const planRes = planLifecycleAction(
        {
          type: "externalStripeCancel",
          stripeCancellationDetails: cancellationDetails
        },
        ctxRes.context
      );
      if (planRes.ok) {
        const extra = {
          businessId: existing.business_id,
          vpsHost: ctxRes.vpsHost,
          customerProfileId: ctxRes.context.subscription.customer_profile_id
        };
        const fastResult = await executeLifecyclePlanFastPhase(planRes.plan, extra);
        const dispatchBusinessId = existing.business_id;
        const dispatchSubscriptionId = existing.id;
        schedule(async () => {
          try {
            await executeLifecyclePlanSlowPhase(planRes.plan, fastResult);
            logger.info("externalStripeCancel slow phase complete", {
              businessId: dispatchBusinessId,
              subscriptionId: dispatchSubscriptionId,
              stripeSubscriptionId,
              eventId
            });
          } catch (err) {
            logger.error("externalStripeCancel slow phase failed (background)", {
              businessId: dispatchBusinessId,
              subscriptionId: dispatchSubscriptionId,
              stripeSubscriptionId,
              eventId,
              error: err instanceof Error ? err.message : String(err)
            });
          }
        });
        logger.info("externalStripeCancel fast phase ran; slow phase deferred", {
          businessId: existing.business_id,
          subscriptionId: existing.id,
          stripeSubscriptionId,
          eventId
        });
        return "lifecycle";
      }
      logger.warn("externalStripeCancel planner rejected; falling back to notify-only", {
        businessId: existing.business_id,
        subscriptionId: existing.id,
        reason: planRes.reason,
        eventId
      });
    } else {
      logger.warn("externalStripeCancel context load failed; falling back to notify-only", {
        businessId: existing.business_id,
        subscriptionId: existing.id,
        reason: ctxRes?.reason ?? "context_unavailable",
        eventId
      });
    }
  }

  if (existing.cancel_reason === "stripe_external") {
    return "skipped";
  }

  const graceEndsAt =
    existing.grace_ends_at ??
    (existing.wiped_at ? null : new Date(now.getTime() + GRACE_WINDOW_MS).toISOString());
  await updateSubscription(existing.id, {
    status: "canceled",
    stripe_current_period_start: null,
    stripe_current_period_end: null,
    stripe_subscription_cached_at: now.toISOString(),
    grace_ends_at: graceEndsAt,
    canceled_at: existing.canceled_at ?? now.toISOString(),
    cancel_reason: "stripe_external",
    cancel_at_period_end: false
  });
  await notifyExternalCancelEmails({
    existing: { ...existing, cancel_reason: "stripe_external", grace_ends_at: graceEndsAt },
    cancellationDetails,
    now
  });
  return "notify_only";
}

async function notifyExternalCancelEmails(args: {
  existing: SubscriptionRow;
  cancellationDetails: string | null;
  now: Date;
}): Promise<void> {
  const { existing, cancellationDetails, now } = args;
  const business = await getBusiness(existing.business_id);
  const ownerEmail = business?.owner_email ?? "";
  const siteUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "[REDACTED]").replace(/\/$/, "");
  const apiKey = process.env.RESEND_API_KEY;
  if (apiKey && ownerEmail) {
    try {
      const { subject, text, html } = buildCancelConfirmationEmail({
        reason: "stripe_external",
        effectiveAt: existing.canceled_at ?? now.toISOString(),
        graceEndsAt: existing.grace_ends_at,
        recipientEmail: ownerEmail,
        siteUrl,
        currentTier: existing.tier,
        hostingerExpiresAt: null,
        nowMs: now.getTime(),
        locale: await resolveOwnerUiLocaleForEmail(ownerEmail),
        ...(business?.timezone ? { timeZone: business.timezone } : {})
      });
      await sendOwnerEmail(apiKey, ownerEmail, subject, { text, html });
    } catch (err) {
      logger.warn("owner cancel-confirmation email failed on stripe_external notify-only", {
        businessId: existing.business_id,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  } else if (!apiKey) {
    logger.warn("owner cancel-confirmation skipped on stripe_external: RESEND_API_KEY missing", {
      businessId: existing.business_id
    });
  }
  await sendOpsSubscriptionCanceledEmail({
    businessId: existing.business_id,
    businessName: business?.name ?? "",
    ownerName: business?.owner_name ?? null,
    ownerEmail: ownerEmail || "(none on file)",
    tier: existing.tier,
    cancelReason: "stripe_external",
    cancelPath: "stripe_external",
    graceEndsAt: existing.grace_ends_at,
    hostingerExpiresAt: null,
    stripeCancellationDetails: cancellationDetails
  });
}
