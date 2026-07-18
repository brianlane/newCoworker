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
 *   * autoCancelOnPaymentFailure  — webhook dispatch on invoice.payment_failed
 *   * adminForceCancel            — operator-triggered immediate wipe, no grace
 *   * graceExpiredWipe            — cron-triggered at grace_ends_at
 *
 * See [subscription_lifecycle_overhaul_6ac4c721.plan.md] for the policy and
 * state machine this engine implements.
 */

import type { CancelReason, SubscriptionRow } from "@/lib/db/subscriptions";
import type { CustomerProfileRow } from "@/lib/db/customer-profiles";
import { isWithinLifetimeRefundWindow } from "@/lib/db/customer-profiles";
import { isCanceledInGrace } from "@/lib/db/subscriptions";
import { isVpsSize } from "@/lib/vps/size";
import { providerUsesHostingerLifecycle, resolveVpsProvider } from "@/lib/vps/provider";
import { getPeriodPricing, type BillingPeriod, type PlanTier } from "@/lib/plans/tier";

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
      /**
       * Term-plan refund policy (Jul 2026): annual/biennial customers pay the
       * full term upfront, and the Hostinger box bought for that term is
       * non-refundable to us — so a 30-day money-back on a term plan refunds
       * the term amount MINUS one month at the tier's monthly-intro rate (the
       * service they actually used, priced as if uncommitted). Monthly plans
       * carve out nothing extra (their latest invoice IS one month). Computed
       * at plan time via {@link termRefundCarveOutCents} so the executor
       * stays a dumb subtractor.
       */
      termCarveOutCents: number;
      /**
       * Billable-usage refund policy (Jul 2026): the tenant's third-party
       * usage charges — SMS, voice minutes, Gemini spend — are non-refundable
       * (we already paid the vendors), so they are withheld from the refund
       * at platform cost. Computed by the refund routes via
       * src/lib/billing/usage-charges.ts and threaded through
       * {@link LifecycleContext.billableUsageCents}; the executor stays a
       * dumb subtractor here too.
       */
      usageCarveOutCents: number;
    };

export type HostingerOp =
  | { type: "create_snapshot"; virtualMachineId: number }
  | { type: "delete_snapshot"; virtualMachineId: number }
  | { type: "stop_vm"; virtualMachineId: number }
  | {
      /**
       * Hostinger removed the public cancel-subscription endpoint (DELETE
       * /api/billing/v1/subscriptions/{id} now 404s — verified Jul 2026), so
       * the closest automated stop-payment we have is disabling auto-renewal.
       * The VM keeps running until the paid period lapses; actual deletion is
       * manual via hPanel, requested through `send_ops_vps_deletion_request`.
       */
      type: "disable_billing_auto_renewal";
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
    }
  | {
      /**
       * Terminal wipe of a CUSTOMER-owned (BYOS) box: remove every platform
       * container, directory, and `.env` secret over SSH and hand the box
       * back to its owner. Emitted only by the grace-expired wipe for
       * `vps_provider='byos'` tenants — the BYOS replacement for stop_vm +
       * pool return + hPanel deletion.
       */
      type: "wipe_byos_box";
      businessId: string;
      vpsHost: string;
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
    }
  | {
      /**
       * Return the tenant's box to the `vps_inventory` reuse pool (fleet
       * economics Phase B). Hostinger boxes are non-refundable for us until
       * ≈Dec 30 2026, so a canceled tenant's VM stays owned — pooling it
       * lets the next matching-size signup adopt it instead of purchasing.
       * Best-effort in the executor: a pool write failure never fails the
       * cancel.
       */
      type: "return_vps_to_pool";
      virtualMachineId: number;
      /** Hardware SKU for the adopt-first match (kvm2/kvm8). */
      plan: string;
      hostingerBillingSubscriptionId: string | null;
      notes: string;
    };

