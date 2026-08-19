import { after } from "next/server";
import { ensureCommitmentSchedule, getStripe, verifyWebhook } from "@/lib/stripe/client";
import {
  createSubscription,
  getSubscription,
  getSubscriptionByStripeSubscriptionId,
  stripeSubscriptionPeriodCache,
  updateSubscription,
  type SubscriptionPeriodStripeCache
} from "@/lib/db/subscriptions";
import { recordPromotionRedemption } from "@/lib/db/promotions";
import { successResponse, errorResponse } from "@/lib/api-response";
import { membershipPackAddonsForRow } from "@/lib/billing/membership-pack-addons";
import { logger } from "@/lib/logger";
import type Stripe from "stripe";
import {
  planLifecycleAction,
  planEnableHostingerAutoRenewOps,
  GRACE_WINDOW_MS
} from "@/lib/billing/lifecycle";
import {
  executeLifecyclePlan,
  executeLifecyclePlanFastPhase,
  executeLifecyclePlanSlowPhase
} from "@/lib/billing/lifecycle-executor";
import { loadLifecycleContextForBusiness } from "@/lib/billing/lifecycle-loader";
import { pauseStateFromStripeSubscription } from "@/lib/billing/admin-billing-controls";
import {
  incrementLifetimeSubscriptionCount,
  markFirstPaidIfUnset,
  upsertCustomerProfile
} from "@/lib/db/customer-profiles";
import { getBusiness, recordWhiteGlovePurchase, setBusinessCustomerProfile, updateBusinessOwnerEmailIfPending } from "@/lib/db/businesses";
import {
  getWhiteGloveOffer,
  markWhiteGloveOfferPaid,
  extendPrioritySupport,
  attachPaidProspectOfferToBusinessByEmail
} from "@/lib/db/white-glove-offers";
import {
  getWhiteGloveBookingUrl,
  getWhiteGlovePackage,
  prioritySupportUntil
} from "@/lib/plans/white-glove";
import {
  getEnterpriseDeal,
  markEnterpriseDealActive,
  markEnterpriseDealCanceledByStripeSubscriptionId
} from "@/lib/db/enterprise-deals";
import { buildWhiteGloveConfirmationEmail } from "@/lib/email/templates/white-glove-confirmation";
import { resolveOwnerUiLocaleForEmail } from "@/lib/i18n/owner-locale";
import { sendOwnerEmail } from "@/lib/email/client";
import {
  parseChatCreditMicrosFromMetadata,
  parseSmsBonusTextsFromMetadata,
  parseVoiceBonusSecondsFromMetadata
} from "@/lib/billing/usage-pack-metadata";
import {
  cancelStripeSubscriptionSafely,
  runChangePlanFromCheckout,
  runResubscribeFromCheckout
} from "@/lib/billing/change-plan-orchestrator";
import { PRIORITY_SUPPORT_CHECKOUT_KIND } from "@/lib/plans/priority-support";
import { isUpgradeSwitchDeletion } from "@/lib/billing/upgrade-switch";
import {
  applyPrioritySupportInvoicePaid,
  isPrioritySupportSubscription,
  prioritySupportPeriodEnd,
  recordPrioritySupportCheckout,
  terminatePrioritySupport
} from "@/lib/billing/priority-support";
import {
  markPrioritySupportSubscriptionCanceled,
  mirrorPrioritySupportSubscription
} from "@/lib/db/priority-support";

