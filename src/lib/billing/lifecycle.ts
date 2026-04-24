/**
 * Subscription lifecycle planner.
 *
 * Input: a current subscription snapshot + the profile it belongs to + an
 * action the user (or an automated system) wants to take.
 *
 * Output: a typed {@link LifecyclePlan} describing every side effect that
 * must happen — Stripe calls, Hostinger calls, SSH commands, DB updates,
 * and emails to send. The planner is pure: no network, no I/O, no Date.now
 * unless passed in explicitly via {@link LifecycleContext.now}. This is
 * the heart of deterministic unit tests — one test per action × starting
 * state.
 *
 * The accompanying executor ([./lifecycle-executor.ts]) walks the plan in
 * order and invokes the real clients. Only the planner is tested here;
 * integration tests cover executor + planner.
 *
 * Actions (mirrors the plan file):
 *   * cancelWithRefund            — inside 30-day window, lifetime-once refund
 *   * cancelAtPeriodEnd           — stops auto-renew; stays active till period end
 *   * undoCancelAtPeriodEnd       — re-enables auto-renew; must still be active
 *   * reactivate                  — user produces a fresh checkout during grace
 *   * changePlan                  — upgrade/downgrade (tier and/or billing period)
 *   * autoCancelOnPaymentFailure  — webhook dispatch on invoice.payment_failed
 *   * adminForceCancel            — operator-triggered immediate wipe, no grace
 *   * graceExpiredWipe            — cron-triggered at grace_ends_at
 *
 * See [subscription_lifecycle_overhaul_6ac4c721.plan.md] for the policy and
 * state machine this engine implements.
 */

import type { BillingPeriod, PlanTier } from "@/lib/plans/tier";
import type { CancelReason, SubscriptionRow } from "@/lib/db/subscriptions";
import type { CustomerProfileRow } from "@/lib/db/customer-profiles";
import {
  LIFETIME_SUBSCRIPTION_CAP,
  isWithinLifetimeRefundWindow
} from "@/lib/db/customer-profiles";
import { isCanceledInGrace } from "@/lib/db/subscriptions";

/** 30-day grace window after any cancellation. Centralised so callers stay in sync. */
export const GRACE_WINDOW_DAYS = 30;
export const GRACE_WINDOW_MS = GRACE_WINDOW_DAYS * 24 * 60 * 60 * 1000;

// ───────────────────────────────────────────────────────────────────────
// Plan ops — flat, serialisable, unit-testable shape.
// ───────────────────────────────────────────────────────────────────────

export type StripeOp =
  | {
      type: "cancel_subscription";
      /** Stripe subscription id. We always cancel immediately (invoice.void=false). */
      stripeSubscriptionId: string;
      /** If true, also release the subscription schedule that backs annual/biennial commitments. */
      releaseSchedule?: boolean;
    }
  | {
      type: "set_cancel_at_period_end";
      stripeSubscriptionId: string;
      cancelAtPeriodEnd: boolean;
    }
  | {
      type: "refund_latest_charge";
      stripeSubscriptionId: string;
      /** Lifetime-cap policy (§Q1): refund is issued on the most recent invoice only. */
      reason: "thirty_day_money_back" | "admin_force";
    };

export type HostingerOp =
  | { type: "create_snapshot"; virtualMachineId: number }
  | { type: "delete_snapshot"; virtualMachineId: number }
  | { type: "stop_vm"; virtualMachineId: number }
  | {
      type: "cancel_billing_subscription";
      /** Hostinger billing subscription id (NOT the VM id). */
      hostingerBillingSubscriptionId: string;
    };

export type SshOp =
  | { type: "backup_durable_data"; businessId: string; vpsHost: string }
  | {
      type: "restore_durable_data";
      businessId: string;
      vpsHost: string;
      /** When restoring into a freshly-provisioned VM during change-plan. */
      newSshKeyId?: string;
    };