export type TelnyxOp = {
  /**
   * Release the tenant's DID back to Telnyx, stopping its ~$1.10/mo rental.
   * Emitted ONLY by terminal paths (grace-expired wipe, admin force-cancel):
   * a cancel that still has a live grace window keeps the number so a
   * reactivating tenant gets their business line back. The executor runs
   * this in the slow phase, best-effort with 404 tolerance (number already
   * released), and also removes the `telnyx_voice_routes` row + clears the
   * SMS from-number so no routing artifacts survive the wipe.
   */
  type: "release_did";
  e164: string;
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
      /** IANA timezone for date rendering; null → runtime default (UTC). */
      timeZone: string | null;
    }
  | {
      type: "send_refund_issued";
      toEmail: string;
      businessId: string;
      amountCents: number;
    }
  | {
      /**
       * Ops notification to team@newcoworker.com: Hostinger VPS deletion is
       * manual-only (the public cancel API is gone), so every cancel/refund
       * that should tear a box down emails the operator with the hPanel
       * deletion request. See fleet_economics_and_tier_relaunch plan §Phase A.
       */
      type: "send_ops_vps_deletion_request";
      businessId: string;
      /** Numeric Hostinger VM id; null when the sub never had a VM recorded. */
      virtualMachineId: number | null;
      hostingerBillingSubscriptionId: string | null;
      ownerName: string | null;
      ownerEmail: string;
      tier: string;
      /** ISO date the subscription row was created (signup). */
      signupDate: string;
      refundIssued: boolean;
      cancelReason: CancelReason;
      /** Human-readable VM state at plan time, e.g. "stopped, auto-renew disabled". */
      vmState: string;
    };

/**
 * OVH-side lifecycle ops (platform-owned Canada boxes). Optional on the
 * plan so the vast majority of (Hostinger) plans — and their test
 * fixtures — never mention it.
 */
export type OvhOp = {
  /**
   * Stop paying for the OVH box: flip the service to delete-at-expiration.
   * OVH's analog of Hostinger's disable-billing-auto-renewal — immediate
   * termination requires an emailed confirmation token, so the automated
   * lever is "lapse at period end". Idempotent (re-flipping is a no-op).
   */
  type: "ovh_delete_at_expiration";
  serviceName: string;
};

export type LifecyclePlan = {
  stripeOps: StripeOp[];
  hostingerOps: HostingerOp[];
  /** Present only on plans for `vps_provider='ovh'` tenants. */
  ovhOps?: OvhOp[];
  sshOps: SshOp[];
  telnyxOps: TelnyxOp[];
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
       * `undoPeriodEnd` flips cancel_at_period_end=false while the
       * subscription is still inside the paid period.
       */
      mode: "undoPeriodEnd";
    }
  | { type: "autoCancelOnPaymentFailure" }
  | { type: "adminForceCancel" }
  | { type: "graceExpiredWipe" };

