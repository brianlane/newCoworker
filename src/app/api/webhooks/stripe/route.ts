import { after } from "next/server";
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
import {
  executeLifecyclePlan,
  executeLifecyclePlanFastPhase,
  executeLifecyclePlanSlowPhase
} from "@/lib/billing/lifecycle-executor";
import { loadLifecycleContextForBusiness } from "@/lib/billing/lifecycle-loader";
import {
  incrementLifetimeSubscriptionCount,
  markFirstPaidIfUnset,
  upsertCustomerProfile
} from "@/lib/db/customer-profiles";
import { setBusinessCustomerProfile } from "@/lib/db/businesses";
import {
  cancelStripeSubscriptionSafely,
  runChangePlanFromCheckout,
  runResubscribeFromCheckout
} from "@/lib/billing/change-plan-orchestrator";

// Vercel Pro allows up to 300s. Several dispatch paths below
// (`dispatchAutoCancelOnPaymentFailure`, `runChangePlanFromCheckout`,
// `runResubscribeFromCheckout`) schedule minutes-long SSH backup +
// Hostinger teardown / new-VM provisioning work via `after()`, and
// the runtime keeps the function alive only up to `maxDuration`. The
// Hobby tier's 10s default would tear the slow-phase work down almost
// immediately after the 200 ack — leaving Stripe acknowledged, the DB
// half-flipped, and the VM/billing dangling. (Mirrors the same
// reasoning used in `/api/billing/cancel`.)
export const maxDuration = 300;

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

/**
 * Activation-time variant of {@link fetchSubscriptionPeriodCacheOrEmpty}
 * that ALSO surfaces `cancel_at_period_end` from the live Stripe
 * subscription. Used by `activateCheckoutSession` to reconcile any
 * portal-driven state change that landed BEFORE we planted the row's
 * `stripe_subscription_id` linkage.
 *
 * Background: the `customer.subscription.created/updated` mirror in
 * this file deliberately skips rows with no local `stripe_subscription_id`
 * link (that linkage is only ever planted by `checkout.session.completed`
 * to avoid lifetime-cap bypasses on weak webhook ordering). That's
 * correct for the common case, BUT if a user opens the Stripe portal
 * during the activation race window and toggles "Cancel at period end",
 * the mirror skip would silently lose that flag. Once we land here in
 * `checkout.session.completed`, the linkage is finally being planted —
 * any `cancel_at_period_end` we read from Stripe at this moment IS the
 * authoritative current state, so we mirror it inline. We do NOT
 * mirror `status` here: that would tangle with the activation flow's
 * `firstActivation` accounting and is out of scope for this race.
 */
type StripeSubscriptionMirror = Partial<SubscriptionPeriodStripeCache> & {
  cancel_at_period_end?: boolean;
};