// Vercel Pro allows up to 800s, take all of it. Several dispatch paths
// below (`dispatchAutoCancelOnPaymentFailure`, `runChangePlanFromCheckout`,
// `runResubscribeFromCheckout`, and the signup provisioning orchestrator)
// schedule minutes-long SSH backup + Hostinger teardown / new-VM
// provisioning work via `after()`, and the runtime keeps the function
// alive only up to `maxDuration`. The previous 300s ceiling killed two
// real signups mid-provision (Truly Insurance Jul 8 2026, KYP Ads Jul 14
// 2026): an adopt/purchase provision runs ~8-12 minutes, and the runtime
// tore it down at 5 minutes with no error row. 800s covers the observed
// worst case; the provisioning-watchdog cron is the backstop for anything
// that still dies (see src/lib/provisioning/jobs.ts).
export const maxDuration = 1800;

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
 * `checkout.session.completed`, the linkage is finally being planted,
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
        // failure, we never write `past_due` for new signups. The DB row
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

        // The priority support add-on has its own mirror table. It is NOT in
        // `subscriptions`, so the membership mirror below would simply no-op
        // on it; this branch keeps its own row current instead (renewal dates,
        // and the cancel_at_period_end that drives "renewing" vs "ends on").
        if (isPrioritySupportSubscription(sub)) {
          try {
            await mirrorPrioritySupportSubscription(sub.id, {
              status:
                sub.status === "canceled"
                  ? "canceled"
                  : sub.cancel_at_period_end
                    ? "canceling"
                    : "active",
              currentPeriodEnd: prioritySupportPeriodEnd(sub),
              cancelAtPeriodEnd: Boolean(sub.cancel_at_period_end)
            });
          } catch (err) {
            logger.warn("priority_support: subscription mirror failed (non-fatal)", {
              eventId: event.id,
              stripeSubscriptionId: sub.id,
              error: err instanceof Error ? err.message : String(err)
            });
          }
          break;
        }

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
        // false and silently skipping `incrementLifetimeSubscriptionCount`,
        // a lifetime-cap bypass under ordinary webhook delivery.
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
          // + cancel-confirmation email, deferring everything to the
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
          // moved into the canceled/grace state, typical sources:
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
          // would silently re-validate that JIT-fail proceed path,
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
          // intent without polling Stripe on every render. The pause state
          // rides along for the same reason, and so an auto-resume Stripe
          // performs on its own (pause_collection.resumes_at elapsing) is
          // reflected without an operator touching the admin page.
          const wasCancelling =
            (existing as { cancel_at_period_end?: boolean | null }).cancel_at_period_end === true;
          await updateSubscription(existing.id, {
            status,
            stripe_subscription_id: sub.id,
            cancel_at_period_end: Boolean(sub.cancel_at_period_end),
            // Mirror the recurring pack add-ons so the dashboard can render
            // what the tenant already carries without a Stripe call. This is
            // the one write that runs on signup activation, on change-plan
            // (which creates a new subscription), and on any Stripe-side
            // edit, so the cache cannot drift for long.
            membership_pack_addons: membershipPackAddonsForRow(sub.metadata),
            ...pauseStateFromStripeSubscription(sub),
            ...stripeSubscriptionPeriodCache(sub)
          });

          // Undo-cancel through the Stripe customer portal lands here rather
          // than on /api/billing/reactivate, which re-enables Hostinger
          // auto-renew as part of its undoPeriodEnd plan. Mirroring the flag
          // alone left the box with renewal OFF, and billing-posture excludes
          // cancel_at_period_end tenants from its heal, so it only recovered
          // on the next daily run: a customer who undoes on their Hostinger
          // renewal day could lose the box.
          //
          // Hostinger ops only. Stripe and the DB are already where they need
          // to be (the portal did the former, the mirror above the latter), and
          // planning through planLifecycleAction keeps the never_renew and
          // non-Hostinger-provider guards rather than re-deriving them here.
          if (wasCancelling && !sub.cancel_at_period_end) {
            after(async () => {
              try {
                const ctxRes = await loadLifecycleContextForBusiness(existing.business_id);
                if (!ctxRes.ok) return;
                // Deliberately NOT planLifecycleAction("undoPeriodEnd"): the
                // mirror above already cleared cancel_at_period_end, and that
                // planner refuses once the flag is false, so it would silently
                // no-op here. The shared helper is the same guard body it uses.
                const hostingerOps = planEnableHostingerAutoRenewOps(ctxRes.context);
                if (hostingerOps.length === 0) return;
                await executeLifecyclePlan(
                  {
                    stripeOps: [],
                    dbUpdates: [],
                    sshOps: [],
                    telnyxOps: [],
                    emailsToSend: [],
                    hostingerOps
                  },
                  {
                    businessId: existing.business_id,
                    vpsHost: ctxRes.vpsHost,
                    customerProfileId: ctxRes.context.subscription.customer_profile_id
                  }
                );
              } catch (err) {
                // Best-effort: the daily billing-posture heal is still the
                // backstop, this just closes the up-to-24h window.
                logger.warn("portal undo-cancel: Hostinger auto-renew re-enable failed", {
                  businessId: existing.business_id,
                  eventId: event.id,
                  error: err instanceof Error ? err.message : String(err)
                });
              }
            });
          }
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

        // The priority support add-on is its own subscription. Its deletion is
        // NOT a tenant teardown: mark the mirror row and stop, so none of the
        // membership lifecycle below (auto-reload disable, grace window, VM
        // stop) fires for what is only an add-on ending.
        if (isPrioritySupportSubscription(sub)) {
          try {
            await markPrioritySupportSubscriptionCanceled(sub.id, new Date());
            logger.info("priority_support: subscription deleted", {
              eventId: event.id,
              stripeSubscriptionId: sub.id,
              businessId: sub.metadata?.businessId ?? null
            });
          } catch (err) {
            logger.warn("priority_support: cancel mirror failed (non-fatal)", {
              eventId: event.id,
              stripeSubscriptionId: sub.id,
              error: err instanceof Error ? err.message : String(err)
            });
          }
          break;
        }

        // Enterprise-deal bookkeeping: flip the deal row to 'canceled' so the
        // one-live-deal-per-business slot frees up for a future re-deal.
        // Best-effort, the subscription lifecycle below is the authority.
        try {
          const dealCanceled = await markEnterpriseDealCanceledByStripeSubscriptionId(sub.id);
          if (dealCanceled) {
            logger.info("Enterprise deal marked canceled on subscription deletion", {
              stripeSubscriptionId: sub.id,
              eventId: event.id
            });
          }
        } catch (err) {
          logger.warn("Enterprise deal cancel mirror failed (non-fatal)", {
            stripeSubscriptionId: sub.id,
            eventId: event.id,
            error: err instanceof Error ? err.message : String(err)
          });
        }
        const existing = await getSubscriptionByStripeSubscriptionId(sub.id);
        if (existing) {
          const businessId = existing.business_id;

          // Is the tenant actually leaving, or just changing plans? A plan
          // change cancels the OLD Stripe subscription and builds a new one,
          // so this same event fires for a tenant who is still very much
          // active. Everything below that tears down tenant-level state has to
          // tell the two apart.
          //
          // `cancel_reason` alone cannot: the orchestrator cancels the Stripe
          // subscription at step 6 and only stamps the row `upgrade_switch` at
          // step 8, with the slow box teardown in between, so at read time the
          // row is usually still active with a null reason. The reliable
          // signal is the REPLACEMENT row, which step 5 already created. See
          // src/lib/billing/upgrade-switch.ts.
          const newestRow = await getSubscription(businessId);
          const upgradeSwitch = isUpgradeSwitchDeletion({
            deletedStripeSubscriptionId: sub.id,
            deletedRow: existing,
            newestRow
          });

          if (upgradeSwitch) {
            logger.info("customer.subscription.deleted: plan change, skipping tenant teardown", {
              businessId,
              stripeSubscriptionId: sub.id,
              eventId: event.id
            });
          } else {
            // No membership, no auto-reload. The grant RPCs would refuse
            // anyway, so leaving rules armed would only burn failed charges.
            // Guarded because nothing re-enables these rules: firing on a plan
            // change silently stops a tenant's top-ups and they never find out.
            try {
              const { disableAutoReloadForBusiness } = await import("@/lib/db/auto-reload");
              await disableAutoReloadForBusiness(businessId, "subscription_canceled");
            } catch (err) {
              logger.warn("auto_reload: disable on subscription delete failed (non-fatal)", {
                businessId,
                eventId: event.id,
                error: err instanceof Error ? err.message : String(err)
              });
            }
            // No membership, no priority support. That is a SEPARATE Stripe
            // subscription, so cancelling the membership does not stop it:
            // left alone it keeps charging $400/month to an account with no
            // service behind it. Best-effort by contract (it swallows its own
            // errors) so it can never abort the teardown below.
            await terminatePrioritySupport(businessId);
          }
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
          // On a plan change the fallback DB-mirror below would race with
          // `runChangePlanFromCheckout`'s own final write on the old row,
          // re-stamping `stripe_subscription_cached_at` and stamping a grace
          // deadline on a tenant who is not leaving. Short-circuit instead.
          //
          // This used to test `status === "canceled" && cancel_reason ===
          // "upgrade_switch"` on the belief that the orchestrator finalized
          // the row BEFORE cancelling the Stripe subscription. It does not:
          // step 6 cancels in Stripe, step 8 stamps the row, and the slow box
          // teardown runs in between, so the webhook usually arrives while the
          // row is still active with a null reason and this check missed.
          // `isUpgradeSwitchDeletion` reads the replacement row instead, which
          // step 5 creates before any of that.
          if (upgradeSwitch) {
            logger.info(
              "customer.subscription.deleted: skipping fallback mirror for a plan change",
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
          // grace-sweep cron never picks the row up, SSH backup,
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
        // Manual pack grants are non-refundable on customer disputes
        // (including dispute.lost); New Coworker refunds claw back via refund
        // metadata / lifecycle executor instead. AUTO-RELOAD charges are the
        // exception: they are merchant-initiated, so a dispute both claws the
        // credit back and stops all future auto-charging for that business.
        const dispute = event.data.object as Stripe.Dispute;
        const disputedCharge = await resolveDisputedCharge(dispute);
        const handled = disputedCharge
          ? await clawbackAutoReloadGrantForCharge(disputedCharge, "dispute", event.id)
          : false;
        logger.info("Stripe dispute created", {
          eventId: event.id,
          disputeId: dispute.id,
          chargeId: typeof dispute.charge === "string" ? dispute.charge : dispute.charge?.id,
          reason: dispute.reason,
          amount: dispute.amount,
          autoReloadClawedBack: handled
        });
        break;
      }

      case "payment_intent.succeeded": {
        // Backstop only; the sweep grants synchronously. Gated on the
        // autoReload marker so an ordinary manual pack purchase, which also
        // emits this event with checkoutKind metadata, is a no-op here.
        await applyAutoReloadGrantFromPaymentIntent(
          event.data.object as Stripe.PaymentIntent,
          event.id
        );
        break;
      }

      case "payment_intent.payment_failed": {
        const intent = event.data.object as Stripe.PaymentIntent;
        if (intent.metadata?.autoReload === "1") {
          logger.warn("auto_reload: payment intent failed", {
            eventId: event.id,
            businessId: intent.metadata?.businessId,
            paymentIntentId: intent.id,
            code: intent.last_payment_error?.code ?? null
          });
        }
        break;
      }

      case "payment_method.detached": {
        // The authorized card is gone, so every rule for that business has to
        // stop rather than fail a charge on every tick.
        const pm = event.data.object as Stripe.PaymentMethod;
        const { disableAutoReloadForBusinessesByPaymentMethod } = await import(
          "@/lib/db/auto-reload"
        );
        const affected = await disableAutoReloadForBusinessesByPaymentMethod(pm.id);
        if (affected > 0) {
          logger.info("auto_reload: authorized card detached; rules disabled", {
            eventId: event.id,
            paymentMethodId: pm.id,
            businesses: affected
          });
        }
        break;
      }

      case "invoice.paid": {
        const invoice = event.data.object as Stripe.Invoice;
        const subscriptionId = getInvoiceSubscriptionId(invoice);

        if (subscriptionId) {
          let existing = await getSubscriptionByStripeSubscriptionId(subscriptionId);
          const stripe = getStripe();
          let stripeSub: Stripe.Subscription | null = null;
          try {
            stripeSub = await stripe.subscriptions.retrieve(subscriptionId);
          } catch (err) {
            logger.warn("Stripe subscription retrieve failed on invoice.paid", {
              eventId: event.id,
              subscriptionId,
              error: err instanceof Error ? err.message : String(err)
            });
          }

          // The priority support add-on is a SECOND Stripe subscription on the
          // same customer, and it must never reach the membership bookkeeping
          // below. Specifically the `businessId` fallback right after this
          // would resolve a priority-support invoice to the MEMBERSHIP row and
          // then overwrite `stripe_current_period_start/end` with this
          // subscription's ONE-MONTH window. On a 12/24-month plan that
          // silently corrupts the cached billing period, which drives the
          // monthly usage quota windows (deriveMonthlyQuotaWindow), the
          // renewal date, isCommitmentElapsed, and the contract-term nudge.
          // Handle it here and leave the switch.
          if (stripeSub && isPrioritySupportSubscription(stripeSub)) {
            const psBusinessId = stripeSub.metadata?.businessId?.trim();
            if (!psBusinessId) {
              logger.warn("priority_support: paid invoice carries no businessId metadata", {
                eventId: event.id,
                subscriptionId
              });
              break;
            }
            try {
              await applyPrioritySupportInvoicePaid({
                businessId: psBusinessId,
                stripeSubscription: stripeSub
              });
            } catch (err) {
              // Never fail the webhook over coverage bookkeeping: Stripe would
              // retry the whole event. The next paid invoice re-stamps from
              // the live period end anyway, since the write is monotonic.
              logger.error("priority_support: coverage extend failed on invoice.paid", {
                eventId: event.id,
                subscriptionId,
                businessId: psBusinessId,
                error: err instanceof Error ? err.message : String(err)
              });
            }
            break;
          }

          // Race: invoice.paid can beat checkout.session.completed (or the
          // change-plan orchestrator) that plants stripe_subscription_id.
          // Fall back to businessId on Stripe subscription metadata.
          if (!existing && stripeSub?.metadata?.businessId) {
            const byBiz = await getSubscription(stripeSub.metadata.businessId.trim());
            if (byBiz?.status === "active") {
              existing = byBiz;
            }
          }

          if (existing) {
            const periodCache = stripeSub
              ? stripeSubscriptionPeriodCache(stripeSub)
              : await fetchSubscriptionPeriodCacheOrEmpty(
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

            // Recurring membership pack add-ons: grant on every paid invoice
            // (first + renewals). Idempotent on invoice id + pack id. Grant
            // months come from the live Stripe plan interval (so term→monthly
            // rollover does not keep multiplying by 12/24).
            if (stripeSub) {
              try {
                const { applyMembershipPackAddonsFromInvoice } = await import(
                  "@/lib/billing/membership-pack-addon-grants"
                );
                await applyMembershipPackAddonsFromInvoice({
                  invoice,
                  stripeSubscription: stripeSub,
                  businessId: existing.business_id,
                  eventId: event.id
                });
              } catch (err) {
                logger.error("membership pack add-on grants failed on invoice.paid", {
                  eventId: event.id,
                  subscriptionId,
                  businessId: existing.business_id,
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
 * Errors are logged but not thrown, webhook acknowledgement must stay 200 or
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
  // Enterprise deals are mode=subscription but must NOT run the default
  // signup activation below: no lifetime-cap accounting (the deal is
  // admin-vetted), no commitment schedule (month-to-month by design), and no
  // provisioning trigger (the admin provisions from the panel, the box may
  // already exist).
  if (session.metadata?.checkoutKind === "enterprise_deal") {
    await applyEnterpriseDealFromCheckout(session, eventId);
    return;
  }
  // Priority support is mode=subscription but is the tenant's SECOND Stripe
  // subscription, not their membership. Without this early return it would
  // fall through to the default signup activation below and be adopted as the
  // membership subscription for the business.
  if (session.metadata?.checkoutKind === PRIORITY_SUPPORT_CHECKOUT_KIND) {
    await applyPrioritySupportFromCheckout(session, eventId);
    return;
  }
  // Card authorization for auto-reload: no charge, just a stored mandate.
  if (session.mode === "setup" && session.metadata?.checkoutKind === "auto_reload_setup") {
    await applyAutoReloadSetupFromCheckout(session, eventId);
    return;
  }
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
  if (session.mode === "payment" && session.metadata?.checkoutKind === "white_glove_package") {
    await applyWhiteGlovePurchaseFromCheckout(session, eventId);
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
    // Stripe webhook ack, and (b) must outlive it on Vercel serverless,
    // a bare floating promise is NOT guaranteed to keep the function
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

  if (businessId && sessionCustomerEmail) {
    try {
      await updateBusinessOwnerEmailIfPending(businessId, sessionCustomerEmail);
    } catch (err) {
      logger.warn("checkout activation: owner email lift failed (non-fatal)", {
        businessId,
        eventId,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

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
  // (incorrectly blocks legit future subs), and the atomic DB RPC is
  // still the last authority on concurrent checkouts at the cap.
  const alreadyLinkedToThisStripeSub =
    !!subscriptionId && existing.stripe_subscription_id === subscriptionId;
  const firstActivation = existing.status !== "active" && !alreadyLinkedToThisStripeSub;

  // Cap-bypass guard. If the row is already `active` and previously
  // linked to a *different* Stripe subscription id, then re-linking it
  // here (the unconditional update below) would attach a brand-new paid
  // Stripe sub to an existing local row WITHOUT consuming a lifetime
  // slot, `firstActivation` is false because the row is already
  // active, so the increment branch is skipped. This is the lifetime-
  // cap bypass that the screenshot bug report describes. Real
  // subscription transitions (changePlan / resubscribe) never reach
  // this default activation branch, they short-circuit at the
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
  // `grace_ends_at` / `wiped_at` / `cancel_at` / `cancel_reason` set,
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
  //      to issue a teardown, silent bail is correct.
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
    // uniformly, otherwise the first write silently undoes the second
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

  // Membership Checkout may include discounted one-time usage packs. Grant
  // only after the local sub is active so the RPCs pass entitlement checks.
  try {
    const { applyMembershipPackAddonsFromCheckout } = await import(
      "@/lib/billing/membership-pack-addon-grants"
    );
    await applyMembershipPackAddonsFromCheckout(session, eventId);
  } catch (err) {
    logger.error("membership pack add-on grants failed after signup activation", {
      businessId,
      sessionId: session.id,
      eventId,
      error: err instanceof Error ? err.message : String(err)
    });
  }

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

  // Promotion attribution. Records what Stripe ACTUALLY discounted rather than
  // the code's nominal value, so the admin stats report real dollars. Keyed on
  // the session id, so a webhook re-delivery is a no-op instead of inflating
  // the count or burning a second slot against the redemption cap. Best-effort
  // by design: a stats row is not worth failing an activation that has already
  // taken the customer's money.
  const promotionId = session.metadata?.promotionId;
  if (promotionId && billingPeriod && tier !== "enterprise") {
    try {
      await recordPromotionRedemption({
        promotionId,
        businessId,
        tier,
        billingPeriod,
        stripeSessionId: session.id,
        amountDiscountedCents: session.total_details?.amount_discount ?? 0
      });
    } catch (err) {
      logger.warn("promotion redemption not recorded (non-fatal)", {
        businessId,
        promotionId,
        sessionId: session.id,
        eventId,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  // Skip when the owner has opted into auto-renew: a late webhook retry
  // must not reinstate the month-to-month rollover schedule that
  // /api/billing/auto-renew deliberately released. Re-read the flag FRESH
  // here rather than trusting the `existing` snapshot loaded at handler
  // start, an owner toggling auto-renew on while this webhook is mid-flight
  // would otherwise have their released schedule silently recreated from
  // the stale snapshot. Falls back to the snapshot if the re-read misses.
  if (subscriptionId && billingPeriod && tier !== "enterprise") {
    const fresh = await getSubscriptionByStripeSubscriptionId(subscriptionId);
    const autoRenew = fresh ? fresh.contract_auto_renew : existing.contract_auto_renew;
    if (!autoRenew) {
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
  const { enqueueProvisioningJob, runProvisioningJob } = await import("@/lib/provisioning/jobs");

  // Durable job row FIRST (inline, before the ack): even if this function
  // is torn down before the orchestrator writes anything, the
  // provisioning-watchdog cron has a queued row to find and re-run. A
  // ledger failure must never block a signup, the inline run below still
  // happens either way.
  const jobInputs = {
    businessId,
    tier: tier as string,
    vpsSize: business?.vps_size ?? null,
    billingPeriod: billingPeriod ?? null
  };
  try {
    await enqueueProvisioningJob(jobInputs);
  } catch (err) {
    logger.warn("enqueueProvisioningJob failed (provisioning continues inline)", {
      businessId,
      error: err instanceof Error ? err.message : String(err)
    });
  }

  // `after()` (Vercel waitUntil) rather than a bare floating promise: the
  // runtime is free to tear the function down right after the 200 ack
  // otherwise, which is exactly how the Truly (Jul 8) and KYP (Jul 14)
  // signups died at "started 5%", the .then/.catch chain here previously
  // had no keep-alive at all. billingPeriod drives the Hostinger purchase
  // term: a customer committing to an annual/biennial contract funds a
  // term-priced box (~40-65% cheaper per month than the monthly SKU's
  // renewal price).
  after(async () => {
  await runProvisioningJob(
    { business_id: businessId, tier: jobInputs.tier, vps_size: jobInputs.vpsSize, billing_period: jobInputs.billingPeriod },
    {
      orchestrate: (input) =>
        orchestrateProvisioning({
          businessId: input.businessId,
          tier: input.tier,
          vpsSize: input.vpsSize,
          billingPeriod: input.billingPeriod,
          notifyOpsNewSignup: true
        })
    }
  )
    .then(async (result) => {
      // Persist the Hostinger billing-subscription id so the lifecycle
      // engine can later cancel Hostinger billing (DELETE
      // /api/billing/v1/subscriptions/{id}) when the user cancels. Done on
      // success only, if provisioning failed we don't want to write a stale
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
      // Vercel logs, `err.message` alone strips the response body, and
      // the body is exactly where Hostinger puts the actionable error
      // copy (e.g. `[VPS:2000] Unauthorized` for a token missing scope).
      //
      // The detail extraction is duplicated from
      // `describeProvisioningError` rather than imported because some
      // tests mock the entire orchestrator module, which leaves the
      // helper undefined inside an async catch block. Keeping this
      // inline trades five lines of duplication for hermetic test
      // mocking, and the logic is small enough that drift is cheap.
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
  });
}

export {
  parseVoiceBonusSecondsFromMetadata,
  parseSmsBonusTextsFromMetadata,
  parseChatCreditMicrosFromMetadata
} from "@/lib/billing/usage-pack-metadata";

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

/**
 * Activates an enterprise deal (checkout.session.completed on a
 * `checkoutKind: "enterprise_deal"` subscription-mode session):
 *
 *   1. ATOMICALLY claims the enterprise_deals row as 'active' (idempotent
 *      under webhook retries; a completion from a DIFFERENT session cancels
 *      the duplicate Stripe subscription instead of double-linking).
 *   2. Wires stripe_customer_id + stripe_subscription_id +
 *      billing_period="monthly" + the Stripe period cache onto the tenant's
 *      existing subscriptions row (admin-created enterprise rows are active
 *      and Stripe-less until this moment). From here the tenant behaves like
 *      a normal month-to-month subscriber: renewals via invoice.paid,
 *      payment-failure lifecycle, cancel flow.
 *
 * Deliberately NOT done here (differences from the default signup path):
 * lifetime-cap increment (admin-vetted deal, not self-serve abuse surface),
 * commitment schedule (month-to-month), and provisioning (admin-driven; the
 * box may already exist).
 */
async function applyEnterpriseDealFromCheckout(
  session: Stripe.Checkout.Session,
  eventId: string
) {
  const dealId = session.metadata?.enterpriseDealId?.trim();
  if (!dealId) {
    logger.warn("enterprise_deal checkout missing enterpriseDealId", {
      eventId,
      sessionId: session.id
    });
    return;
  }
  const deal = await getEnterpriseDeal(dealId);
  const metaBusinessId = session.metadata?.businessId?.trim() || null;
  // The deal row is the source of truth; metadata businessId must agree.
  if (!deal || (metaBusinessId && deal.business_id !== metaBusinessId)) {
    logger.warn("enterprise_deal checkout for unknown/mismatched deal", {
      eventId,
      sessionId: session.id,
      businessId: metaBusinessId,
      dealId
    });
    return;
  }
  const businessId = deal.business_id;

  const customerId =
    typeof session.customer === "string" ? session.customer : session.customer?.id ?? null;
  const subscriptionId =
    typeof session.subscription === "string"
      ? session.subscription
      : session.subscription?.id ?? null;
  if (!subscriptionId) {
    logger.error("enterprise_deal checkout session has no subscription id", {
      eventId,
      sessionId: session.id,
      businessId,
      dealId
    });
    return;
  }

  const existing = await getSubscription(businessId);

  // Linkage guard, checked BEFORE claiming the deal so a refused payment
  // never wedges the deal row in 'active': an ACTIVE local row already
  // linked to a DIFFERENT live Stripe sub means this payment would
  // double-bill the tenant, cancel the fresh sub. (A CANCELED row linked
  // to an old, dead Stripe sub is the normal returning-tenant re-deal shape
  // and is handled below.)
  if (
    existing?.stripe_subscription_id &&
    existing.stripe_subscription_id !== subscriptionId &&
    existing.status === "active"
  ) {
    logger.error(
      "enterprise_deal activation refused: subscription row already linked to a different Stripe sub",
      {
        eventId,
        sessionId: session.id,
        businessId,
        dealId,
        existingStripeSubscriptionId: existing.stripe_subscription_id,
        incomingStripeSubscriptionId: subscriptionId
      }
    );
    await cancelStripeSubscriptionSafely(subscriptionId, businessId);
    return;
  }

  const createdSec =
    typeof session.created === "number" && Number.isFinite(session.created)
      ? session.created
      : Math.floor(Date.now() / 1000);
  const claim = await markEnterpriseDealActive(dealId, {
    activatedAt: new Date(createdSec * 1000),
    stripeSessionId: session.id,
    stripeSubscriptionId: subscriptionId
  });
  if (claim === "not_claimable") {
    // The deal is no longer claimable by this session: either it was already
    // activated by a DIFFERENT Checkout Session (two pay tabs both reached
    // Stripe before the first completion landed), or this is a STALE session
    // completing after an admin revoke / after the deal's subscription ended.
    // Either way, cancel this fresh Stripe subscription so the customer
    // isn't billed monthly against a dead or duplicate deal; support refunds
    // any captured first invoice out-of-band.
    logger.error("enterprise_deal not claimable by this session, canceling its subscription", {
      eventId,
      sessionId: session.id,
      businessId,
      dealId,
      dealStatus: deal.status,
      firstSessionId: deal.stripe_session_id,
      monthlyCents: deal.monthly_cents
    });
    await cancelStripeSubscriptionSafely(subscriptionId, businessId);
    return;
  }

  const periodCache = await fetchSubscriptionPeriodCacheOrEmpty(
    subscriptionId,
    "Stripe subscription retrieve failed on enterprise deal activation",
    { businessId, dealId }
  );

  if (existing && !existing.wiped_at) {
    // Re-deal for a canceled-in-grace tenant is legitimate (the admin
    // authored a fresh deal after the old subscription ended), but the row
    // must not keep its cancellation bookkeeping alongside status=active,
    // that Frankenstein state races the grace-sweep and confuses the
    // dashboard. Clear it in the same write, mirroring what the resubscribe
    // orchestrator does for self-serve reactivations.
    const clearCancellation =
      existing.status === "canceled"
        ? {
            canceled_at: null,
            cancel_reason: null,
            grace_ends_at: null,
            cancel_at_period_end: false
          }
        : {};
    await updateSubscription(existing.id, {
      status: "active",
      tier: "enterprise",
      billing_period: "monthly",
      commitment_months: 1,
      ...(customerId ? { stripe_customer_id: customerId } : {}),
      stripe_subscription_id: subscriptionId,
      ...clearCancellation,
      ...periodCache
    });
  } else {
    // No row (defensive, admin-created enterprise businesses always have
    // one), or the prior lifetime was WIPED: a wiped row is terminal
    // bookkeeping (its data backup is gone) and must never be resurrected,
    // so the re-deal starts a fresh row. getSubscription reads newest-first,
    // so the new active row supersedes the wiped one everywhere.
    await createSubscription({
      id: crypto.randomUUID(),
      business_id: businessId,
      tier: "enterprise",
      status: "active",
      stripe_customer_id: customerId,
      stripe_subscription_id: subscriptionId,
      billing_period: "monthly",
      commitment_months: 1,
      ...periodCache
    });
  }

  logger.info("Enterprise deal activated", {
    eventId,
    sessionId: session.id,
    businessId,
    dealId,
    stripeSubscriptionId: subscriptionId,
    setupCents: deal.setup_cents,
    monthlyCents: deal.monthly_cents
  });
}

/**
 * Records a completed priority-support Checkout: plants the mirror row for the
 * tenant's SECOND Stripe subscription and opens the coverage window.
 *
 * Coverage is stamped here as well as on `invoice.paid` so the first period is
 * open even if that event is delayed or lost. Both writes go through the
 * monotonic `extendPrioritySupport`, so doing it twice is a no-op rather than
 * a double extension.
 *
 * Idempotent under webhook retries: `stripe_subscription_id` is unique and the
 * partial index allows one live row per business, so a replay resolves to the
 * existing row instead of opening a second $400/month subscription.
 */
async function applyPrioritySupportFromCheckout(
  session: Stripe.Checkout.Session,
  eventId: string
) {
  const businessId = session.metadata?.businessId?.trim();
  if (!businessId) {
    logger.warn("priority_support checkout missing businessId", {
      eventId,
      sessionId: session.id
    });
    return;
  }
  const subscriptionId =
    typeof session.subscription === "string"
      ? session.subscription
      : session.subscription?.id ?? null;
  if (!subscriptionId) {
    logger.error("priority_support checkout session has no subscription id", {
      eventId,
      sessionId: session.id,
      businessId
    });
    return;
  }
  const customerId =
    typeof session.customer === "string" ? session.customer : session.customer?.id ?? null;

  let periodEnd: Date | null = null;
  try {
    const stripeSub = await getStripe().subscriptions.retrieve(subscriptionId);
    periodEnd = prioritySupportPeriodEnd(stripeSub);
  } catch (err) {
    // Not fatal: the row still gets planted, and the next `invoice.paid`
    // stamps coverage from the live period end.
    logger.warn("priority_support: subscription retrieve failed on checkout", {
      eventId,
      subscriptionId,
      businessId,
      error: err instanceof Error ? err.message : String(err)
    });
  }

  try {
    const { duplicate } = await recordPrioritySupportCheckout({
      businessId,
      stripeSubscriptionId: subscriptionId,
      stripeCustomerId: customerId,
      stripeSessionId: session.id,
      periodEnd,
      createdBy: session.customer_details?.email ?? session.metadata?.userId ?? "checkout"
    });
    logger.info("priority_support: subscription recorded", {
      eventId,
      businessId,
      subscriptionId,
      duplicate
    });
  } catch (err) {
    logger.error("priority_support: recording checkout failed", {
      eventId,
      businessId,
      subscriptionId,
      error: err instanceof Error ? err.message : String(err)
    });
  }
}

/**
 * Records a white-glove package purchase (Phase C5): stamps the package +
 * priority call/video support window (purchase + 30d) on the business row
 * and sends the booking confirmation email. Idempotent under webhook
 * retries, the row update re-writes the same values (session `created` is
 * fixed) and a duplicate confirmation email is a tolerable worst case.
 */
async function applyWhiteGlovePurchaseFromCheckout(
  session: Stripe.Checkout.Session,
  eventId: string
) {
  // Custom admin-authored offer: mark the offer row paid; the fixed-package
  // column is untouched. Checked BEFORE the businessId guard because a
  // PROSPECT offer (paid via the public /offer link before any account
  // exists) legitimately has no businessId metadata.
  const offerId = session.metadata?.whiteGloveOfferId?.trim();
  if (offerId) {
    await applyCustomWhiteGloveOfferFromCheckout(session, eventId, offerId);
    return;
  }
  const businessId = session.metadata?.businessId?.trim();
  if (!businessId) {
    logger.warn("white_glove_package checkout missing businessId", {
      eventId,
      sessionId: session.id
    });
    return;
  }
  const pkg = getWhiteGlovePackage(session.metadata?.whiteGlovePackage ?? "");
  if (!pkg) {
    logger.warn("white_glove_package checkout has unknown package id", {
      eventId,
      sessionId: session.id,
      businessId,
      rawPackage: session.metadata?.whiteGlovePackage ?? null
    });
    return;
  }

  const business = await getBusiness(businessId);
  if (!business) {
    logger.warn("white_glove_package checkout for unknown business", {
      eventId,
      sessionId: session.id,
      businessId
    });
    return;
  }
  // Never downgrade: a stray/retried `setup` completion after a `buildout`
  // purchase must not overwrite the larger package already on the row.
  if (business.white_glove_package === "buildout" && pkg.id === "setup") {
    logger.warn("white_glove_package checkout ignored: buildout already owned", {
      eventId,
      sessionId: session.id,
      businessId
    });
    return;
  }

  const createdSec =
    typeof session.created === "number" && Number.isFinite(session.created)
      ? session.created
      : Math.floor(Date.now() / 1000);
  const purchasedAt = new Date(createdSec * 1000);
  const supportUntil = prioritySupportUntil(purchasedAt);

  await recordWhiteGlovePurchase(businessId, {
    packageId: pkg.id,
    purchasedAt,
    prioritySupportUntil: supportUntil
  });
  logger.info("White-glove purchase recorded", {
    eventId,
    sessionId: session.id,
    businessId,
    packageId: pkg.id,
    prioritySupportUntil: supportUntil.toISOString()
  });

  // Confirmation email is best-effort: the purchase is already recorded, so
  // a Resend hiccup must not fail the webhook (Stripe would retry and we'd
  // re-run the whole handler for nothing).
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    logger.warn("white_glove_package: RESEND_API_KEY unset; skipping confirmation email", {
      eventId,
      businessId
    });
    return;
  }
  try {
    const siteUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
    const { subject, text, html } = buildWhiteGloveConfirmationEmail({
      packageName: pkg.name,
      recipientEmail: business.owner_email,
      prioritySupportUntil: supportUntil,
      bookingUrl: getWhiteGloveBookingUrl(),
      siteUrl,
      locale: await resolveOwnerUiLocaleForEmail(business.owner_email)
    });
    await sendOwnerEmail(apiKey, business.owner_email, subject, { text, html });
  } catch (err) {
    logger.error("white_glove_package confirmation email failed", {
      eventId,
      businessId,
      error: err instanceof Error ? err.message : String(err)
    });
  }
}

/**
 * Records a CUSTOM white-glove offer payment: flips the white_glove_offers
 * row to 'paid', extends (never shortens) the business's priority
 * call/video support window by the standard 30 days, and sends the same
 * booking confirmation email as the fixed packages. PROSPECT offers
 * (business_id null, paid through the public /offer link before any
 * account exists) skip the business steps; the confirmation goes to the
 * offer's recipient_email (falling back to the Stripe payer email) and the
 * support window is granted when the account is created. Idempotent under
 * webhook retries, the row re-writes the same values (session `created`
 * is fixed) and extendPrioritySupport is monotonic.
 */
async function applyCustomWhiteGloveOfferFromCheckout(
  session: Stripe.Checkout.Session,
  eventId: string,
  offerId: string
) {
  const offer = await getWhiteGloveOffer(offerId);
  const metaBusinessId = session.metadata?.businessId?.trim() || null;
  // The offer row is the source of truth; metadata businessId (present only
  // on billing-page checkouts) must agree when both exist.
  if (!offer || (metaBusinessId && offer.business_id !== metaBusinessId)) {
    logger.warn("white_glove_offer checkout for unknown/mismatched offer", {
      eventId,
      sessionId: session.id,
      businessId: metaBusinessId,
      offerId
    });
    return;
  }
  const businessId = offer.business_id;
  const business = businessId ? await getBusiness(businessId) : null;
  if (businessId && !business) {
    logger.warn("white_glove_offer checkout for unknown business", {
      eventId,
      sessionId: session.id,
      businessId
    });
    return;
  }

  const createdSec =
    typeof session.created === "number" && Number.isFinite(session.created)
      ? session.created
      : Math.floor(Date.now() / 1000);
  const purchasedAt = new Date(createdSec * 1000);
  const supportUntil = prioritySupportUntil(purchasedAt);

  const claim = await markWhiteGloveOfferPaid(offerId, {
    paidAt: purchasedAt,
    stripeSessionId: session.id
  });
  if (claim === "duplicate_session") {
    // The offer was already paid by a DIFFERENT Checkout Session: the
    // customer was charged twice (two Buy tabs both reached Stripe before
    // the first completion landed). Don't re-credit anything, surface it
    // loudly so support refunds this session's charge.
    logger.error("white_glove_offer paid by a second session, refund needed", {
      eventId,
      sessionId: session.id,
      businessId,
      offerId,
      firstSessionId: offer.stripe_session_id,
      amountCents: offer.amount_cents
    });
    return;
  }
  let effectiveBusinessId = businessId;
  if (!effectiveBusinessId) {
    // The RECIPIENT may already have an account (signed up between receiving
    // the link and paying). Attach the paid offer to their newest business so
    // billing hides the upsell and priority support opens now; when no
    // account exists yet, createBusiness / the pending-email swap attach it
    // at signup instead. Strictly the recipient's email, never the Stripe
    // payer's, which anyone holding the link could set.
    try {
      effectiveBusinessId = await attachPaidProspectOfferToBusinessByEmail(
        offerId,
        offer.recipient_email
      );
    } catch (err) {
      logger.error("white_glove_offer prospect attach failed (non-fatal)", {
        eventId,
        offerId,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }
  if (effectiveBusinessId) await extendPrioritySupport(effectiveBusinessId, supportUntil);
  logger.info("Custom white-glove offer paid", {
    eventId,
    sessionId: session.id,
    businessId: effectiveBusinessId,
    offerId,
    prospect: !businessId,
    amountCents: offer.amount_cents,
    prioritySupportUntil: supportUntil.toISOString()
  });

  const confirmationEmail =
    business?.owner_email ??
    offer.recipient_email ??
    session.customer_details?.email ??
    null;
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey || !confirmationEmail) {
    logger.warn("white_glove_offer: skipping confirmation email", {
      eventId,
      businessId,
      offerId,
      reason: !apiKey ? "RESEND_API_KEY unset" : "no recipient email"
    });
    return;
  }
  try {
    const siteUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
    const { subject, text, html } = buildWhiteGloveConfirmationEmail({
      packageName: offer.name,
      recipientEmail: confirmationEmail,
      prioritySupportUntil: supportUntil,
      bookingUrl: getWhiteGloveBookingUrl(),
      siteUrl,
      locale: await resolveOwnerUiLocaleForEmail(confirmationEmail)
    });
    await sendOwnerEmail(apiKey, confirmationEmail, subject, { text, html });
  } catch (err) {
    logger.error("white_glove_offer confirmation email failed", {
      eventId,
      businessId,
      error: err instanceof Error ? err.message : String(err)
    });
  }
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
 *   caller falls back to a full void, safer than miscomputing a partial clawback.
 * - Ratio is applied to `session.amount_total` if present (falls back to the grant's
 *   `seconds_purchased` in the RPC via `p_clawback_seconds=null` when both inputs are
 *   unavailable). Rounded to the nearest second; a full refund (amount_refunded ===
 *   original_amount) returns `null` to signal full void and avoid float rounding errors.
 */
/**
 * Proration helper kept for unit tests and admin tooling. Customer Stripe
 * refunds no longer call this automatically (packs are non-refundable from
 * the user side); operators use POST /api/admin/usage-pack-clawback.
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
 * Pack clawback safety net for New Coworker-issued refunds.
 *
 * Primary clawback runs in lifecycle `refund_latest_charge` after
 * `refunds.create`. This path re-runs when `charge.refunded` carries a refund
 * stamped with `metadata.newcoworker_reason` (idempotent void RPCs).
 * Customer/Dashboard refunds without that metadata, and all disputes, leave
 * grants alone (admin `/api/admin/usage-pack-clawback` remains).
 */
const AUTO_RELOAD_KIND_MAP: Record<string, { kind: "voice" | "sms" | "chat"; unitKey: string }> = {
  voice_bonus_seconds: { kind: "voice", unitKey: "voiceSeconds" },
  sms_bonus_texts: { kind: "sms", unitKey: "smsTexts" },
  chat_credit_micros: { kind: "chat", unitKey: "creditMicros" }
};

/**
 * Is this charge an auto-reload charge?
 *
 * Resolves the PaymentIntent and checks the `autoReload` marker. The marker
 * matters because manual pack Checkouts mirror `checkoutKind` onto the
 * PaymentIntent too, so `checkoutKind` alone cannot tell the two apart.
 */
async function autoReloadIntentForCharge(
  charge: Stripe.Charge
): Promise<Stripe.PaymentIntent | null> {
  const piId = typeof charge.payment_intent === "string"
    ? charge.payment_intent
    : charge.payment_intent?.id;
  if (!piId) return null;
  try {
    const intent = await getStripe().paymentIntents.retrieve(piId);
    return intent.metadata?.autoReload === "1" ? intent : null;
  } catch (err) {
    logger.warn("auto_reload: payment intent retrieve failed", {
      chargeId: charge.id,
      paymentIntentId: piId,
      error: err instanceof Error ? err.message : String(err)
    });
    return null;
  }
}

/**
 * The charge behind a dispute, expanded when Stripe sent only an id.
 *
 * Fully guarded: a dispute on a charge we cannot read is still a dispute, and
 * failing the webhook would make Stripe retry an event we can never process.
 */
async function resolveDisputedCharge(dispute: Stripe.Dispute): Promise<Stripe.Charge | null> {
  if (dispute.charge && typeof dispute.charge !== "string") return dispute.charge;
  if (typeof dispute.charge !== "string") return null;
  try {
    return await getStripe().charges.retrieve(dispute.charge);
  } catch (err) {
    logger.warn("dispute: charge retrieve failed", {
      disputeId: dispute.id,
      chargeId: dispute.charge,
      error: err instanceof Error ? err.message : String(err)
    });
    return null;
  }
}

/**
 * Claw back an auto-reload grant on a refund or dispute.
 *
 * Deliberately stricter than the manual-pack policy. Manual packs are
 * non-refundable to customers and disputes leave grants alone, but an
 * auto-reload charge is merchant-initiated, so any refund takes the credit
 * with the money, and a dispute takes it AND stops future charging: a
 * chargeback on an unattended charge is the customer saying they did not
 * expect it, and continuing to charge them is how this becomes a Stripe risk
 * review.
 *
 * Returns true when it handled the charge, so the caller stops.
 */
async function clawbackAutoReloadGrantForCharge(
  charge: Stripe.Charge,
  reason: "refund" | "dispute",
  eventId: string
): Promise<boolean> {
  const intent = await autoReloadIntentForCharge(charge);
  if (!intent) return false;

  const businessId = intent.metadata?.businessId?.trim();
  const spec = AUTO_RELOAD_KIND_MAP[intent.metadata?.checkoutKind ?? ""];
  if (!businessId || !spec) {
    logger.warn("auto_reload clawback: intent metadata incomplete", {
      eventId,
      paymentIntentId: intent.id
    });
    return true;
  }

  const { clawbackUsagePackGrantBySourceId, computeUsagePackClawbackAmount } = await import(
    "@/lib/billing/usage-pack-clawback"
  );
  const purchased = Number(intent.metadata?.[spec.unitKey] ?? NaN);
  const clawbackAmount =
    reason === "dispute"
      ? null // full void
      : computeUsagePackClawbackAmount(
          charge.amount ?? null,
          charge.amount_refunded ?? null,
          Number.isFinite(purchased) ? purchased : null
        );

  const res = await clawbackUsagePackGrantBySourceId({
    sourceId: `pi_${intent.id}`,
    kind: spec.kind,
    reason,
    clawbackAmount
  });
  logger.info("auto_reload clawback applied", {
    eventId,
    businessId,
    paymentIntentId: intent.id,
    reason,
    clawbackAmount,
    ok: res.ok
  });

  if (reason === "dispute") {
    const { disableAutoReloadForBusiness } = await import("@/lib/db/auto-reload");
    await disableAutoReloadForBusiness(businessId, "dispute");
  }
  return true;
}

/**
 * Store the card a tenant authorized for auto-reload.
 *
 * Reached from `checkout.session.completed` in `mode: "setup"`. Until this
 * row exists the sweep skips the tenant entirely, so a rule can be saved as
 * enabled while the authorization is still outstanding and the UI can say so.
 */
async function applyAutoReloadSetupFromCheckout(
  session: Stripe.Checkout.Session,
  eventId: string
): Promise<void> {
  const businessId = session.metadata?.businessId?.trim();
  const setupIntentId =
    typeof session.setup_intent === "string" ? session.setup_intent : session.setup_intent?.id;
  if (!businessId || !setupIntentId) {
    logger.warn("auto_reload setup: missing businessId or setup intent", {
      eventId,
      sessionId: session.id
    });
    return;
  }

  const stripe = getStripe();
  let paymentMethodId: string | null = null;
  let card: Stripe.PaymentMethod.Card | null = null;
  try {
    const setupIntent = await stripe.setupIntents.retrieve(setupIntentId);
    paymentMethodId =
      typeof setupIntent.payment_method === "string"
        ? setupIntent.payment_method
        : (setupIntent.payment_method?.id ?? null);
    if (paymentMethodId) {
      const pm = await stripe.paymentMethods.retrieve(paymentMethodId);
      card = pm.card ?? null;
    }
  } catch (err) {
    logger.error("auto_reload setup: Stripe lookup failed", {
      eventId,
      businessId,
      setupIntentId,
      error: err instanceof Error ? err.message : String(err)
    });
    return;
  }

  if (!paymentMethodId) {
    logger.error("auto_reload setup: setup intent has no payment method", {
      eventId,
      businessId,
      setupIntentId
    });
    return;
  }

  const { saveAutoReloadCard, reenableAutoReloadAfterCardAuthorized } = await import(
    "@/lib/db/auto-reload"
  );
  await saveAutoReloadCard(businessId, {
    stripePaymentMethodId: paymentMethodId,
    cardBrand: card?.brand ?? null,
    cardLast4: card?.last4 ?? null,
    cardExpMonth: card?.exp_month ?? null,
    cardExpYear: card?.exp_year ?? null,
    consentUserId: session.metadata?.userId?.trim() || null,
    consentIp: null,
    consentTextVersion: "v1"
  });

  // Make the same card the customer's invoice default, so a tenant who
  // authorized a fresh card for top-ups is not left with a stale card on the
  // membership itself.
  const customerId = typeof session.customer === "string" ? session.customer : session.customer?.id;
  if (customerId) {
    try {
      await stripe.customers.update(customerId, {
        invoice_settings: { default_payment_method: paymentMethodId }
      });
    } catch (err) {
      logger.warn("auto_reload setup: could not set customer default payment method", {
        eventId,
        businessId,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  // Replacing a card can emit payment_method.detached for the OLD method
  // before this handler saves the new one, which would have left the tenant
  // switched off after doing exactly the right thing. Only rules disabled by
  // that specific path come back; declines, disputes, and cancellations still
  // need a deliberate decision.
  const restored = await reenableAutoReloadAfterCardAuthorized(businessId);

  logger.info("auto_reload setup: card authorized", {
    eventId,
    businessId,
    paymentMethodId,
    rulesRestored: restored
  });
}

/**
 * Backstop grant for an auto-reload PaymentIntent.
 *
 * The sweep grants synchronously right after charging, because taking money
 * and silently not granting is the worst outcome this feature can produce.
 * This exists only for the crash window between those two steps. Both write
 * `pi_<id>` through the same idempotent RPC, so running both is free.
 *
 * The `autoReload === "1"` gate is NOT optional: manual pack Checkouts set
 * `payment_intent_data.metadata`, so an ordinary purchase already emits this
 * event carrying `checkoutKind` and the unit count. Gating on `checkoutKind`
 * alone would grant twice for every manual purchase, once under `cs_` and
 * once under `pi_`, and the two distinct keys mean the RPC's idempotency
 * cannot catch it.
 */
async function applyAutoReloadGrantFromPaymentIntent(
  intent: Stripe.PaymentIntent,
  eventId: string
): Promise<void> {
  if (intent.metadata?.autoReload !== "1") return;

  const businessId = intent.metadata?.businessId?.trim();
  const spec = AUTO_RELOAD_KIND_MAP[intent.metadata?.checkoutKind ?? ""];
  if (!businessId || !spec) return;

  const units = Number(intent.metadata?.[spec.unitKey] ?? NaN);
  if (!Number.isFinite(units) || units <= 0) {
    logger.warn("auto_reload backstop: invalid unit count", {
      eventId,
      paymentIntentId: intent.id
    });
    return;
  }

  const rpcName =
    spec.kind === "voice"
      ? "apply_voice_bonus_grant_from_checkout"
      : spec.kind === "sms"
        ? "apply_sms_bonus_grant_from_checkout"
        : "apply_chat_credit_grant_from_checkout";
  const amountParam =
    spec.kind === "voice"
      ? "p_seconds_purchased"
      : spec.kind === "sms"
        ? "p_texts_purchased"
        : "p_credit_micros";

  const { createSupabaseServiceClient } = await import("@/lib/supabase/server");
  const db = await createSupabaseServiceClient();
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await db.rpc(rpcName, {
    p_business_id: businessId,
    p_checkout_session_id: `pi_${intent.id}`,
    [amountParam]: units,
    p_expires_at: expiresAt
  });
  if (error) {
    logger.error("auto_reload backstop grant failed", {
      eventId,
      paymentIntentId: intent.id,
      error: error.message
    });
    return;
  }
  logger.info("auto_reload backstop grant recorded", {
    eventId,
    businessId,
    paymentIntentId: intent.id,
    result: data
  });
}

async function handleVoiceBonusRefund(event: Stripe.Event): Promise<void> {
  // Auto-reload charges are handled before the manual-pack policy below,
  // because they follow the opposite refund rule (see
  // clawbackAutoReloadGrantForCharge) and have no invoice to look up.
  if (event.type === "charge.refunded") {
    const charge = event.data.object as Stripe.Charge;
    if (await clawbackAutoReloadGrantForCharge(charge, "refund", event.id)) return;
  }

  if (event.type === "charge.dispute.closed") {
    logger.info("Usage pack dispute ignored; packs are non-refundable to customers", {
      eventId: event.id,
      type: event.type
    });
    return;
  }

  if (event.type !== "charge.refunded") {
    logger.info("Usage pack refund/dispute ignored; packs are non-refundable to customers", {
      eventId: event.id,
      type: event.type
    });
    return;
  }

  const charge = event.data.object as Stripe.Charge;
  const {
    clawbackMembershipPackGrantsForInvoice,
    clawbackReasonForNewcoworkerRefund
  } = await import("@/lib/billing/usage-pack-clawback");

  let packReason: "refund" | "admin" | null = null;
  try {
    const listed = await getStripe().refunds.list({ charge: charge.id, limit: 100 });
    for (const refund of listed.data) {
      const reason = clawbackReasonForNewcoworkerRefund(refund.metadata?.newcoworker_reason);
      if (reason) {
        packReason = reason;
        break;
      }
    }
  } catch (err) {
    logger.warn("Usage pack refund: listing charge refunds failed", {
      eventId: event.id,
      chargeId: charge.id,
      error: err instanceof Error ? err.message : String(err)
    });
    return;
  }

  if (!packReason) {
    logger.info("Usage pack refund ignored; no New Coworker refund metadata", {
      eventId: event.id,
      chargeId: charge.id
    });
    return;
  }

  // Stripe's Charge type omits `invoice` in some API versions; read it defensively.
  const chargeInvoice = (charge as Stripe.Charge & { invoice?: string | { id?: string } | null })
    .invoice;
  const invoiceId =
    typeof chargeInvoice === "string" ? chargeInvoice : chargeInvoice?.id ?? null;
  if (!invoiceId) {
    logger.info("Usage pack NC refund: charge has no invoice; skipping membership clawback", {
      eventId: event.id,
      chargeId: charge.id
    });
    return;
  }

  let subscriptionMetadata: Stripe.Metadata | null = null;
  try {
    const invoice = await getStripe().invoices.retrieve(invoiceId);
    const subscriptionId = getInvoiceSubscriptionId(invoice);
    if (subscriptionId) {
      const sub = await getStripe().subscriptions.retrieve(subscriptionId);
      subscriptionMetadata = sub.metadata;
    }
  } catch (err) {
    logger.warn("Usage pack NC refund: subscription metadata lookup failed", {
      eventId: event.id,
      invoiceId,
      error: err instanceof Error ? err.message : String(err)
    });
  }

  await clawbackMembershipPackGrantsForInvoice({
    invoiceId,
    reason: packReason,
    subscriptionMetadata
  });
}

function getInvoiceSubscriptionId(invoice: Stripe.Invoice): string | null {
  const subscription = invoice.parent?.subscription_details?.subscription;
  if (!subscription) return null;
  return typeof subscription === "string" ? subscription : subscription.id;
}
