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

      case "customer.subscription.created":
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
              stripe_subscription_id: sub.id,
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
            // Clear cached Stripe billing-period bounds on cancel so the Edge voice
            // inbound cannot keep reserving minutes against a stale period after the
            // subscription is gone. Without this, `stripe_current_period_*` would
            // remain pointing at the final paid period indefinitely (cache looks valid
            // to `cacheLooksValidForQuotaAfterJitFailure` until `period_end` passes).
            await updateSubscription(existing.id, {
              status: "canceled",
              stripe_current_period_start: null,
              stripe_current_period_end: null,
              stripe_subscription_cached_at: new Date().toISOString()
            });
          }
        }
        break;
      }

      case "charge.refunded":
      case "charge.dispute.created":
      case "charge.dispute.closed": {
        await handleVoiceBonusRefund(event);
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

/**
 * Strict voice-seconds parser for Stripe metadata. Only accepts positive integer strings,
 * enforces an upper bound (~one year of call minutes), and refuses scientific notation,
 * floats, and leading-zero/negative/hex strings — all of which `Number.parseInt` silently
 * truncates or mis-parses, and which would otherwise mint a bogus bonus grant.
 */
export function parseVoiceBonusSecondsFromMetadata(raw: unknown): number | null {
  if (raw === undefined || raw === null) return null;
  const str = String(raw).trim();
  if (!/^\d+$/.test(str)) return null;
  if (str.length > 9) return null;
  const n = Number(str);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return null;
  if (n <= 0) return null;
  const HARD_MAX_SECONDS = 60 * 60 * 24 * 365;
  if (n > HARD_MAX_SECONDS) return null;
  return n;
}

/** A la carte voice seconds: Checkout Session payment mode + metadata (see .env.example). §4.1 */
async function applyVoiceBonusGrantFromCheckout(session: Stripe.Checkout.Session, eventId: string) {
  const businessId = session.metadata?.businessId?.trim();
  const rawSeconds =
    session.metadata?.voiceSeconds ?? session.metadata?.voice_seconds ?? null;
  const seconds = parseVoiceBonusSecondsFromMetadata(rawSeconds);

  if (!businessId || seconds == null) {
    logger.warn("voice_bonus_seconds checkout missing businessId or voiceSeconds", {
      eventId,
      sessionId: session.id,
      businessId: businessId ?? null,
      rawVoiceSeconds: rawSeconds ?? null
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
    // Scoped re-arm: only flip low_balance_alert_armed back on for THIS business.
    // The unscoped voice_sync_low_balance_alert_armed re-arms every row in the table,
    // which could unintentionally re-email other tenants who crossed the threshold and
    // whose included pool is still below it.
    const { error: armErr } = await db.rpc("voice_sync_low_balance_alert_armed_for_business", {
      p_business_id: businessId,
      p_threshold_seconds: 300
    });
    if (armErr) {
      logger.warn("voice_sync_low_balance_alert_armed_for_business after bonus failed", {
        businessId,
        error: armErr.message
      });
    }
  }
}

/**
 * Computes how many voice-bonus seconds should be clawed back from a Checkout Session's
 * grant given a Stripe refund/dispute amount.
 *
 * - `refundedAmount` / `originalAmount` are both in the smallest currency unit (cents).
 * - When we can't compute a ratio (missing/zero original amount), return `null` so the
 *   caller falls back to a full void — safer than miscomputing a partial clawback.
 * - Ratio is applied to `session.amount_total` if present (falls back to the grant's
 *   `seconds_purchased` in the RPC via `p_clawback_seconds=null` when both inputs are
 *   unavailable). Rounded to the nearest second; a full refund (amount_refunded ===
 *   original_amount) returns `null` to signal full void and avoid float rounding errors.
 */
export function computeVoiceBonusClawbackSeconds(
  originalAmount: number | null | undefined,
  refundedAmount: number | null | undefined,
  secondsPurchased: number | null | undefined
): number | null {
  if (!Number.isFinite(originalAmount) || !originalAmount || originalAmount <= 0) return null;
  if (!Number.isFinite(refundedAmount) || !refundedAmount || refundedAmount <= 0) return 0;
  if (!Number.isFinite(secondsPurchased) || !secondsPurchased || (secondsPurchased as number) <= 0) {
    return null;
  }
  const origAmt = originalAmount as number;
  const refAmt = refundedAmount as number;
  if (refAmt >= origAmt) return null;
  const ratio = refAmt / origAmt;
  const claw = Math.round((secondsPurchased as number) * ratio);
  if (!Number.isFinite(claw) || claw <= 0) return 0;
  return Math.min(claw, secondsPurchased as number);
}

/**
 * §4.1 clawback: when a bonus-seconds Checkout is refunded or disputed, reduce (or
 * void) the corresponding voice_bonus_grants row so remaining seconds cannot be
 * consumed. Looks up the Checkout Session via the payment intent on the charge.
 * Idempotent.
 *
 * Dispute semantics (important): `charge.dispute.created` gives the fastest clawback path
 * for the dashboard webhook configuration in v1, while `charge.dispute.closed` remains as
 * a backstop for existing endpoints that already emit it. `charge.dispute.closed` fires for
 * all terminal dispute statuses per Stripe — `lost`, `won`, and `warning_closed`. Only
 * `lost` actually moves funds back to the cardholder; `won` means the merchant
 * successfully defended the dispute and keeps the money, and `warning_closed` means an
 * early warning resolved without a chargeback. Voiding the grant for `won` /
 * `warning_closed` would revoke paid voice credits from a customer whose dispute the
 * merchant just defended.
 *
 * Partial refunds (§4.1 follow-up): for `charge.refunded` we now pass a prorated
 * `p_clawback_seconds` to the RPC so a partial refund reduces the grant proportionally
 * instead of voiding it fully. Dispute events still pass `null` (full void) because
 * Stripe disputes can reverse the full captured amount regardless of `dispute.amount`,
 * and the partial-dispute case is rare + ambiguous.
 */
async function handleVoiceBonusRefund(event: Stripe.Event): Promise<void> {
  const obj = event.data.object as Stripe.Charge | Stripe.Dispute;

  if (event.type === "charge.dispute.closed") {
    const dispute = obj as Stripe.Dispute;
    if (dispute.status !== "lost") {
      logger.info("Stripe dispute closed without chargeback; not voiding bonus grant", {
        eventId: event.id,
        disputeId: dispute.id,
        status: dispute.status
      });
      return;
    }
  }

  let refundedAmount: number | null = null;
  let originalAmount: number | null = null;
  if (event.type === "charge.refunded") {
    const charge = obj as Stripe.Charge;
    // Defensive: `charge.refunded` should always carry amount_refunded > 0, but a
    // zero-amount refund event (e.g. replayed/malformed) must not clawback a grant.
    if (!charge.amount_refunded || charge.amount_refunded <= 0) {
      logger.info("Stripe charge.refunded with no amount refunded; not voiding bonus grant", {
        eventId: event.id,
        chargeId: charge.id,
        amountRefunded: charge.amount_refunded ?? null
      });
      return;
    }
    refundedAmount = charge.amount_refunded ?? null;
    originalAmount =
      (typeof charge.amount_captured === "number" && charge.amount_captured > 0
        ? charge.amount_captured
        : null) ?? (typeof charge.amount === "number" && charge.amount > 0 ? charge.amount : null);
  }

  const paymentIntentId =
    typeof (obj as Stripe.Charge).payment_intent === "string"
      ? ((obj as Stripe.Charge).payment_intent as string)
      : (obj as Stripe.Dispute).payment_intent && typeof (obj as Stripe.Dispute).payment_intent === "string"
        ? ((obj as Stripe.Dispute).payment_intent as string)
        : null;

  if (!paymentIntentId) {
    logger.debug("Stripe refund/dispute event without payment_intent; ignoring", {
      type: event.type,
      eventId: event.id
    });
    return;
  }

  let sessions: Stripe.ApiList<Stripe.Checkout.Session>;
  try {
    sessions = await getStripe().checkout.sessions.list({
      payment_intent: paymentIntentId,
      limit: 5
    });
  } catch (err) {
    logger.error("Stripe checkout sessions list failed during refund handling", {
      eventId: event.id,
      paymentIntentId,
      error: err instanceof Error ? err.message : String(err)
    });
    return;
  }

  const voiceBonusSessions = sessions.data.filter(
    (s) => s.metadata?.checkoutKind === "voice_bonus_seconds"
  );
  if (voiceBonusSessions.length === 0) {
    logger.debug("Refund not associated with a voice_bonus_seconds Checkout; ignoring", {
      eventId: event.id,
      paymentIntentId
    });
    return;
  }

  const { createSupabaseServiceClient } = await import("@/lib/supabase/server");
  const db = await createSupabaseServiceClient();
  const reason = event.type.startsWith("charge.dispute.") ? "dispute" : "refund";

  for (const session of voiceBonusSessions) {
    // Compute prorated clawback only for refunds: disputes still pass null (full void).
    let clawbackSeconds: number | null = null;
    if (event.type === "charge.refunded") {
      const secondsPurchased = parseVoiceBonusSecondsFromMetadata(
        session.metadata?.voiceSeconds ?? session.metadata?.voice_seconds ?? null
      );
      clawbackSeconds = computeVoiceBonusClawbackSeconds(
        originalAmount,
        refundedAmount,
        secondsPurchased
      );
    }

    const { data, error } = await db.rpc("void_voice_bonus_grant_by_checkout_session", {
      p_checkout_session_id: session.id,
      p_reason: reason,
      p_clawback_seconds: clawbackSeconds
    });
    if (error) {
      logger.error("void_voice_bonus_grant_by_checkout_session failed", {
        eventId: event.id,
        sessionId: session.id,
        error: error.message
      });
      continue;
    }
    logger.info("Voice bonus grant voided", {
      eventId: event.id,
      sessionId: session.id,
      reason,
      clawbackSeconds,
      result: data
    });
  }
}

function getInvoiceSubscriptionId(invoice: Stripe.Invoice): string | null {
  const subscription = invoice.parent?.subscription_details?.subscription;
  if (!subscription) return null;
  return typeof subscription === "string" ? subscription : subscription.id;
}