export type DbUpdateOp =
  | {
      type: "update_subscription";
      subscriptionId: string;
      patch: Partial<SubscriptionRow>;
    }
  | {
      type: "mark_refund_used";
      profileId: string;
      at: string;
    }
  | {
      type: "record_refund";
      subscriptionId: string;
      profileId: string | null;
      /** Stripe refund id comes back from the executor; planner leaves it empty. */
      stripeRefundId: string | null;
      stripeChargeId: string | null;
      amountCents: number | null;
      reason: "thirty_day_money_back" | "admin_force" | "dispute_lost";
    }
  | {
      type: "mark_business_wiped";
      businessId: string;
    }
  | {
      type: "delete_auth_user";
      supabaseUserId: string;
    }
  | {
      type: "delete_backup_artifact";
      businessId: string;
    };

export type EmailOp =
  | {
      type: "send_cancel_confirmation";
      toEmail: string;
      businessId: string;
      reason: CancelReason;
      /** `null` if the cancel is immediate (refund / admin / payment-failure). */
      effectiveAt: string;
      graceEndsAt: string | null;
    }
  | {
      type: "send_refund_issued";
      toEmail: string;
      businessId: string;
      amountCents: number;
    };

export type LifecyclePlan = {
  stripeOps: StripeOp[];
  hostingerOps: HostingerOp[];
  sshOps: SshOp[];
  dbUpdates: DbUpdateOp[];
  emailsToSend: EmailOp[];
};

// ───────────────────────────────────────────────────────────────────────
// Action inputs and context.
// ───────────────────────────────────────────────────────────────────────

export type LifecycleAction =
  | { type: "cancelWithRefund" }
  | { type: "cancelAtPeriodEnd" }
  | { type: "periodEndReached" }
  | { type: "undoCancelAtPeriodEnd" }
  | {
      type: "reactivate";
      /**
       * `undoPeriodEnd` flips cancel_at_period_end=false (still inside the
       * paid period). `resubscribe` produces no plan — the caller must run a
       * fresh checkout and then dispatch `changePlan` or let the webhook
       * handle it. Kept distinct here for readability at the call sites.
       */
      mode: "undoPeriodEnd";
    }
  | {
      type: "changePlan";
      newTier: PlanTier;
      newPeriod: BillingPeriod;
    }
  | { type: "autoCancelOnPaymentFailure" }
  | { type: "adminForceCancel" }
  | { type: "graceExpiredWipe" };

export type LifecycleContext = {
  subscription: SubscriptionRow;
  /** Owner email on the business — used as the send-to address for all emails. */
  ownerEmail: string;
  /** Supabase auth user id of the owner; required only for grace-sweep/force. */
  ownerAuthUserId?: string;
  /** Null when the sub pre-dates the lifecycle rollout; refund window cannot be checked. */
  profile: CustomerProfileRow | null;
  /** Numeric Hostinger VM id for snapshot/stop ops. Null → snapshot/stop ops omitted. */
  virtualMachineId: number | null;
  /** Public IPv4 for the SSH backup/restore. Null → SSH ops omitted. */
  vpsHost: string | null;
  /** Most recent Stripe invoice amount we're likely to refund, for the refund-issued email. */
  lastInvoiceAmountCents?: number | null;
  /** Now, injected so tests can freeze it. */
  now?: Date;
};

export type LifecyclePlanResult =
  | { ok: true; plan: LifecyclePlan }
  | { ok: false; reason: LifecyclePlanError };

export type LifecyclePlanError =
  | "subscription_already_canceled"
  | "subscription_not_active"
  | "subscription_not_in_grace"
  | "subscription_not_cancel_at_period_end"
  | "refund_window_closed"
  | "refund_already_used"
  | "no_hostinger_billing_subscription"
  | "no_stripe_subscription"
  | "lifetime_subscription_cap_reached"
  | "missing_context";

// ───────────────────────────────────────────────────────────────────────
// Planner
// ───────────────────────────────────────────────────────────────────────