async function fetchStripeSubscriptionMirrorOrEmpty(
  subscriptionId: string,
  logMessage: string,
  logFields?: Record<string, unknown>
): Promise<StripeSubscriptionMirror> {
  try {
    const stripeSub = await getStripe().subscriptions.retrieve(subscriptionId);
    return {
      ...stripeSubscriptionPeriodCache(stripeSub),
      cancel_at_period_end: Boolean(stripeSub.cancel_at_period_end)
    };
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
        // Only mirror rows that are ALREADY linked to this Stripe
        // subscription id. `checkout.session.completed` is the single
        // authoritative site for planting the first linkage (because only
        // that handler has the checkout session metadata + email needed
        // to run the lifetime-cap increment idempotently). If
        // `customer.subscription.created` were allowed to adopt a pending
        // unlinked row and stamp `stripe_subscription_id` + flip status
        // to active here, Stripe's weak webhook ordering guarantees could
        // deliver this event before `checkout.session.completed`. The
        // later activation would then see `alreadyLinkedToThisStripeSub
        // === true` AND `status === "active"`, making `firstActivation`
        // false and silently skipping `incrementLifetimeSubscriptionCount`
        // — a lifetime-cap bypass under ordinary webhook delivery.
        //
        // Downside: if `checkout.session.completed` is genuinely lost
        // (not retried, not delivered), the mirror is a no-op and the
        // local row stays pending. Stripe guarantees delivery of
        // `checkout.session.completed` for successful Checkout sessions
        // (and we rely on that guarantee elsewhere), so this is the
        // strictly safer default.
        const existing = await getSubscriptionByStripeSubscriptionId(sub.id);
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
            // Schedule the autoCancel plan to run AFTER the 200 ack so we
            // don't exceed Stripe's ~30s webhook ack window (which would
            // trigger a retry and double-dispatch the plan). Must use
            // `after()` rather than a bare floating promise: on Vercel
            // serverless the function can be torn down shortly after the
            // response is returned, killing the multi-minute SSH backup
            // + Hostinger teardown mid-flight. `after()` (Vercel
            // `waitUntil` under the hood) keeps the runtime alive until
            // the callback resolves. The dispatcher already catches and
            // logs its own errors; the `try/catch` here is defensive in
            // case that contract regresses.
            const dispatchBusinessId = existing.business_id;
            const dispatchReason = `stripe_status:${sub.status}`;
            const dispatchEventId = event.id;
            after(async () => {
              try {
                await dispatchAutoCancelOnPaymentFailure({
                  businessId: dispatchBusinessId,
                  reason: dispatchReason,
                  eventId: dispatchEventId
                });
              } catch (err) {
                logger.error("autoCancelOnPaymentFailure dispatcher threw (background)", {
                  businessId: dispatchBusinessId,
                  eventId: dispatchEventId,
                  error: err instanceof Error ? err.message : String(err)
                });
              }
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

          // Period-end-reached promotion. Stripe's webhook ordering for a
          // `cancel_at_period_end=true` sub reaching its boundary is
          // weak: `customer.subscription.updated` (status=canceled) can
          // arrive BEFORE `customer.subscription.deleted`. If we just
          // mirrored `status=canceled` here without populating the grace
          // metadata, the subsequent `deleted` handler would re-load the
          // row with `status="canceled"`, fail
          // `planPeriodEndReached`'s `status !== "active"` precondition,
          // and skip the proper SSH backup + Hostinger snapshot/teardown
          // + cancel-confirmation email — deferring everything to the
          // 30-day grace-sweep backstop and losing the
          // `user_period_end` audit reason. Detect the period-end
          // signature here (active row, scheduled-cancel flag, Stripe
          // now reports canceled) and dispatch the proper
          // `periodEndReached` lifecycle plan instead. The later
          // `customer.subscription.deleted` handler already short-
          // circuits on rows whose grace metadata is already stamped
          // (the upgrade_switch + grace-deadline-already-set guards in
          // the fallback mirror), so dispatching here is safe.
          if (
            status === "canceled" &&
            existing.cancel_at_period_end &&
            existing.status === "active"
          ) {
            const ctxRes = await loadLifecycleContextForBusiness(existing.business_id, {
              subscription: existing
            });
            if (ctxRes.ok) {
              const planRes = planLifecycleAction({ type: "periodEndReached" }, ctxRes.context);
              if (planRes.ok) {
                // Split-phase: the fast phase (Stripe ops + DB updates
                // including status=canceled + grace_ends_at) runs inline
                // so the row reflects the cancellation by the time we
                // ack, but the slow phase (SSH backup + Hostinger
                // snapshot/stop/billing-cancel + cancel-confirmation
                // email) runs post-response via `after()`.
                //
                // CRITICAL: a synchronous `await executeLifecyclePlan`
                // here would routinely exceed Stripe's ~30s webhook ack
                // window on real tenants, causing Stripe to retry and
                // race a duplicate SSH backup + Hostinger snapshot
                // against the still-running first execution. The
                // neighbouring `dispatchAutoCancelOnPaymentFailure` path
                // already split-phases for this exact reason; the
                // `periodEndReached` path needs the same treatment. The
                // grace-sweep cron is the backstop if the slow phase
                // fails or the function is torn down before `after()`
                // completes.
                const periodEndPlan = planRes.plan;
                const periodEndExtra = {
                  businessId: existing.business_id,
                  vpsHost: ctxRes.vpsHost,
                  customerProfileId: ctxRes.context.subscription.customer_profile_id
                };
                const fastResult = await executeLifecyclePlanFastPhase(
                  periodEndPlan,
                  periodEndExtra
                );
                const dispatchBusinessId = existing.business_id;
                const dispatchSubscriptionRowId = existing.id;
                const dispatchStripeSubscriptionId = sub.id;
                const dispatchEventId = event.id;
                after(async () => {
                  try {
                    await executeLifecyclePlanSlowPhase(periodEndPlan, fastResult);
                    logger.info(
                      "customer.subscription.updated: periodEndReached slow phase complete",
                      {
                        businessId: dispatchBusinessId,
                        subscriptionRowId: dispatchSubscriptionRowId,
                        stripeSubscriptionId: dispatchStripeSubscriptionId,
                        eventId: dispatchEventId
                      }
                    );
                  } catch (err) {
                    logger.error(
                      "customer.subscription.updated: periodEndReached slow phase failed (background)",
                      {
                        businessId: dispatchBusinessId,
                        subscriptionRowId: dispatchSubscriptionRowId,
                        stripeSubscriptionId: dispatchStripeSubscriptionId,
                        eventId: dispatchEventId,
                        error: err instanceof Error ? err.message : String(err)
                      }
                    );
                  }
                });
                logger.info(
                  "customer.subscription.updated: ran periodEndReached fast phase on cancel transition; slow phase deferred",
                  {
                    businessId: existing.business_id,
                    subscriptionRowId: existing.id,
                    stripeSubscriptionId: sub.id,
                    eventId: event.id
                  }
                );
                break;
              }
              logger.warn("periodEndReached planner rejected on update; falling back to bare mirror", {
                businessId: existing.business_id,
                subscriptionRowId: existing.id,
                reason: planRes.reason,
                eventId: event.id
              });
            } else {
              logger.warn("periodEndReached context load failed on update; falling back to bare mirror", {
                businessId: existing.business_id,
                subscriptionRowId: existing.id,
                reason: ctxRes.reason,
                eventId: event.id
              });
            }
          }
          // Resurrection guard. Stripe can deliver `subscription.updated`
          // with `status="active"` for a row our lifecycle has already
          // moved into the canceled/grace state — typical sources:
          //   * Operator clicks "Resume subscription" in the Stripe
          //     dashboard (Stripe re-activates without dispatching a
          //     re-checkout, so we never run our resubscribe orchestrator
          //     and the local row keeps its grace metadata).
          //   * Schedule phase transition on a `cancel_at_period_end`
          //     sub that Stripe revs back to `active`.
          //   * Webhook reordering on retry windows.
          // Blindly mirroring `status="active"` here would leave the row
          // internally inconsistent (status=active alongside
          // grace_ends_at/canceled_at/cancel_reason) and make it
          // invisible to the grace-sweep cron, which filters on
          // `status === "canceled"`. Refuse the active-write and let
          // reactivation flow through `/api/billing/reactivate` instead.
          //
          // CRITICAL: do NOT spread `stripeSubscriptionPeriodCache(sub)`
          // here. The lifecycle planner and the
          // `customer.subscription.deleted` handler both explicitly null
          // `stripe_current_period_{start,end}` on cancel so the Edge
          // voice inbound's `cacheLooksValidForQuotaAfterJitFailure`
          // (supabase/functions/_shared/stripe_voice_period.ts) cannot
          // reserve minutes against a stale period after the
          // subscription is gone. Re-stamping live period bounds from a
          // resurrected-in-Stripe sub onto a canceled-in-grace row
          // would silently re-validate that JIT-fail proceed path —
          // voice usage on the still-running VPS during grace would be
          // billed against the supposedly-terminated subscription. We
          // still mirror `cancel_at_period_end` (UI-only, no quota
          // impact) and the Stripe sub id (no-op when already linked).
          if (status === "active" && existing.status === "canceled") {
            logger.warn(
              "customer.subscription.updated: refusing to resurrect canceled row to active without lifecycle reactivation",
              {
                businessId: existing.business_id,
                subscriptionRowId: existing.id,
                stripeSubscriptionId: sub.id,
                stripeStatus: sub.status,
                graceEndsAt: existing.grace_ends_at ?? null,
                wipedAt: existing.wiped_at ?? null,
                eventId: event.id
              }
            );
            await updateSubscription(existing.id, {
              stripe_subscription_id: sub.id,
              cancel_at_period_end: Boolean(sub.cancel_at_period_end)
            });
            break;
          }

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
                // Split-phase for the same reason as the parallel
                // `customer.subscription.updated` path: the slow ops
                // (SSH backup + Hostinger snapshot/stop/billing-cancel
                // + cancel-confirmation email) would exceed Stripe's
                // ~30s ack window if we awaited them synchronously,
                // making Stripe retry and race duplicate snapshots/
                // backups against the still-running first execution.
                // Run the fast phase (Stripe ops + DB updates that flip
                // status=canceled + stamp grace_ends_at) inline so the
                // row reflects cancellation immediately, then defer the
                // slow phase via `after()`. Backstop: the grace-sweep
                // cron picks up rows that ended up status=canceled +
                // grace-expired but still have data to wipe.
                const periodEndPlan = planRes.plan;
                const periodEndExtra = {
                  businessId,
                  vpsHost: ctxRes.vpsHost,
                  customerProfileId: ctxRes.context.subscription.customer_profile_id
                };
                const fastResult = await executeLifecyclePlanFastPhase(
                  periodEndPlan,
                  periodEndExtra
                );
                const dispatchBusinessId = businessId;
                const dispatchSubscriptionId = existing.id;
                const dispatchStripeSubscriptionId = sub.id;
                const dispatchEventId = event.id;
                after(async () => {
                  try {
                    await executeLifecyclePlanSlowPhase(periodEndPlan, fastResult);
                    logger.info(
                      "customer.subscription.deleted: periodEndReached slow phase complete",
                      {
                        businessId: dispatchBusinessId,
                        subscriptionId: dispatchSubscriptionId,
                        stripeSubscriptionId: dispatchStripeSubscriptionId,
                        eventId: dispatchEventId
                      }
                    );
                  } catch (err) {
                    logger.error(
                      "customer.subscription.deleted: periodEndReached slow phase failed (background)",
                      {
                        businessId: dispatchBusinessId,
                        subscriptionId: dispatchSubscriptionId,
                        stripeSubscriptionId: dispatchStripeSubscriptionId,
                        eventId: dispatchEventId,
                        error: err instanceof Error ? err.message : String(err)
                      }
                    );
                  }
                });
                logger.info(
                  "customer.subscription.deleted: ran periodEndReached fast phase; slow phase deferred",
                  {
                    businessId,
                    subscriptionId: existing.id,
                    stripeSubscriptionId: sub.id,
                    eventId: event.id
                  }
                );
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
          // Upgrade-switch old rows are finalized inline by
          // `runChangePlanFromCheckout` (status=canceled, cancel_reason=
          // upgrade_switch, periods nulled, cached_at stamped) *before*
          // the orchestrator calls `stripe.subscriptions.cancel()`.
          // Stripe then delivers `customer.subscription.deleted` to this
          // handler, and the fallback DB-mirror below would race with
          // the orchestrator's own final write, re-stamping
          // `stripe_subscription_cached_at` and potentially clobbering
          // state for an already-torn-down sub. Short-circuit on the
          // orchestrator's exact signature instead.
          if (
            existing.status === "canceled" &&
            existing.cancel_reason === "upgrade_switch"
          ) {
            logger.info(
              "customer.subscription.deleted: skipping fallback mirror for upgrade_switch (orchestrator finalized)",
              {
                businessId,
                subscriptionId: existing.id,
                stripeSubscriptionId: sub.id,
                eventId: event.id
              }
            );
            break;
          }
          // Stamp a grace deadline whenever we reach the fallback mirror
          // AND the row isn't already past the grace window (i.e.
          // wiped_at is null). Previously this gate was
          // `status !== "canceled"`, which missed the case where a prior
          // `customer.subscription.updated` had already mirrored
          // status=canceled (e.g. Stripe dunning → canceled → deleted)
          // and left `grace_ends_at` null. Without a deadline the
          // grace-sweep cron never picks the row up — SSH backup,
          // Hostinger snapshot, stop VM, and Hostinger billing cancel
          // are all silently skipped, leaving the VPS running and
          // Hostinger billing active indefinitely. The upgrade_switch
          // short-circuit above already handles the one case where
          // another orchestrator owns finalization, so from here we
          // unconditionally schedule a grace deadline unless one has
          // already been stamped or the row is already wiped.
          const graceEndsAt =
            existing.grace_ends_at ??
            (existing.wiped_at
              ? null
              : new Date(now.getTime() + GRACE_WINDOW_MS).toISOString());
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
        //  - `pending` subs (never activated) → leave UNTOUCHED. The PR
        //    design treats `pending → discard` as the correct semantic:
        //    the parallel `checkout.session.async_payment_failed` handler
        //    above intentionally takes no DB action and lets the
        //    abandoned-subs cleanup job prune the row + business.
        //    Flipping `status="canceled"` here would create a row whose
        //    appearance on the dashboard (PlanCard `status === "canceled"`
        //    branch) misleads a user who never actually had an active
        //    workspace into thinking they had service that was taken
        //    away. We emit a single info log so operators can still
        //    correlate failed-first-payment Stripe events to the row.
        //  - `canceled` / `canceled_in_grace` → ignore; this is likely the
        //    dunning tail for an already-canceled subscription and we've
        //    already run the teardown.
        if (existing.status === "active") {
          // Same `after()` wrapper as the `customer.subscription.updated`
          // dispatch above: must outlive the 200 ack on Vercel
          // serverless so the SSH backup + Hostinger teardown actually
          // get to run.
          const dispatchBusinessId = existing.business_id;
          const dispatchEventId = event.id;
          after(async () => {
            try {
              await dispatchAutoCancelOnPaymentFailure({
                businessId: dispatchBusinessId,
                reason: "invoice.payment_failed",
                eventId: dispatchEventId
              });
            } catch (err) {
              logger.error("autoCancelOnPaymentFailure dispatcher threw (background)", {
                businessId: dispatchBusinessId,
                eventId: dispatchEventId,
                error: err instanceof Error ? err.message : String(err)
              });
            }
          });
        } else if (existing.status === "pending") {
          // Match `checkout.session.async_payment_failed` above: leave
          // the pending row untouched and let the abandoned-subs
          // cleanup job prune it. Writing `status="canceled"` here
          // would surface a misleading "canceled" plan card on the
          // dashboard for a user whose workspace was never actually
          // provisioned.
          logger.info("invoice.payment_failed on pending subscription; leaving row untouched for abandoned-subs cleanup", {
            businessId: existing.business_id,
            subscriptionId: existing.id,
            eventId: event.id
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
 * Call sites invoke this WITHOUT `await` (fire-and-forget) because the
 * plan includes minutes-long SSH backup + Hostinger teardown that would
 * exceed Stripe's ~30s webhook ack window and trigger retries. This
 * function is explicitly designed to swallow all errors internally so a
 * background execution can never produce an unhandled promise rejection
 * from the webhook entrypoint.
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
  if (session.mode === "payment" && session.metadata?.checkoutKind === "sms_bonus_texts") {
    await applySmsBonusGrantFromCheckout(session, eventId);
    return;
  }
  if (session.mode === "payment" && session.metadata?.checkoutKind === "chat_credit_micros") {
    await applyChatCreditGrantFromCheckout(session, eventId);
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
    // Schedule the orchestrator to run AFTER the 200 ack. The flow is a
    // multi-minute pipeline (old-VM SSH backup + Hostinger snapshot +
    // new-VM provisioning + Cloudflare tunnel swing + SSH restore + old-
    // plan teardown) that routinely exceeds Stripe's ~30s webhook ack
    // window. Awaiting here would cause Stripe to time out and retry,
    // which would double-dispatch the orchestrator and potentially
    // double-provision + double-increment the lifetime-subscription
    // counter.
    //
    // CRITICAL: must be `after()` rather than a bare floating promise.
    // On Vercel serverless the function can be torn down shortly after
    // the 200 response is returned, killing the orchestrator mid-flight
    // (see the same comment block in `/api/billing/cancel`). `after()`
    // keeps the runtime alive (Vercel `waitUntil` under the hood) until
    // the orchestrator settles. The orchestrator is idempotent and
    // swallows its own errors per its docstring; this `try/catch` is
    // defensive in case that contract regresses.
    after(async () => {
      try {
        await runChangePlanFromCheckout(session, eventId);
      } catch (err) {
        logger.error("changePlan orchestrator failed (background)", {
          sessionId: session.id,
          eventId,
          error: err instanceof Error ? err.message : String(err)
        });
      }
    });
    return;
  }
  if (lifecycleAction === "resubscribe") {
    logger.info("checkout.session.completed: dispatching resubscribe orchestrator", {
      sessionId: session.id,
      businessId: session.metadata?.businessId,
      eventId
    });
    // Same `after()` wrapper as changePlan above: fresh VM provisioning
    // + SSH restore is minutes-long work that must (a) not block the
    // Stripe webhook ack, and (b) must outlive it on Vercel serverless
    // — a bare floating promise is NOT guaranteed to keep the function
    // alive past the response.
    after(async () => {
      try {
        await runResubscribeFromCheckout(session, eventId);
      } catch (err) {
        logger.error("resubscribe orchestrator failed (background)", {
          sessionId: session.id,
          eventId,
          error: err instanceof Error ? err.message : String(err)
        });
      }
    });
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
  // Pull period bounds AND `cancel_at_period_end` from the live Stripe
  // subscription so we can reconcile any portal toggle that landed
  // BEFORE this `checkout.session.completed` planted our local linkage.
  // The `customer.subscription.updated` mirror branch above intentionally
  // skips rows with no `stripe_subscription_id` link (that linkage is
  // only ever planted here, to avoid lifetime-cap bypasses on weak
  // webhook ordering); without this catch-up read, a customer who
  // immediately clicks "End at period end" through the portal during
  // the activation race would see no flag mirrored on their dashboard
  // until the next Stripe-driven event arrives.
  const stripeMirror = subscriptionId
    ? await fetchStripeSubscriptionMirrorOrEmpty(
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

  // Idempotency marker: once we've linked this DB row to *this* Stripe
  // subscription id, any Stripe webhook retry (e.g. a network glitch
  // between the increment and the final status flip causes Stripe to
  // re-deliver `checkout.session.completed`) must NOT re-increment the
  // lifetime count. A naive `existing.status !== "active"` guard would
  // re-enter this branch on every retry, burning multiple lifetimes off
  // the 3-count cap for a single real activation. We plant the linkage
  // BEFORE attempting the increment so a retry at any point after this
  // first write sees `alreadyLinked === true` and skips the increment.
  //
  // Trade-off: a crash *between* the linkage write and the increment RPC
  // (e.g. process kill exactly then) can leave the row linked but
  // uncounted, so a retry would also skip the increment and we under-
  // count by 1. That's acceptable because under-counting is permissive
  // (lets a legit user through), while over-counting is restrictive
  // (incorrectly blocks legit future subs) — and the atomic DB RPC is
  // still the last authority on concurrent checkouts at the cap.
  const alreadyLinkedToThisStripeSub =
    !!subscriptionId && existing.stripe_subscription_id === subscriptionId;
  const firstActivation = existing.status !== "active" && !alreadyLinkedToThisStripeSub;

  // Cap-bypass guard. If the row is already `active` and previously
  // linked to a *different* Stripe subscription id, then re-linking it
  // here (the unconditional update below) would attach a brand-new paid
  // Stripe sub to an existing local row WITHOUT consuming a lifetime
  // slot — `firstActivation` is false because the row is already
  // active, so the increment branch is skipped. This is the lifetime-
  // cap bypass that the screenshot bug report describes. Real
  // subscription transitions (changePlan / resubscribe) never reach
  // this default activation branch — they short-circuit at the
  // `lifecycleAction` dispatch above and run their own orchestrators
  // (which DO bump the lifetime counter). So an active row arriving
  // here with a fresh-and-different Stripe sub id is anomalous: a
  // crafted Stripe event, a desync, or an attacker trying to game the
  // cap. Refuse the relink and cancel the new Stripe sub so the
  // customer isn't auto-renewed for service we won't provision.
  if (
    existing.status === "active" &&
    !!subscriptionId &&
    !!existing.stripe_subscription_id &&
    existing.stripe_subscription_id !== subscriptionId
  ) {
    logger.error(
      "checkout activation refused: active row already linked to a different Stripe sub id",
      {
        businessId,
        eventId,
        subscriptionRowId: existing.id,
        existingStripeSubscriptionId: existing.stripe_subscription_id,
        incomingStripeSubscriptionId: subscriptionId
      }
    );
    await cancelStripeSubscriptionSafely(subscriptionId, businessId);
    return;
  }

  // Canceled-row resurrection guard. Must run BEFORE the linkage write
  // and the lifetime-count increment below, otherwise we silently relink
  // the canceled row to a fresh Stripe sub, burn a lifetime slot, and
  // (further down) flip `status` back to `active` while leaving
  // `grace_ends_at` / `wiped_at` / `cancel_at` / `cancel_reason` set —
  // a Frankenstein state that the grace-sweep cron can't see (it filters
  // `status="canceled"`) and that races a possibly-already-running wipe.
  //
  // Two shapes land here, both refused:
  //
  //   1. Webhook re-delivery on a row whose teardown already ran:
  //      `alreadyLinkedToThisStripeSub === true` AND status === "canceled".
  //      Stripe re-delivers `checkout.session.completed` on ack timeouts,
  //      manual replays, and periodic delivery sweeps; if a concurrent
  //      `customer.subscription.deleted` flipped the row to canceled
  //      between the original delivery and the retry, the retry must
  //      not unwind that. The Stripe sub is already canceled at Stripe's
  //      end (the deleted event is what flipped us), so we don't need
  //      to issue a teardown — silent bail is correct.
  //
  //   2. Fresh checkout against a previously-canceled row that did NOT
  //      go through `/api/billing/reactivate` (mode=resubscribe):
  //      `alreadyLinkedToThisStripeSub === false` AND status ===
  //      "canceled". The legitimate resubscribe path short-circuits at
  //      the `lifecycleAction === "resubscribe"` dispatch above and
  //      runs the resubscribe orchestrator (which restores the SSH
  //      backup, clears grace metadata, and bumps the lifetime counter
  //      on its own terms). Reaching this branch with a canceled row
  //      means a stale `/api/checkout` flow (old browser tab, scripted
  //      caller, lost lifecycleAction metadata). Refuse the activation
  //      and cancel the fresh Stripe sub so the customer isn't auto-
  //      renewed for service we won't provision; operators can issue
  //      a manual refund and route the customer through the proper
  //      reactivate flow.
  //
  // We MUST NOT bail when status is `pending`: that signals the prior
  // delivery linked the sub but crashed before the final flip, and
  // the retry's job is to complete that activation. We also intentionally
  // proceed when status is already `active` so a retry's redundant
  // status-flip write remains a no-op (an earlier idempotency test in
  // `tests/stripe-webhook-route.test.ts` documents this).
  if (existing.status === "canceled") {
    logger.warn(
      "checkout activation refused: local row is canceled; resubscribe must go through /api/billing/reactivate",
      {
        businessId,
        eventId,
        subscriptionRowId: existing.id,
        alreadyLinkedToThisStripeSub,
        existingStripeSubscriptionId: existing.stripe_subscription_id,
        incomingStripeSubscriptionId: subscriptionId,
        graceEndsAt: existing.grace_ends_at ?? null,
        wipedAt: existing.wiped_at ?? null
      }
    );
    if (subscriptionId && !alreadyLinkedToThisStripeSub) {
      await cancelStripeSubscriptionSafely(subscriptionId, businessId);
    }
    return;
  }

  if (!alreadyLinkedToThisStripeSub && subscriptionId) {
    // Same null-clobber defense as the second activation write below
    // (status="active" branch). Writing `stripe_customer_id: null` here
    // would orphan a valid customer linkage planted by a prior
    // `customer.subscription.created` mirror or earlier checkout retry
    // when a degenerate Stripe session arrives without a customer id
    // (retry races, mode=payment sessions that slipped past earlier
    // guards, etc.). The two activation writes must apply this guard
    // uniformly — otherwise the first write silently undoes the second
    // write's protection on rare-but-real null-customer payloads.
    await updateSubscription(existing.id, {
      ...(customerId ? { stripe_customer_id: customerId } : {}),
      stripe_subscription_id: subscriptionId,
      customer_profile_id: customerProfileId ?? existing.customer_profile_id,
      ...stripeMirror
    });
  }

  if (firstActivation && customerProfileId) {
    try {
      await incrementLifetimeSubscriptionCount(customerProfileId);
    } catch (err) {
      logger.warn("checkout activation blocked by lifetime count increment", {
        businessId,
        profileId: customerProfileId,
        error: err instanceof Error ? err.message : String(err)
      });
      // Cap-reached after Stripe already captured payment. Same policy as
      // the change-plan/resubscribe orchestrators: cancel the fresh Stripe
      // subscription so it doesn't auto-renew forever for a service we
      // committed to never provision. Refunds are left for operator
      // triage since this branch is rare (UI cap check narrows the race
      // upstream, but cannot close it).
      if (subscriptionId) {
        await cancelStripeSubscriptionSafely(subscriptionId, businessId);
      }
      return;
    }
  }

  // Do NOT unconditionally write `stripe_subscription_id` / `stripe_customer_id`
  // here: if a Stripe Checkout Session for some reason lacks a subscription or
  // customer id (retry races, unusual metadata states, a `mode=payment` session
  // that slipped past earlier guards), writing `null` would clobber the
  // linkage planted by the first `updateSubscription` above (or by a prior
  // `customer.subscription.created` mirror), orphaning a valid live Stripe
  // subscription from its local row. Only overwrite when we actually have
  // fresh values.
  await updateSubscription(existing.id, {
    status: "active",
    ...(customerId ? { stripe_customer_id: customerId } : {}),
    ...(subscriptionId ? { stripe_subscription_id: subscriptionId } : {}),
    customer_profile_id: customerProfileId ?? existing.customer_profile_id,
    ...stripeMirror
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

  // Skip when the owner has since opted into auto-renew: a late webhook
  // retry must not reinstate the month-to-month rollover schedule that
  // /api/billing/auto-renew deliberately released.
  if (subscriptionId && billingPeriod && tier !== "enterprise" && !existing.contract_auto_renew) {
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
      // `orchestrateProvisioning` already records a `failed` coworker_logs
      // row on uncaught errors so the dashboard flips into its terminal
      // failure state instead of sticking at 5%. The remaining job here
      // is to surface diagnostic detail (endpoint, status, body) into
      // Vercel logs — `err.message` alone strips the response body, and
      // the body is exactly where Hostinger puts the actionable error
      // copy (e.g. `[VPS:2000] Unauthorized` for a token missing scope).
      //
      // The detail extraction is duplicated from
      // `describeProvisioningError` rather than imported because some
      // tests mock the entire orchestrator module, which leaves the
      // helper undefined inside an async catch block. Keeping this
      // inline trades five lines of duplication for hermetic test
      // mocking — and the logic is small enough that drift is cheap.
      const detail = (() => {
        if (err instanceof Error && err.name === "HostingerApiError") {
          const e = err as Error & { endpoint?: unknown; status?: unknown; body?: unknown };
          return {
            message: err.message,
            endpoint: typeof e.endpoint === "string" ? e.endpoint : undefined,
            status: typeof e.status === "number" ? e.status : undefined,
            body: e.body
          };
        }
        if (err instanceof Error) return { message: err.message };
        return { message: String(err) };
      })();
      logger.error("Provisioning failed after checkout", {
        businessId,
        ...detail
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

/**
 * Bonus outbound texts from an SMS pack checkout. Same hardening contract as
 * `parseVoiceBonusSecondsFromMetadata`: digits only, hard upper bound (1M
 * texts ≫ the largest catalog pack), reject floats/scientific/hex.
 */
export function parseSmsBonusTextsFromMetadata(raw: unknown): number | null {
  if (raw === undefined || raw === null) return null;
  const str = String(raw).trim();
  if (!/^\d+$/.test(str)) return null;
  if (str.length > 7) return null;
  const n = Number(str);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return null;
  if (n <= 0) return null;
  const HARD_MAX_TEXTS = 1_000_000;
  if (n > HARD_MAX_TEXTS) return null;
  return n;
}

/**
 * Chat spend credit (micro-USD) from a Gemini pack checkout. Hard cap $1,000
 * of credit per checkout — far above the catalog — so a forged/corrupt
 * metadata value can never mint an unbounded cap raise.
 */
export function parseChatCreditMicrosFromMetadata(raw: unknown): number | null {
  if (raw === undefined || raw === null) return null;
  const str = String(raw).trim();
  if (!/^\d+$/.test(str)) return null;
  if (str.length > 10) return null;
  const n = Number(str);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return null;
  if (n <= 0) return null;
  const HARD_MAX_MICROS = 1_000_000_000;
  if (n > HARD_MAX_MICROS) return null;
  return n;
}

type UsagePackGrantSpec = {
  /** metadata checkoutKind, used as the log prefix. */
  kind: "sms_bonus_texts" | "chat_credit_micros";
  amount: number;
  rpcName: "apply_sms_bonus_grant_from_checkout" | "apply_chat_credit_grant_from_checkout";
  rpcAmountParam: "p_texts_purchased" | "p_credit_micros";
};

/**
 * Shared grant path for the SMS / chat-credit usage packs. Mirrors the voice
 * bonus entitlement chain: DB subscription must be active, the live Stripe
 * subscription must be active/trialing, and expiry is
 * `max(period_end, purchased_at + 30d)`. The RPC is idempotent on the
 * checkout session id, so webhook retries can't double-grant.
 */
async function applyUsagePackGrantFromCheckout(
  session: Stripe.Checkout.Session,
  eventId: string,
  spec: UsagePackGrantSpec
) {
  const businessId = session.metadata?.businessId?.trim();
  if (!businessId) {
    logger.warn(`${spec.kind} checkout missing businessId`, {
      eventId,
      sessionId: session.id
    });
    return;
  }

  const subRow = await getSubscription(businessId);
  if (!subRow?.stripe_subscription_id || subRow.status !== "active") {
    logger.warn(`${spec.kind}: no active subscription; grant blocked`, {
      eventId,
      businessId,
      status: subRow?.status ?? null
    });
    return;
  }

  let stripeSub: Stripe.Subscription;
  try {
    stripeSub = await getStripe().subscriptions.retrieve(subRow.stripe_subscription_id);
  } catch (err) {
    logger.error(`${spec.kind}: Stripe subscription retrieve failed`, {
      eventId,
      businessId,
      subscriptionId: subRow.stripe_subscription_id,
      error: err instanceof Error ? err.message : String(err)
    });
    return;
  }
  if (stripeSub.status !== "active" && stripeSub.status !== "trialing") {
    logger.warn(`${spec.kind}: Stripe subscription not entitled; grant blocked`, {
      eventId,
      businessId,
      stripeStatus: stripeSub.status
    });
    return;
  }

  const periodCache = stripeSubscriptionPeriodCache(stripeSub);
  const endIso =
    "stripe_current_period_end" in periodCache ? periodCache.stripe_current_period_end : undefined;
  if (!endIso) {
    logger.warn(`${spec.kind}: missing billing period end; grant blocked`, {
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
  const { data, error } = await db.rpc(spec.rpcName, {
    p_business_id: businessId,
    p_checkout_session_id: session.id,
    [spec.rpcAmountParam]: spec.amount,
    p_expires_at: expiresAt.toISOString()
  });

  if (error) {
    logger.error(`${spec.rpcName} failed`, {
      eventId,
      sessionId: session.id,
      businessId,
      error: error.message
    });
    return;
  }

  const payload = data as { ok?: boolean; reason?: string } | null;
  if (payload && payload.ok === false) {
    logger.warn(`${spec.kind}: RPC rejected grant`, {
      eventId,
      sessionId: session.id,
      businessId,
      reason: payload.reason ?? null
    });
    return;
  }

  logger.info("Usage pack grant recorded", {
    eventId,
    sessionId: session.id,
    businessId,
    kind: spec.kind,
    amount: spec.amount,
    result: data
  });
}

async function applySmsBonusGrantFromCheckout(session: Stripe.Checkout.Session, eventId: string) {
  const texts = parseSmsBonusTextsFromMetadata(session.metadata?.smsTexts ?? null);
  if (texts == null) {
    logger.warn("sms_bonus_texts checkout missing/invalid smsTexts", {
      eventId,
      sessionId: session.id,
      rawSmsTexts: session.metadata?.smsTexts ?? null
    });
    return;
  }
  await applyUsagePackGrantFromCheckout(session, eventId, {
    kind: "sms_bonus_texts",
    amount: texts,
    rpcName: "apply_sms_bonus_grant_from_checkout",
    rpcAmountParam: "p_texts_purchased"
  });
}

async function applyChatCreditGrantFromCheckout(session: Stripe.Checkout.Session, eventId: string) {
  const micros = parseChatCreditMicrosFromMetadata(session.metadata?.creditMicros ?? null);
  if (micros == null) {
    logger.warn("chat_credit_micros checkout missing/invalid creditMicros", {
      eventId,
      sessionId: session.id,
      rawCreditMicros: session.metadata?.creditMicros ?? null
    });
    return;
  }
  await applyUsagePackGrantFromCheckout(session, eventId, {
    kind: "chat_credit_micros",
    amount: micros,
    rpcName: "apply_chat_credit_grant_from_checkout",
    rpcAmountParam: "p_credit_micros"
  });
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

  // All three pack kinds (voice seconds, SMS texts, chat credit) share the
  // same clawback semantics: prorated reduce on partial refund, full void on
  // dispute-lost. Each kind voids through its own RPC.
  const packSessions = sessions.data.filter((s) => {
    const kind = s.metadata?.checkoutKind;
    return (
      kind === "voice_bonus_seconds" || kind === "sms_bonus_texts" || kind === "chat_credit_micros"
    );
  });
  if (packSessions.length === 0) {
    logger.debug("Refund not associated with a usage-pack Checkout; ignoring", {
      eventId: event.id,
      paymentIntentId
    });
    return;
  }

  const { createSupabaseServiceClient } = await import("@/lib/supabase/server");
  const db = await createSupabaseServiceClient();
  const reason = event.type.startsWith("charge.dispute.") ? "dispute" : "refund";

  for (const session of packSessions) {
    const kind = session.metadata?.checkoutKind;
    let rpcName:
      | "void_voice_bonus_grant_by_checkout_session"
      | "void_sms_bonus_grant_by_checkout_session"
      | "void_chat_credit_grant_by_checkout_session";
    let clawbackParam: "p_clawback_seconds" | "p_clawback_texts" | "p_clawback_micros";
    let purchased: number | null;
    if (kind === "sms_bonus_texts") {
      rpcName = "void_sms_bonus_grant_by_checkout_session";
      clawbackParam = "p_clawback_texts";
      purchased = parseSmsBonusTextsFromMetadata(session.metadata?.smsTexts ?? null);
    } else if (kind === "chat_credit_micros") {
      rpcName = "void_chat_credit_grant_by_checkout_session";
      clawbackParam = "p_clawback_micros";
      purchased = parseChatCreditMicrosFromMetadata(session.metadata?.creditMicros ?? null);
    } else {
      rpcName = "void_voice_bonus_grant_by_checkout_session";
      clawbackParam = "p_clawback_seconds";
      purchased = parseVoiceBonusSecondsFromMetadata(
        session.metadata?.voiceSeconds ?? session.metadata?.voice_seconds ?? null
      );
    }

    // Compute prorated clawback only for refunds: disputes still pass null (full void).
    let clawback: number | null = null;
    if (event.type === "charge.refunded") {
      clawback = computeVoiceBonusClawbackSeconds(originalAmount, refundedAmount, purchased);
    }

    const { data, error } = await db.rpc(rpcName, {
      p_checkout_session_id: session.id,
      p_reason: reason,
      [clawbackParam]: clawback
    });
    if (error) {
      logger.error(`${rpcName} failed`, {
        eventId: event.id,
        sessionId: session.id,
        error: error.message
      });
      continue;
    }
    logger.info("Usage pack grant voided", {
      eventId: event.id,
      sessionId: session.id,
      kind,
      reason,
      clawback,
      result: data
    });
  }
}

function getInvoiceSubscriptionId(invoice: Stripe.Invoice): string | null {
  const subscription = invoice.parent?.subscription_details?.subscription;
  if (!subscription) return null;
  return typeof subscription === "string" ? subscription : subscription.id;
}
