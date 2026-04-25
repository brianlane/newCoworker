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
import { planLifecycleAction, GRACE_WINDOW_MS } from "@/lib/billing/lifecycle";
import { executeLifecyclePlan } from "@/lib/billing/lifecycle-executor";
import { loadLifecycleContextForBusiness } from "@/lib/billing/lifecycle-loader";
import {
  incrementLifetimeSubscriptionCount,
  markFirstPaidIfUnset,
  upsertCustomerProfile
} from "@/lib/db/customer-profiles";
import { setBusinessCustomerProfile } from "@/lib/db/businesses";
import {
  runChangePlanFromCheckout,
  runResubscribeFromCheckout
} from "@/lib/billing/change-plan-orchestrator";

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
        // Pending subs (never activated) are discarded on initial payment
        // failure — we never write `past_due` for new signups. The DB row
        // stays as `pending` with status unchanged; the abandoned-subs
        // cleanup job (existing) will prune it.
        const session = event.data.object as Stripe.Checkout.Session;
        const businessId = session.metadata?.businessId;
        logger.info("checkout.session.async_payment_failed: leaving pending row untouched", {
          businessId,
          sessionId: session.id
        });
        break;
      }

      case "customer.subscription.created":
      case "customer.subscription.updated": {
        const sub = event.data.object as Stripe.Subscription;
        const businessId = sub.metadata?.businessId;
        let existing = await getSubscriptionByStripeSubscriptionId(sub.id);
        if (!existing && event.type === "customer.subscription.created" && businessId) {
          const candidate = await getSubscription(businessId);
          existing = candidate && !candidate.stripe_subscription_id ? candidate : null;
        }
        if (existing) {
          if (businessId && existing.business_id !== businessId) {
            logger.warn("Stripe subscription metadata businessId mismatches local row", {
              stripeSubscriptionId: sub.id,
              metadataBusinessId: businessId,
              rowBusinessId: existing.business_id,
              eventId: event.id
            });
          }
          // Lifecycle rewrite: `past_due` / `unpaid` / `paused` are NOT
          // valid app states. When Stripe reports those we dispatch the
          // auto-cancel-on-payment-failure action, which walks the normal
          // cancel flow (backup, stop VM, cancel Hostinger billing, grace
          // window). For everything else we keep the existing status
          // mirror since it's already correct.
          const lifecycleCancelStatuses: ReadonlySet<Stripe.Subscription.Status> = new Set([
            "past_due",
            "unpaid",
            "paused"
          ]);
          if (lifecycleCancelStatuses.has(sub.status) && existing.status === "active") {
            await dispatchAutoCancelOnPaymentFailure({
              businessId: existing.business_id,
              reason: `stripe_status:${sub.status}`,
              eventId: event.id
            });
            break;
          }
          if (lifecycleCancelStatuses.has(sub.status)) {
            logger.info("Ignoring Stripe dunning status for non-active lifecycle row", {
              businessId: existing.business_id,
              stripeSubscriptionId: sub.id,
              stripeStatus: sub.status,
              dbStatus: existing.status,
              eventId: event.id
            });
            break;
          }

          type DbStatus = "active" | "canceled" | "pending";
          const statusMap: Record<string, DbStatus> = {
            active: "active",
            trialing: "active",
            canceled: "canceled",
            incomplete_expired: "canceled",
            incomplete: "pending"
          };
          const status: DbStatus = statusMap[sub.status] ?? "pending";
          // Mirror cancel_at_period_end so the dashboard reflects user
          // intent without polling Stripe on every render.
          await updateSubscription(existing.id, {
            status,
            stripe_subscription_id: sub.id,
            cancel_at_period_end: Boolean(sub.cancel_at_period_end),
            ...stripeSubscriptionPeriodCache(sub)
          });
        } else {
          logger.info("customer.subscription mirror skipped: no local subscription row for Stripe sub", {
            stripeSubscriptionId: sub.id,
            businessId: businessId ?? null,
            eventId: event.id
          });
        }
        break;
      }

      case "customer.subscription.deleted": {
        const sub = event.data.object as Stripe.Subscription;
        const existing = await getSubscriptionByStripeSubscriptionId(sub.id);
        if (existing) {
          const businessId = existing.business_id;
          const now = new Date();
          if (existing.cancel_at_period_end) {
            const ctxRes = await loadLifecycleContextForBusiness(businessId, {
              subscription: existing
            });
            if (ctxRes.ok) {
              const planRes = planLifecycleAction({ type: "periodEndReached" }, ctxRes.context);
              if (planRes.ok) {
                await executeLifecyclePlan(planRes.plan, {
                  businessId,
                  vpsHost: ctxRes.vpsHost,
                  customerProfileId: ctxRes.context.subscription.customer_profile_id
                });
                break;
              }
              logger.warn("periodEndReached planner rejected; falling back to DB mirror", {
                businessId,
                subscriptionId: existing.id,
                reason: planRes.reason,
                eventId: event.id
              });
            } else {
              logger.warn("periodEndReached context load failed; falling back to DB mirror", {
                businessId,
                subscriptionId: existing.id,
                reason: ctxRes.reason,
                eventId: event.id
              });
            }
          }
          const shouldStartGrace =
            existing.status !== "canceled" && existing.cancel_reason !== "upgrade_switch";
          const graceEndsAt =
            existing.grace_ends_at ??
            (shouldStartGrace ? new Date(now.getTime() + GRACE_WINDOW_MS).toISOString() : null);
          // Clear cached Stripe billing-period bounds on cancel so the
          // Edge voice inbound cannot keep reserving minutes against a
          // stale period after the subscription is gone. Pair with a
          // grace deadline so the wipe-sweep picks the row up.
          await updateSubscription(existing.id, {
            status: "canceled",
            stripe_current_period_start: null,
            stripe_current_period_end: null,
            stripe_subscription_cached_at: now.toISOString(),
            grace_ends_at: graceEndsAt,
            canceled_at: existing.canceled_at ?? now.toISOString(),
            cancel_reason: existing.cancel_reason,
            cancel_at_period_end: false
          });
        } else {
          logger.info("customer.subscription.deleted: no local subscription row for Stripe sub", {
            stripeSubscriptionId: sub.id,
            businessId: sub.metadata?.businessId ?? null,
            eventId: event.id
          });
        }
        break;
      }

      case "charge.refunded":
      case "charge.dispute.closed": {
        await handleVoiceBonusRefund(event);
        break;
      }

      case "charge.dispute.created": {
        // Observational only: do NOT clawback at dispute open. Stripe disputes
        // take days-to-weeks to resolve and can terminate as `won` or
        // `warning_closed`, both of which leave funds with the merchant. Since
        // we have no re-grant path for a subsequently-defended dispute, voiding
        // at open would permanently revoke paid voice seconds from customers
        // whose merchants successfully defend. `charge.dispute.closed` + status
        // == "lost" is the single authoritative clawback path; see
        // `handleVoiceBonusRefund`.
        const dispute = event.data.object as Stripe.Dispute;
        logger.info("Stripe dispute created; deferring clawback to dispute.closed/lost", {
          eventId: event.id,
          disputeId: dispute.id,
          chargeId: typeof dispute.charge === "string" ? dispute.charge : dispute.charge?.id,
          reason: dispute.reason,
          amount: dispute.amount
        });
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

            // Anchor the 30-day lifetime refund window on the very first
            // successful invoice for this customer_profile. Subsequent paid
            // invoices are no-ops because `markFirstPaidIfUnset` only writes
            // when the column is still NULL.
            if (existing.customer_profile_id) {
              try {
                await markFirstPaidIfUnset(existing.customer_profile_id, new Date());
              } catch (err) {
                logger.warn("markFirstPaidIfUnset failed on invoice.paid", {
                  subscriptionId: existing.id,
                  customerProfileId: existing.customer_profile_id,
                  error: err instanceof Error ? err.message : String(err)
                });
              }
            }
          }
        }
        break;
      }

      case "invoice.payment_failed": {
        const invoice = event.data.object as Stripe.Invoice;
        const subscriptionId = getInvoiceSubscriptionId(invoice);

        if (!subscriptionId) break;

        const existing = await getSubscriptionByStripeSubscriptionId(subscriptionId);
        if (!existing) break;

        // Lifecycle policy (blocker B2): there is no `past_due` state any more.
        //  - `active` subs → `autoCancelOnPaymentFailure` (backup, stop VM,
        //    cancel Hostinger billing, grace window, NO refund).
        //  - `pending` subs (never activated) → discarded; we drop the row
        //    so the abandoned-subs cleanup job can prune the business.
        //  - `canceled` / `canceled_in_grace` → ignore; this is likely the
        //    dunning tail for an already-canceled subscription and we've
        //    already run the teardown.
        if (existing.status === "active") {
          await dispatchAutoCancelOnPaymentFailure({
            businessId: existing.business_id,
            reason: "invoice.payment_failed",
            eventId: event.id
          });
        } else if (existing.status === "pending") {
          logger.info("invoice.payment_failed on pending subscription; discarding", {
            businessId: existing.business_id,
            subscriptionId: existing.id,
            eventId: event.id
          });
          await updateSubscription(existing.id, {
            status: "canceled",
            canceled_at: new Date().toISOString(),
            cancel_reason: "payment_failed"
          });
        } else {
          logger.debug("invoice.payment_failed on non-active subscription; ignoring", {
            businessId: existing.business_id,
            subscriptionId: existing.id,
            status: existing.status,
            eventId: event.id
          });
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

/**
 * Fire the lifecycle `autoCancelOnPaymentFailure` plan for a business. Used by
 * both `invoice.payment_failed` (dunning exhausted) and
 * `customer.subscription.updated` when Stripe moves the sub into a terminal
 * dunning state (`past_due`, `unpaid`, `paused`). Never refunds.
 *
 * Errors are logged but not thrown — webhook acknowledgement must stay 200 or
 * Stripe will retry, and by the time we get here the subscription is already
 * canceled on the Stripe side.
 */
async function dispatchAutoCancelOnPaymentFailure(params: {
  businessId: string;
  reason: string;
  eventId: string;
}): Promise<void> {
  const { businessId, reason, eventId } = params;
  try {
    const ctxRes = await loadLifecycleContextForBusiness(businessId);
    if (!ctxRes.ok) {
      logger.warn("autoCancelOnPaymentFailure: context load failed", {
        businessId,
        reason: ctxRes.reason,
        eventId
      });
      return;
    }
    const planRes = planLifecycleAction(
      { type: "autoCancelOnPaymentFailure" },
      ctxRes.context
    );
    if (!planRes.ok) {
      logger.info("autoCancelOnPaymentFailure: planner rejected (likely already canceled)", {
        businessId,
        reason: planRes.reason,
        eventId
      });
      return;
    }
    await executeLifecyclePlan(planRes.plan, {
      businessId,
      vpsHost: ctxRes.vpsHost,
      customerProfileId: ctxRes.context.subscription.customer_profile_id
    });
    logger.info("autoCancelOnPaymentFailure executed", { businessId, reason, eventId });
  } catch (err) {
    logger.error("autoCancelOnPaymentFailure execution failed", {
      businessId,
      reason,
      eventId,
      error: err instanceof Error ? err.message : String(err)
    });
  }
}

async function activateCheckoutSession(session: Stripe.Checkout.Session, eventId: string) {
  if (
    session.mode === "payment" &&
    session.metadata?.checkoutKind === "voice_bonus_seconds"
  ) {
    await applyVoiceBonusGrantFromCheckout(session, eventId);
    return;
  }

  // `changePlan` is a full-price fresh-checkout that goes through the
  // normal `mode: subscription` path but must NOT run the default
  // provisioning flow. Instead, it triggers the change-plan orchestrator
  // which handles: snapshot → backup old → provision new VM → SSH restore
  // → cancel old Stripe/Hostinger → mark old sub canceled. We early-return
  // after dispatching so the default path below doesn't double-provision.
  const lifecycleAction = session.metadata?.lifecycleAction;
  if (lifecycleAction === "changePlan") {
    logger.info("checkout.session.completed: dispatching changePlan orchestrator", {
      sessionId: session.id,
      businessId: session.metadata?.businessId,
      previousSubscriptionId: session.metadata?.previousSubscriptionId,
      eventId
    });
    try {
      await runChangePlanFromCheckout(session, eventId);
    } catch (err) {
      logger.error("changePlan orchestrator failed", {
        sessionId: session.id,
        eventId,
        error: err instanceof Error ? err.message : String(err)
      });
    }
    return;
  }
  if (lifecycleAction === "resubscribe") {
    logger.info("checkout.session.completed: dispatching resubscribe orchestrator", {
      sessionId: session.id,
      businessId: session.metadata?.businessId,
      eventId
    });
    try {
      await runResubscribeFromCheckout(session, eventId);
    } catch (err) {
      logger.error("resubscribe orchestrator failed", {
        sessionId: session.id,
        eventId,
        error: err instanceof Error ? err.message : String(err)
      });
    }
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

  // Abuse profile bookkeeping. Preferred source is the profile id tagged on
  // the Checkout Session at /api/checkout creation time; we also re-upsert
  // using the session's customer email + Stripe customer id so existing
  // profiles from a later login path get merged with any profile we had
  // only from email. Falls back to the existing subscription row's
  // customer_profile_id if metadata is missing (old checkouts).
  let customerProfileId: string | null =
    session.metadata?.customerProfileId ?? existing?.customer_profile_id ?? null;
  const sessionCustomerEmail =
    session.customer_details?.email ?? session.customer_email ?? null;
  if (sessionCustomerEmail) {
    try {
      customerProfileId = await upsertCustomerProfile({
        email: sessionCustomerEmail,
        stripeCustomerId: customerId,
        signupIp: null
      });
    } catch (err) {
      logger.warn("customer_profiles upsert failed in webhook activate", {
        businessId,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  if (!existing) {
    logger.warn("checkout activation skipped: no local subscription row found", {
      businessId,
      sessionId: session.id,
      eventId
    });
    return;
  }

  // Increment before activation/provisioning so the atomic DB cap is the last
  // authority under concurrent checkouts. If the profile is already capped,
  // we leave the pending row untouched for operator cleanup instead of
  // activating services beyond policy.
  const firstActivation = existing.status !== "active";
  if (customerProfileId && firstActivation) {
    try {
      await incrementLifetimeSubscriptionCount(customerProfileId);
    } catch (err) {
      logger.warn("checkout activation blocked by lifetime count increment", {
        businessId,
        profileId: customerProfileId,
        error: err instanceof Error ? err.message : String(err)
      });
      return;
    }
  }

  await updateSubscription(existing.id, {
    status: "active",
    stripe_customer_id: customerId,
    stripe_subscription_id: subscriptionId,
    customer_profile_id: customerProfileId ?? existing.customer_profile_id,
    ...periodCache
  });

  if (customerProfileId) {
    try {
      await setBusinessCustomerProfile(businessId, customerProfileId);
    } catch (err) {
      logger.warn("setBusinessCustomerProfile failed in webhook activate", {
        businessId,
        profileId: customerProfileId,
        error: err instanceof Error ? err.message : String(err)
      });
    }

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
  orchestrateProvisioning({ businessId, tier })
    .then(async (result) => {
      // Persist the Hostinger billing-subscription id so the lifecycle
      // engine can later cancel Hostinger billing (DELETE
      // /api/billing/v1/subscriptions/{id}) when the user cancels. Done on
      // success only — if provisioning failed we don't want to write a stale
      // id onto the row.
      if (!result.hostingerBillingSubscriptionId) return;
      try {
        const sub = await getSubscription(businessId);
        if (sub) {
          await updateSubscription(sub.id, {
            hostinger_billing_subscription_id: result.hostingerBillingSubscriptionId
          });
        }
      } catch (err) {
        logger.warn("Failed to persist hostinger_billing_subscription_id", {
          businessId,
          error: err instanceof Error ? err.message : String(err)
        });
      }
    })
    .catch((err) => {
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
 * Dispute semantics (important): only `charge.dispute.closed` with status `lost`
 * drives a clawback here. `charge.dispute.created` is observational (logged by the
 * dispatcher) and explicitly not routed into this function, because the dispute
 * outcome isn't known yet — Stripe disputes can close as `lost` (chargeback),
 * `won` (merchant defended), or `warning_closed` (early warning, no chargeback).
 * Only `lost` actually reverses funds; voiding grants on `created` and then
 * relying on `closed` as a "second void" would permanently revoke paid voice
 * credits from customers whose merchants successfully defended disputes, because
 * this handler has no compensating re-grant path for non-lost outcomes. The
 * merchant accepts the credit-exposure risk during the (typically 1–6 week)
 * dispute window in exchange for correctness on defended disputes.
 *
 * Partial refunds (§4.1 follow-up): for `charge.refunded` we pass a prorated
 * `p_clawback_seconds` to the RPC so a partial refund reduces the grant
 * proportionally instead of voiding it fully. `charge.dispute.closed`/lost
 * passes `null` (full void) because Stripe disputes reverse the full captured
 * amount regardless of `dispute.amount` in practice, and the partial-dispute
 * case is rare and ambiguous.
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
