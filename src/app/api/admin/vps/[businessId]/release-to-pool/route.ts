/**
 * POST /api/admin/vps/:businessId/release-to-pool
 *
 * Admin-only: mark a tenant's Hostinger box `available` in the
 * `vps_inventory` adopt pool WITHOUT tearing the tenant down. The account
 * keeps running on the box until a new signup's adopt-first claim picks it
 * up; at that moment the adopt path recreates the box and cascade-deletes
 * the old account (business row + all ON DELETE CASCADE tenant data + the
 * owner's auth user) via `cleanupStaleTenantsForVm`.
 *
 * Billing cascade (Jul 2026): releasing now also settles the account's
 * billing state so nothing keeps looking "live" afterwards:
 *   - the NewCoworker subscription row (if any, and not already canceled)
 *     is flipped to `canceled` WITHOUT a grace deadline — the grace sweep
 *     ignores rows with a null `grace_ends_at`, so the account is deleted
 *     by the adopt-time cascade, not by a data wipe. This is also what
 *     stops the daily billing-posture findings for Stripe-less internal
 *     accounts (e.g. the Residency Pilot).
 *   - Hostinger auto-renew for the box is disabled best-effort (pool
 *     semantics: parked boxes lapse at period end unless adopted, which
 *     re-enables renewal).
 *
 * Fail-closed guards:
 *   - Hostinger-lifecycle tenants only (BYOS/OVH boxes are not pool stock).
 *   - Refuses while a REAL Stripe subscription is linked and not canceled:
 *     this route never touches Stripe, so releasing would let Stripe keep
 *     charging an account destined for deletion. Force-cancel & wipe (which
 *     cancels Stripe properly) is the right tool there. Stripe-LESS rows —
 *     internal pilots, admin-created enterprise accounts — pass the guard
 *     regardless of status; there is no payment to orphan.
 */

import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { successResponse, errorResponse, handleRouteError } from "@/lib/api-response";
import { getBusiness } from "@/lib/db/businesses";
import {
  cancelSubscriptionIfStripeless,
  getSubscription,
  listBusinessIdsWithStripeLinkedSubscription
} from "@/lib/db/subscriptions";
import { releaseVpsToPool } from "@/lib/db/vps-inventory";
import { resolveDeployedVpsSize } from "@/lib/vps/size";
import { providerUsesHostingerLifecycle, resolveVpsProvider } from "@/lib/vps/provider";
import { HostingerClient, DEFAULT_HOSTINGER_BASE_URL } from "@/lib/hostinger/client";
import { logger } from "@/lib/logger";

const paramsSchema = z.object({ businessId: z.string().uuid() });