export type LifecycleContext = {
  subscription: SubscriptionRow;
  /** Owner email on the business — used as the send-to address for all emails. */
  ownerEmail: string;
  /** Owner display name from the business row, for the ops deletion email. */
  ownerName?: string | null;
  /**
   * IANA timezone of the business, for rendering dates in emails (which have
   * no "viewer" timezone). Null/omitted → emails fall back to the runtime
   * default (UTC in production).
   */
  businessTimezone?: string | null;
  /** Supabase auth user id of the owner; required only for grace-sweep/force. */
  ownerAuthUserId?: string;
  /** Null when the sub pre-dates the lifecycle rollout; refund window cannot be checked. */
  profile: CustomerProfileRow | null;
  /** Numeric Hostinger VM id for snapshot/stop ops. Null → snapshot/stop ops omitted. */
  virtualMachineId: number | null;
  /**
   * Raw `businesses.vps_size` hardware pin (kvm2/kvm8 or null → tier
   * default). Drives the `return_vps_to_pool` op's size label so the
   * adopt-first match reuses the box for a same-size signup.
   */
  vpsSize?: string | null;
  /**
   * Raw `businesses.vps_provider` value (null/omitted → 'hostinger' via
   * resolveVpsProvider). Non-hostinger boxes (customer-owned BYOS,
   * OVH Canada) get NONE of the Hostinger lifecycle: no snapshot/stop VM
   * ops, no Hostinger billing auto-renew op, no `vps_inventory` pool
   * return, no hPanel deletion-request email. The SSH backup op still
   * applies (any reachable box can be backed up).
   */
  vpsProvider?: string | null;
  /**
   * OVH service name (from `businesses.hostinger_vps_id` — the generic box
   * id column) when the provider is 'ovh'. Drives the
   * `ovh_delete_at_expiration` op; null/omitted skips it.
   */
  ovhServiceName?: string | null;
  /** Public IPv4 for the SSH backup/restore. Null → SSH ops omitted. */
  vpsHost: string | null;
  /**
   * The tenant's DID (from `telnyx_voice_routes`), so terminal wipes can
   * release it at Telnyx. Null/omitted → no DID recorded, release op omitted.
   */
  didE164?: string | null;
  /** Most recent Stripe invoice amount we're likely to refund, for the refund-issued email. */
  lastInvoiceAmountCents?: number | null;
  /**
   * The tenant's billable third-party usage since the refunded invoice's
   * period start, priced at platform cost (src/lib/billing/usage-charges.ts).
   * Computed by the refund routes (cancel / admin force-refund) — the
   * planner stays pure and just threads it into the refund op. Null/omitted
   * → 0 (non-refund plans never load it).
   */
  billableUsageCents?: number | null;
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
  /* v8 ignore next -- tests use explicit clocks; runtime default is a deterministic fallback. */
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
  /* v8 ignore next -- tests use explicit clocks; runtime default is a deterministic fallback. */
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
      telnyxOps: [],
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
          graceEndsAt: null,
          timeZone: ctx.businessTimezone ?? null
        }
      ]
    }
  };
}