export function planLifecycleAction(
  action: LifecycleAction,
  ctx: LifecycleContext
): LifecyclePlanResult {
  switch (action.type) {
    case "cancelWithRefund":
      return planCancelWithRefund(ctx);
    case "cancelAtPeriodEnd":
      return planCancelAtPeriodEnd(ctx);
    case "periodEndReached":
      return planPeriodEndReached(ctx);
    case "undoCancelAtPeriodEnd":
      return planUndoCancelAtPeriodEnd(ctx);
    case "reactivate":
      return planReactivateUndoPeriodEnd(ctx);
    case "changePlan":
      return planChangePlan(action.newTier, action.newPeriod, ctx);
    case "autoCancelOnPaymentFailure":
      return planAutoCancelOnPaymentFailure(ctx);
    case "adminForceCancel":
      return planAdminForceCancel(ctx);
    case "graceExpiredWipe":
      return planGraceExpiredWipe(ctx);
  }
}

// ───────────────────────────────────────────────────────────────────────
// Individual action planners.
// ───────────────────────────────────────────────────────────────────────

function planCancelWithRefund(ctx: LifecycleContext): LifecyclePlanResult {
  const now = ctx.now ?? new Date();
  const { subscription: sub, profile } = ctx;

  if (sub.status !== "active") {
    return { ok: false, reason: "subscription_not_active" };
  }
  if (!profile) {
    // Pre-lifecycle sub with no profile — policy says the refund right is
    // lifetime-once anchored on first_paid_at. We cannot verify that without
    // a profile, so we refuse and the user should use period-end instead.
    return { ok: false, reason: "missing_context" };
  }
  if (profile.refund_used_at) {
    return { ok: false, reason: "refund_already_used" };
  }
  if (!isWithinLifetimeRefundWindow(profile, now)) {
    return { ok: false, reason: "refund_window_closed" };
  }
  if (!sub.stripe_subscription_id) {
    return { ok: false, reason: "no_stripe_subscription" };
  }

  const plan = buildCancelPlan({
    ctx,
    now,
    cancelReason: "user_refund",
    includeRefund: true
  });
  return { ok: true, plan };
}

function planCancelAtPeriodEnd(ctx: LifecycleContext): LifecyclePlanResult {
  const { subscription: sub } = ctx;
  const now = ctx.now ?? new Date();

  if (sub.status !== "active") {
    return { ok: false, reason: "subscription_not_active" };
  }
  if (!sub.stripe_subscription_id) {
    return { ok: false, reason: "no_stripe_subscription" };
  }

  // "End at period end" does NOT destroy the VM; that happens when the
  // period actually ends (handled by webhook -> graceExpiredWipe path, or
  // by the customer.subscription.deleted webhook branching into cancel).
  return {
    ok: true,
    plan: {
      stripeOps: [
        {
          type: "set_cancel_at_period_end",
          stripeSubscriptionId: sub.stripe_subscription_id,
          cancelAtPeriodEnd: true
        }
      ],
      hostingerOps: [],
      sshOps: [],
      dbUpdates: [
        {
          type: "update_subscription",
          subscriptionId: sub.id,
          patch: {
            cancel_at_period_end: true,
            cancel_reason: "user_period_end",
            canceled_at: now.toISOString()
          }
        }
      ],
      emailsToSend: [
        {
          type: "send_cancel_confirmation",
          toEmail: ctx.ownerEmail,
          businessId: sub.business_id,
          reason: "user_period_end",
          effectiveAt: sub.stripe_current_period_end ?? now.toISOString(),
          graceEndsAt: null
        }
      ]
    }
  };
}

function planUndoCancelAtPeriodEnd(ctx: LifecycleContext): LifecyclePlanResult {
  const { subscription: sub } = ctx;
  const now = ctx.now ?? new Date();

  if (sub.status !== "active") {
    return { ok: false, reason: "subscription_not_active" };
  }
  if (!sub.cancel_at_period_end) {
    return { ok: false, reason: "subscription_not_cancel_at_period_end" };
  }
  if (!sub.stripe_subscription_id) {
    return { ok: false, reason: "no_stripe_subscription" };
  }

  return {
    ok: true,
    plan: {
      stripeOps: [
        {
          type: "set_cancel_at_period_end",
          stripeSubscriptionId: sub.stripe_subscription_id,
          cancelAtPeriodEnd: false
        }
      ],
      hostingerOps: [],
      sshOps: [],
      dbUpdates: [
        {
          type: "update_subscription",
          subscriptionId: sub.id,
          patch: {
            cancel_at_period_end: false,
            // Clearing the reason + canceled_at so the audit trail doesn't
            // lie about the sub being mid-cancel once the user reverts.
            cancel_reason: null,
            canceled_at: null
          }
        }
      ],
      emailsToSend: []
    }
  };
}