export async function POST(
  _request: Request,
  ctx: { params: Promise<{ businessId: string }> }
) {
  try {
    const admin = await requireAdmin();
    const { businessId } = paramsSchema.parse(await ctx.params);

    const business = await getBusiness(businessId);
    if (!business) return errorResponse("NOT_FOUND", "Business not found", 404);

    const provider = resolveVpsProvider(business.vps_provider);
    if (!providerUsesHostingerLifecycle(provider)) {
      return errorResponse(
        "VALIDATION_ERROR",
        `Only Hostinger-lifecycle boxes can join the adopt pool (provider: ${provider})`
      );
    }

    const vmId = Number.parseInt(business.hostinger_vps_id ?? "", 10);
    if (!Number.isFinite(vmId) || vmId <= 0) {
      return errorResponse("VALIDATION_ERROR", "Business has no Hostinger VPS to release");
    }

    // Stripe guard: this route never touches Stripe, so a linked,
    // not-yet-canceled Stripe subscription (active/past_due billing, or a
    // paid checkout mid-flight in `pending`) must be canceled through the
    // proper flows first — otherwise Stripe keeps charging an account the
    // adopt-time cascade will delete. Stripe-LESS rows carry no payment and
    // pass regardless of status; the cascade below settles them. Uses the
    // SAME any-row predicate as the adopt-time delete guard
    // (listBusinessIdsWithStripeLinkedSubscription) so an older
    // still-linked row can't slip past a newest-row-only check.
    const subscription = await getSubscription(businessId);
    const stripeLinked = await listBusinessIdsWithStripeLinkedSubscription([businessId]);
    if (stripeLinked.has(businessId)) {
      return errorResponse(
        "CONFLICT",
        "A Stripe subscription is still linked and not canceled (active, past_due, or a paid " +
          "checkout mid-flight). Cancel it first (or use Force-cancel & wipe) — releasing the " +
          "box would cascade-delete this account on reuse while Stripe keeps charging.",
        409
      );
    }

    const plan = resolveDeployedVpsSize(business.tier, business.vps_size);
    await releaseVpsToPool({
      vmId,
      plan,
      hostingerBillingSubscriptionId: subscription?.hostinger_billing_subscription_id ?? null,
      notes:
        `released to pool by admin ${admin.email ?? admin.userId} from ${businessId} ` +
        `(${business.name}); the account stays live until a new signup adopts the box, ` +
        `then it is cascade-deleted`
    });

    // Billing cascade 1/2: settle the internal subscription row so the
    // account stops registering as "live" (dashboard, posture cron, admin
    // list). Compare-and-swap: the cancel only lands if the row is STILL
    // Stripe-less at write time — a checkout webhook attaching a Stripe id
    // between our guard read and this write must win, because cancelling a
    // just-paid row would hide its Stripe linkage from the adopt-time
    // delete guard (Bugbot High: linkage masked by admin cancel). No
    // grace_ends_at on purpose — see module header.
    let subscriptionCanceled = false;
    if (subscription && subscription.status !== "canceled") {
      subscriptionCanceled = await cancelSubscriptionIfStripeless(subscription.id);
      if (!subscriptionCanceled) {
        logger.warn(
          "admin.release-vps-to-pool: subscription became Stripe-linked mid-release; NOT cancelled — reconcile before reuse",
          { businessId, subscriptionId: subscription.id }
        );
      }
    }

    // Billing cascade 2/2: park the box's Hostinger billing (pool boxes
    // lapse unless adopted). Best-effort — a Hostinger hiccup must not fail
    // the release; the daily posture check reports still-renewing available
    // boxes as money leaks, which is the retry path.
    let hostingerAutoRenewDisabled = false;
    try {
      const hostinger = new HostingerClient({
        /* c8 ignore next 2 -- trivial env-default fallbacks */
        baseUrl: process.env.HOSTINGER_API_BASE_URL ?? DEFAULT_HOSTINGER_BASE_URL,
        token: process.env.HOSTINGER_API_TOKEN ?? ""
      });
      let billingSubscriptionId = subscription?.hostinger_billing_subscription_id ?? null;
      if (!billingSubscriptionId) {
        const vm = await hostinger.getVirtualMachine(vmId);
        billingSubscriptionId = typeof vm.subscription_id === "string" ? vm.subscription_id : null;
      }
      if (billingSubscriptionId) {
        await hostinger.disableBillingAutoRenewal(billingSubscriptionId);
        hostingerAutoRenewDisabled = true;
      } else {
        logger.warn("admin.release-vps-to-pool: no Hostinger billing subscription resolved", {
          businessId,
          virtualMachineId: vmId
        });
      }
    } catch (err) {
      logger.warn("admin.release-vps-to-pool: disabling Hostinger auto-renew failed (non-fatal)", {
        businessId,
        virtualMachineId: vmId,
        error: err instanceof Error ? err.message : String(err)
      });
    }

    logger.info("admin.release-vps-to-pool: box marked available", {
      adminEmail: admin.email,
      businessId,
      virtualMachineId: vmId,
      plan,
      subscriptionCanceled,
      hostingerAutoRenewDisabled
    });

    return successResponse({
      released: true,
      vmId,
      plan,
      subscriptionCanceled,
      hostingerAutoRenewDisabled
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return errorResponse("VALIDATION_ERROR", err.issues[0].message);
    }
    return handleRouteError(err);
  }
}