function planUndoCancelAtPeriodEnd(ctx: LifecycleContext): LifecyclePlanResult {
  const { subscription: sub } = ctx;
  /* v8 ignore next -- tests use explicit clocks; runtime default is a deterministic fallback. */
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
      telnyxOps: [],
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
  /* v8 ignore next -- tests use explicit clocks; runtime default is a deterministic fallback. */
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

function planAutoCancelOnPaymentFailure(ctx: LifecycleContext): LifecyclePlanResult {
  const { subscription: sub } = ctx;
  /* v8 ignore next -- tests use explicit clocks; runtime default is a deterministic fallback. */
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
  /* v8 ignore next -- tests use explicit clocks; runtime default is a deterministic fallback. */
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
  //
  // We deliberately DO NOT append delete_snapshot / delete_backup_artifact
  // here: admin force-cancel takes a final backup + Hostinger snapshot
  // (promised to the operator by DeleteClientButton's "takes a final SSH
  // backup + snapshot" copy) so those artifacts stay available for
  // audit/recovery. The grace-expired wipe path — not admin force — is the
  // one that cleans those artifacts up after the 30-day retention window.
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

  // Force-cancel is terminal (no grace, no reactivation), so the tenant's
  // DID is released immediately — otherwise it rents at Telnyx forever.
  if (ctx.didE164) {
    plan.telnyxOps.push({
      type: "release_did",
      e164: ctx.didE164,
      businessId: sub.business_id
    });
  }

  return { ok: true, plan };
}

function planGraceExpiredWipe(ctx: LifecycleContext): LifecyclePlanResult {
  const { subscription: sub } = ctx;
  /* v8 ignore next -- tests use explicit clocks; runtime default is a deterministic fallback. */
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
    telnyxOps: [],
    dbUpdates: [],
    emailsToSend: []
  };

  // Non-hostinger boxes (BYOS / OVH) skip every Hostinger-specific op —
  // see the LifecycleContext.vpsProvider docstring.
  const vpsProvider = resolveVpsProvider(ctx.vpsProvider);
  const hostingerManaged = providerUsesHostingerLifecycle(vpsProvider);

  // BYOS terminal action: the box belongs to the customer, so instead of
  // stop_vm/pool-return/hPanel-deletion we wipe the platform stack + secrets
  // off it over SSH and hand it back. Skipped when the box host is unknown
  // (unreachable box → the grace-sweep retries on its next tick).
  if (vpsProvider === "byos" && ctx.vpsHost !== null) {
    plan.sshOps.push({
      type: "wipe_byos_box",
      businessId: sub.business_id,
      vpsHost: ctx.vpsHost
    });
  }

  // OVH backstop: re-flip delete-at-expiration in case the cancel path that
  // produced this grace row skipped it (manual Stripe cancel, failed
  // dispatch). Idempotent, same rationale as the Hostinger backstop below.
  if (vpsProvider === "ovh" && ctx.ovhServiceName) {
    plan.ovhOps = [
      { type: "ovh_delete_at_expiration", serviceName: ctx.ovhServiceName }
    ];
  }

  // Backstop teardown: if the cancel path that produced this grace row
  // skipped the VPS teardown (e.g. manual operator cancel in the Stripe
  // Dashboard, or an `autoCancelOnPaymentFailure` dispatch that failed
  // before the fire-and-forget ran), the VM is still running and
  // Hostinger billing is still charging at grace-end. The sweep is our
  // only backstop — emit `stop_vm` + `disable_billing_auto_renewal` here
  // so VPS compute stops and Hostinger billing lapses at its period end
  // regardless of which cancel path got us here. Both ops are idempotent
  // via 404-tolerance in the executor, so re-running against an already
  // torn-down VPS is benign. Actual VM deletion is manual (hPanel), so we
  // also re-send the ops deletion request below.
  if (hostingerManaged && ctx.virtualMachineId !== null) {
    plan.hostingerOps.push({ type: "stop_vm", virtualMachineId: ctx.virtualMachineId });
  }
  if (hostingerManaged && sub.hostinger_billing_subscription_id) {
    plan.hostingerOps.push({
      type: "disable_billing_auto_renewal",
      hostingerBillingSubscriptionId: sub.hostinger_billing_subscription_id
    });
  }
  if (hostingerManaged && ctx.virtualMachineId !== null) {
    plan.hostingerOps.push({ type: "delete_snapshot", virtualMachineId: ctx.virtualMachineId });
    // Pool the box (idempotent upsert — the cancel path usually already
    // did this; wipes reached via the manual-Stripe-cancel backstop haven't).
    plan.dbUpdates.push({
      type: "return_vps_to_pool",
      virtualMachineId: ctx.virtualMachineId,
      plan: pooledPlanFor(sub.tier, ctx.vpsSize),
      hostingerBillingSubscriptionId: sub.hostinger_billing_subscription_id,
      notes: `returned by grace-expired wipe of business ${sub.business_id}; auto-renew off — lapses at period end unless adopted`
    });
  }
  // Stamp `wiped_at` BEFORE deleting the durable backup artifact. Order
  // matters here because both `runResubscribeFromCheckout` (in
  // `change-plan-orchestrator.ts`) and `isCanceledInGrace` (in
  // `subscriptions.ts`) treat `wiped_at !== null` as the authoritative
  // "this row's data is gone" signal — the resubscribe orchestrator's
  // pre-flight `isCanceledInGrace(oldSub)` guard AND its final
  // `updateSubscriptionIfNotWiped` write both key on it. If we ran the
  // backup-delete first and then crashed (Vercel timeout, transient
  // Supabase Storage error, executor exception) before stamping
  // `wiped_at`, a customer who reactivated during that crash window
  // could pass both guards, get provisioned, see `restoreBusinessData`
  // throw "no backup recorded" (which the orchestrator currently
  // catches and logs), and end up with an empty workspace they were
  // charged for — silent data loss. Reordering closes that race
  // because a partial-execute now leaves `wiped_at` stamped, so both
  // the orchestrator's isCanceledInGrace guard and the
  // `updateSubscriptionIfNotWiped` server-side conditional refuse the
  // resubscribe with a loud abort log instead of silently
  // provisioning empty data.
  //
  // Trade-off: if `delete_backup_artifact` later fails, we have an
  // orphan Supabase Storage object. That's storage cost but no
  // correctness issue — subsequent grace-sweep cron runs are
  // idempotent and will retry the delete (the executor logs but
  // does not throw on `delete_backup_artifact` errors so the rest of
  // the wipe proceeds).
  plan.dbUpdates.push({
    type: "update_subscription",
    subscriptionId: sub.id,
    patch: { wiped_at: now.toISOString() }
  });
  plan.dbUpdates.push({ type: "delete_backup_artifact", businessId: sub.business_id });
  if (ctx.ownerAuthUserId) {
    plan.dbUpdates.push({ type: "delete_auth_user", supabaseUserId: ctx.ownerAuthUserId });
  }
  plan.dbUpdates.push({ type: "mark_business_wiped", businessId: sub.business_id });

  // The grace window is over — nobody can reactivate this subscription, so
  // release the DID at Telnyx now. Numbers deliberately survive the whole
  // grace period (a reactivating tenant keeps their business line, worth
  // the ~$1.10/mo hold) and are only let go at this terminal wipe.
  // Idempotent: the executor tolerates 404 (already released).
  if (ctx.didE164) {
    plan.telnyxOps.push({
      type: "release_did",
      e164: ctx.didE164,
      businessId: sub.business_id
    });
  }

  // Re-request the manual hPanel deletion at wipe time: either the original
  // cancel-path email was already actioned (this one 404s harmlessly when the
  // operator checks) or the box is still alive and this is the last automated
  // reminder before we stop tracking the subscription. Hostinger-only —
  // there is no hPanel entry for BYOS/OVH boxes.
  if (
    hostingerManaged &&
    (ctx.virtualMachineId !== null || sub.hostinger_billing_subscription_id)
  ) {
    plan.emailsToSend.push({
      type: "send_ops_vps_deletion_request",
      businessId: sub.business_id,
      virtualMachineId: ctx.virtualMachineId,
      hostingerBillingSubscriptionId: sub.hostinger_billing_subscription_id,
      ownerName: ctx.ownerName ?? null,
      ownerEmail: ctx.ownerEmail,
      tier: sub.tier,
      signupDate: sub.created_at,
      // A cancel-with-refund earlier in this subscription's life stamps
      // stripe_refund_id; reflect that so the wipe-time reminder email
      // doesn't misreport "no Stripe refund" to the operator.
      refundIssued: sub.stripe_refund_id !== null,
      cancelReason: sub.cancel_reason ?? "user_period_end",
      vmState: "grace expired — VM stopped, snapshot deleted, auto-renew disabled"
    });
  }

  return { ok: true, plan };
}