function planPeriodEndReached(ctx: LifecycleContext): LifecyclePlanResult {
  const { subscription: sub } = ctx;
  const now = ctx.now ?? new Date();

  if (sub.status !== "active") {
    return { ok: false, reason: "subscription_not_active" };
  }
  if (!sub.cancel_at_period_end) {
    return { ok: false, reason: "subscription_not_cancel_at_period_end" };
  }

  return {
    ok: true,
    plan: buildCancelPlan({
      ctx,
      now,
      cancelReason: "user_period_end",
      includeRefund: false,
      skipStripeCancel: true
    })
  };
}

function planReactivateUndoPeriodEnd(ctx: LifecycleContext): LifecyclePlanResult {
  // Same as undoCancelAtPeriodEnd — distinct action name for UI clarity.
  // The grace-period `resubscribe` path is deliberately NOT handled here;
  // it's driven by a fresh Stripe checkout + webhook, not by the planner.
  return planUndoCancelAtPeriodEnd(ctx);
}

function planChangePlan(
  _newTier: PlanTier,
  _newPeriod: BillingPeriod,
  ctx: LifecycleContext
): LifecyclePlanResult {
  const { subscription: sub, profile } = ctx;
  const now = ctx.now ?? new Date();

  // changePlan is only meaningful on an active subscription. Grace-period
  // changes go through the resubscribe checkout instead.
  if (sub.status !== "active") {
    return { ok: false, reason: "subscription_not_active" };
  }
  // Block the abuse cap here too: changePlan counts as a new lifetime
  // (fresh Stripe sub), so the user must still have headroom.
  if (profile && profile.lifetime_subscription_count >= LIFETIME_SUBSCRIPTION_CAP) {
    return { ok: false, reason: "lifetime_subscription_cap_reached" };
  }

  // The bulk of change-plan runs OUTSIDE the planner: the new checkout is
  // driven by the user-facing route, and the new VPS is provisioned by the
  // webhook handler on checkout.session.completed. What the planner covers
  // is the teardown of the OLD sub: backup data, snapshot, stop VM, cancel
  // old Stripe + Hostinger billing. We mark the old sub with
  // cancel_reason='upgrade_switch' so reporting can distinguish it from a
  // real cancellation.
  const ops: LifecyclePlan = {
    stripeOps: [],
    hostingerOps: [],
    sshOps: [],
    dbUpdates: [
      {
        type: "update_subscription",
        subscriptionId: sub.id,
        patch: {
          cancel_reason: "upgrade_switch",
          canceled_at: now.toISOString()
          // status flip to canceled happens once the NEW sub is provisioned
          // and webhooks confirm it; we intentionally don't flip here to
          // avoid a gap where both subs look canceled.
        }
      }
    ],
    emailsToSend: []
  };

  if (ctx.virtualMachineId !== null && ctx.vpsHost !== null) {
    ops.sshOps.push({
      type: "backup_durable_data",
      businessId: sub.business_id,
      vpsHost: ctx.vpsHost
    });
    ops.hostingerOps.push({ type: "create_snapshot", virtualMachineId: ctx.virtualMachineId });
    ops.hostingerOps.push({ type: "stop_vm", virtualMachineId: ctx.virtualMachineId });
  }

  if (sub.stripe_subscription_id) {
    ops.stripeOps.push({
      type: "cancel_subscription",
      stripeSubscriptionId: sub.stripe_subscription_id,
      releaseSchedule: true
    });
  }

  if (sub.hostinger_billing_subscription_id) {
    ops.hostingerOps.push({
      type: "cancel_billing_subscription",
      hostingerBillingSubscriptionId: sub.hostinger_billing_subscription_id
    });
  }

  return { ok: true, plan: ops };
}