/**
 * Hardware SKU label for the `return_vps_to_pool` op. Prefers the explicit
 * `businesses.vps_size` pin; falls back to the HISTORICAL tier default
 * (starter→kvm2, everything else→kvm8) so a corrupt/missing pin can never
 * mislabel inventory as an un-adoptable size.
 *
 * The fallback deliberately stays kvm2 for starter even though the tier
 * default is now kvm1: every kvm1-era box is recorded in vps_inventory at
 * purchase/adopt time (releaseVpsToPool keeps the recorded plan), so this
 * label only ever seeds PRE-inventory starter boxes — which are all kvm2
 * hardware.
 */
function pooledPlanFor(tier: string, vpsSize: string | null | undefined): string {
  if (isVpsSize(vpsSize)) return vpsSize;
  return tier === "starter" ? "kvm2" : "kvm8";
}

// ───────────────────────────────────────────────────────────────────────
/**
 * How much of a term invoice is withheld from the 30-day money-back refund
 * ON TOP of the non-refundable carrier fee.
 *
 * Policy (Jul 2026 "middle path"): the guarantee stays on every plan, but a
 * term customer who exits inside 30 days pays for the service they consumed
 * at the UNCOMMITTED price — one month at the tier's monthly-intro rate —
 * instead of keeping the term discount on a contract they didn't complete.
 * Rationale: term signups fund a prepaid 1/2-year Hostinger box that is
 * non-refundable to the platform; this caps the worst case near one month
 * of revenue (plus a poolable box) without dropping the guarantee.
 *
 * Monthly plans return 0 — their latest invoice already IS one month, so
 * the existing carrier-fee carve-out is the only withholding. Enterprise
 * pricing is deal-based (`monthlyCents: 0`), so this returns 0 there too;
 * enterprise refunds remain operator judgment via admin force-refund.
 */
export function termRefundCarveOutCents(
  tier: PlanTier,
  billingPeriod: BillingPeriod | null
): number {
  if (!billingPeriod || billingPeriod === "monthly") return 0;
  return getPeriodPricing(tier, "monthly").monthlyCents;
}

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
  // Non-hostinger boxes (BYOS / OVH) skip every Hostinger-specific op —
  // see the LifecycleContext.vpsProvider docstring.
  const cancelVpsProvider = resolveVpsProvider(ctx.vpsProvider);
  const hostingerManaged = providerUsesHostingerLifecycle(cancelVpsProvider);

  const plan: LifecyclePlan = {
    stripeOps: [],
    hostingerOps: [],
    sshOps: [],
    telnyxOps: [],
    dbUpdates: [],
    emailsToSend: []
  };

  // OVH box: stop paying by flipping delete-at-expiration (the automated
  // analog of Hostinger's disable-auto-renew below).
  if (cancelVpsProvider === "ovh" && ctx.ovhServiceName) {
    plan.ovhOps = [
      { type: "ovh_delete_at_expiration", serviceName: ctx.ovhServiceName }
    ];
  }

  // Stripe side: refund (if eligible) before cancel, so we're cancelling a
  // subscription whose charge we already clawed back.
  if (includeRefund && sub.stripe_subscription_id) {
    plan.stripeOps.push({
      type: "refund_latest_charge",
      stripeSubscriptionId: sub.stripe_subscription_id,
      reason: "thirty_day_money_back",
      termCarveOutCents: termRefundCarveOutCents(sub.tier, sub.billing_period),
      usageCarveOutCents: ctx.billableUsageCents ?? 0
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
  // the VM (so the archive is consistent), then disable Hostinger auto-renew
  // (the closest automated stop-payment now that the cancel API is gone).
  if (ctx.vpsHost !== null) {
    plan.sshOps.push({
      type: "backup_durable_data",
      businessId: sub.business_id,
      vpsHost: ctx.vpsHost
    });
  }
  if (hostingerManaged && ctx.virtualMachineId !== null) {
    plan.hostingerOps.push({ type: "create_snapshot", virtualMachineId: ctx.virtualMachineId });
    plan.hostingerOps.push({ type: "stop_vm", virtualMachineId: ctx.virtualMachineId });
  }
  if (hostingerManaged && sub.hostinger_billing_subscription_id) {
    plan.hostingerOps.push({
      type: "disable_billing_auto_renewal",
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
      // Coalesce vps_stopped_at so an idempotent retry (VM already gone,
      // ctx.virtualMachineId null) doesn't erase the accurate earlier stamp
      // produced on the first run. Only Hostinger boxes are actually
      // stopped by this plan — a BYOS/OVH cancel must not claim a stop
      // that never happened.
      vps_stopped_at:
        hostingerManaged && ctx.virtualMachineId !== null
          ? now.toISOString()
          : sub.vps_stopped_at,
      cancel_at_period_end: false,
      // Invalidate the cached Stripe billing-period bounds on cancel so the
      // Edge voice inbound's `cacheLooksValidForQuotaAfterJitFailure` path
      // cannot keep reserving minutes against a stale period after the
      // subscription is terminated. Mirrors the fallback write in the
      // `customer.subscription.deleted` webhook branch — without this, a
      // cancel_at_period_end sub that hits `periodEndReached` here would
      // leave the cache looking live until period_end elapses naturally.
      stripe_current_period_start: null,
      stripe_current_period_end: null
    }
  });
  // Fleet economics Phase B: the box stays owned (Hostinger refunds are
  // locked out until ≈Dec 30 2026), so return it to the reuse pool for the
  // next matching-size signup to adopt. The executor treats this write as
  // best-effort; the ops deletion email below still goes out so the
  // operator knows the box exists and can delete it in hPanel instead if
  // the pool doesn't need it. Hostinger-only: a customer-owned BYOS box or
  // an OVH box must never enter the Hostinger reuse pool.
  if (hostingerManaged && ctx.virtualMachineId !== null) {
    plan.dbUpdates.push({
      type: "return_vps_to_pool",
      virtualMachineId: ctx.virtualMachineId,
      plan: pooledPlanFor(sub.tier, ctx.vpsSize),
      hostingerBillingSubscriptionId: sub.hostinger_billing_subscription_id,
      notes: `returned by ${cancelReason} cancel of business ${sub.business_id}; auto-renew off — lapses at period end unless adopted`
    });
  }
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
      reason: "thirty_day_money_back"
    });
  }

  // Email side.
  plan.emailsToSend.push({
    type: "send_cancel_confirmation",
    toEmail: ctx.ownerEmail,
    businessId: sub.business_id,
    reason: cancelReason,
    effectiveAt: now.toISOString(),
    graceEndsAt: graceEndsAtIso,
    timeZone: ctx.businessTimezone ?? null
  });
  if (includeRefund) {
    plan.emailsToSend.push({
      type: "send_refund_issued",
      toEmail: ctx.ownerEmail,
      businessId: sub.business_id,
      amountCents: ctx.lastInvoiceAmountCents ?? 0
    });
  }
  // Hostinger deletion is manual-only (panel): every cancel that tears a box
  // down asks ops to finish the job in hPanel. Non-hostinger boxes have no
  // hPanel entry to delete — their teardown is provider-specific (BYOS SSH
  // wipe / OVH service termination).
  if (
    hostingerManaged &&
    (ctx.virtualMachineId !== null || sub.hostinger_billing_subscription_id)
  ) {
    plan.emailsToSend.push({
      type: "send_ops_vps_deletion_request",
      businessId: sub.business_id,
      virtualMachineId: ctx.virtualMachineId,
      hostingerBillingSubscriptionId: sub.hostinger_billing_subscription_id,
      ownerName: ctx.ownerName ?? null,
      ownerEmail: ctx.ownerEmail,
      tier: sub.tier,
      signupDate: sub.created_at,
      // Whether a Stripe refund actually lands is only known at execution
      // time (refund_latest_charge skips zero-amount invoices), so report
      // only refunds already recorded on the row; the executor ORs in the
      // outcome of this plan's own refund op.
      refundIssued: sub.stripe_refund_id !== null,
      cancelReason,
      vmState: [
        ctx.virtualMachineId !== null ? "VM stopped" : "no VM recorded",
        sub.hostinger_billing_subscription_id
          ? "auto-renew disabled"
          : "no Hostinger billing id"
      ].join(", ")
    });
  }

  return plan;
}

// Re-export grace helper so callers don't have to reach into subscriptions.ts.
export { isCanceledInGrace };