function planAutoCancelOnPaymentFailure(ctx: LifecycleContext): LifecyclePlanResult {
  const { subscription: sub } = ctx;
  const now = ctx.now ?? new Date();

  if (sub.status !== "active") {
    // Per plan, pending/failed-initial subs get `discarded` handling in the
    // webhook branch, not here. This planner only handles active → grace.
    return { ok: false, reason: "subscription_not_active" };
  }

  return {
    ok: true,
    plan: buildCancelPlan({
      ctx,
      now,
      cancelReason: "payment_failed",
      includeRefund: false
    })
  };
}

function planAdminForceCancel(ctx: LifecycleContext): LifecyclePlanResult {
  const { subscription: sub } = ctx;
  const now = ctx.now ?? new Date();

  // Admin force-cancel skips the grace window — it's an immediate wipe.
  const plan = buildCancelPlan({
    ctx,
    now,
    cancelReason: "admin_force",
    includeRefund: false,
    // Collapse grace to zero → the grace-sweep will pick it up on the next
    // tick, or the admin endpoint itself kicks the wipe inline.
    graceMs: 0
  });

  // Append the immediate wipe ops so force-cancel is truly terminal even if
  // the grace-sweep doesn't fire before the operator closes the modal.
  if (ctx.ownerAuthUserId) {
    plan.dbUpdates.push({
      type: "delete_auth_user",
      supabaseUserId: ctx.ownerAuthUserId
    });
  }
  plan.dbUpdates.push({
    type: "mark_business_wiped",
    businessId: sub.business_id
  });
  plan.dbUpdates.push({
    type: "delete_backup_artifact",
    businessId: sub.business_id
  });
  if (ctx.virtualMachineId !== null) {
    plan.hostingerOps.push({ type: "delete_snapshot", virtualMachineId: ctx.virtualMachineId });
  }

  return { ok: true, plan };
}

function planGraceExpiredWipe(ctx: LifecycleContext): LifecyclePlanResult {
  const { subscription: sub } = ctx;
  const now = ctx.now ?? new Date();

  // The grace sweep only operates on subs that are canceled, still in grace
  // at the start of the sweep, but whose grace_ends_at has now lapsed. We
  // check a slightly wider condition here: any canceled-with-grace row
  // whose deadline has passed and hasn't been wiped yet.
  const canceledWithGrace =
    sub.status === "canceled" && sub.grace_ends_at !== null && sub.wiped_at === null;
  if (!canceledWithGrace) {
    return { ok: false, reason: "subscription_not_in_grace" };
  }
  if (new Date(sub.grace_ends_at!).getTime() > now.getTime()) {
    return { ok: false, reason: "subscription_not_in_grace" };
  }

  const plan: LifecyclePlan = {
    stripeOps: [],
    hostingerOps: [],
    sshOps: [],
    dbUpdates: [],
    emailsToSend: []
  };

  if (ctx.virtualMachineId !== null) {
    plan.hostingerOps.push({ type: "delete_snapshot", virtualMachineId: ctx.virtualMachineId });
  }
  plan.dbUpdates.push({ type: "delete_backup_artifact", businessId: sub.business_id });
  if (ctx.ownerAuthUserId) {
    plan.dbUpdates.push({ type: "delete_auth_user", supabaseUserId: ctx.ownerAuthUserId });
  }
  plan.dbUpdates.push({
    type: "update_subscription",
    subscriptionId: sub.id,
    patch: { wiped_at: now.toISOString() }
  });
  plan.dbUpdates.push({ type: "mark_business_wiped", businessId: sub.business_id });

  return { ok: true, plan };
}

// ───────────────────────────────────────────────────────────────────────
// Shared cancel builder: cancel & refund + auto-cancel share this skeleton.
// Differences are (a) whether to emit a refund op, (b) the cancel_reason,
// (c) the grace window (admin force collapses it to zero).
// ───────────────────────────────────────────────────────────────────────

function buildCancelPlan(args: {
  ctx: LifecycleContext;
  now: Date;
  cancelReason: CancelReason;
  includeRefund: boolean;
  graceMs?: number;
  skipStripeCancel?: boolean;
}): LifecyclePlan {
  const {
    ctx,
    now,
    cancelReason,
    includeRefund,
    graceMs = GRACE_WINDOW_MS,
    skipStripeCancel = false
  } = args;
  const sub = ctx.subscription;
  const profileId = sub.customer_profile_id ?? ctx.profile?.id ?? null;
  const graceEndsAtIso = new Date(now.getTime() + graceMs).toISOString();

  const plan: LifecyclePlan = {
    stripeOps: [],
    hostingerOps: [],
    sshOps: [],
    dbUpdates: [],
    emailsToSend: []
  };

  // Stripe side: refund (if eligible) before cancel, so we're cancelling a
  // subscription whose charge we already clawed back.
  if (includeRefund && sub.stripe_subscription_id) {
    plan.stripeOps.push({
      type: "refund_latest_charge",
      stripeSubscriptionId: sub.stripe_subscription_id,
      reason: cancelReason === "user_refund" ? "thirty_day_money_back" : "admin_force"
    });
  }
  if (!skipStripeCancel && sub.stripe_subscription_id) {
    plan.stripeOps.push({
      type: "cancel_subscription",
      stripeSubscriptionId: sub.stripe_subscription_id,
      releaseSchedule: true
    });
  }

  // VPS side: always take a Hostinger snapshot + SSH backup BEFORE we stop
  // the VM (so the archive is consistent) and then cancel Hostinger billing.
  if (ctx.vpsHost !== null) {
    plan.sshOps.push({
      type: "backup_durable_data",
      businessId: sub.business_id,
      vpsHost: ctx.vpsHost
    });
  }
  if (ctx.virtualMachineId !== null) {
    plan.hostingerOps.push({ type: "create_snapshot", virtualMachineId: ctx.virtualMachineId });
    plan.hostingerOps.push({ type: "stop_vm", virtualMachineId: ctx.virtualMachineId });
  }
  if (sub.hostinger_billing_subscription_id) {
    plan.hostingerOps.push({
      type: "cancel_billing_subscription",
      hostingerBillingSubscriptionId: sub.hostinger_billing_subscription_id
    });
  }

  // DB side: flip the subscription row and, if refunded, stamp the profile
  // so the lifetime-once guarantee is locked in.
  plan.dbUpdates.push({
    type: "update_subscription",
    subscriptionId: sub.id,
    patch: {
      status: "canceled",
      customer_profile_id: profileId,
      cancel_reason: cancelReason,
      canceled_at: now.toISOString(),
      grace_ends_at: graceEndsAtIso,
      wiped_at: graceMs === 0 ? now.toISOString() : sub.wiped_at,
      vps_stopped_at: ctx.virtualMachineId !== null ? now.toISOString() : null,
      cancel_at_period_end: false
    }
  });
  if (includeRefund && profileId) {
    plan.dbUpdates.push({
      type: "mark_refund_used",
      profileId,
      at: now.toISOString()
    });
    plan.dbUpdates.push({
      type: "record_refund",
      subscriptionId: sub.id,
      profileId,
      // Filled in by the executor after Stripe returns the refund id.
      stripeRefundId: null,
      stripeChargeId: null,
      amountCents: ctx.lastInvoiceAmountCents ?? null,
      reason: cancelReason === "user_refund" ? "thirty_day_money_back" : "admin_force"
    });
  }

  // Email side.
  plan.emailsToSend.push({
    type: "send_cancel_confirmation",
    toEmail: ctx.ownerEmail,
    businessId: sub.business_id,
    reason: cancelReason,
    effectiveAt: now.toISOString(),
    graceEndsAt: graceEndsAtIso
  });
  if (includeRefund) {
    plan.emailsToSend.push({
      type: "send_refund_issued",
      toEmail: ctx.ownerEmail,
      businessId: sub.business_id,
      amountCents: ctx.lastInvoiceAmountCents ?? 0
    });
  }

  return plan;
}

// Re-export grace helper so callers don't have to reach into subscriptions.ts.
export { isCanceledInGrace };
