/**
 * Executor for {@link LifecyclePlan} — the thin side-effectful counterpart
 * to the pure planner in [./lifecycle.ts].
 *
 * The executor is explicitly NOT covered by the planner's table-driven
 * unit tests; it's where all the real network calls live. Testing strategy
 * for this file:
 *   * Integration tests drive the webhook route end-to-end with mocked
 *     Stripe + Hostinger + SSH.
 *   * Manual smoke checklist in the rollout plan (see
 *     subscription_lifecycle_overhaul_6ac4c721.plan.md §Testing).
 *
 * Execution order is fixed and intentional:
 *   1. Stripe ops (refund → cancel, or set-cancel-at-period-end).
 *      We do Stripe FIRST because a Stripe failure is the most recoverable
 *      class of error — if we crash here, the user still has a working VM
 *      and can retry the cancel. If we did VM teardown first, a Stripe
 *      failure would leave us with a dead VM + live Stripe sub.
 *   2. SSH backup (before any Hostinger destruction). If backup fails we
 *      abort the run; keep the VM alive so the user can retry.
 *   3. Hostinger ops: snapshot → stop VM → disable billing auto-renew.
 *   4. DB updates: applied last so the row only reflects reality if all
 *      the above succeeded. Partial-failure states get logged and the
 *      incident should be triaged manually.
 *   5. Emails: fire-and-forget. Failures logged but don't fail the action.
 *
 * We deliberately don't wrap the whole thing in a "rollback on failure"
 * transaction — Stripe refunds are not reversible, and we'd rather crash
 * with a clear log and triage than paper over half-applied state.
 */

import { logger } from "@/lib/logger";
import Stripe from "stripe";
import { getStripe } from "@/lib/stripe/client";
import {
  HostingerClient,
  HostingerApiError,
  DEFAULT_HOSTINGER_BASE_URL
} from "@/lib/hostinger/client";

/* c8 ignore start -- env-var fallbacks: tests inject `deps.hostinger`, so
   neither the missing-base-url nor missing-token branch fires in CI. The
   `??` defaults exist purely so a forgotten Vercel env var surfaces as a
   401 from the Hostinger API (loud) rather than a TypeError on construct
   (cryptic). Keep the branch coverage tax off the global threshold. */
function defaultHostingerClient(): HostingerClient {
  return new HostingerClient({
    baseUrl: process.env.HOSTINGER_API_BASE_URL ?? DEFAULT_HOSTINGER_BASE_URL,
    token: process.env.HOSTINGER_API_TOKEN ?? ""
  });
}
/* c8 ignore stop */
import {
  backupBusinessData,
  deleteBusinessBackup
} from "@/lib/hostinger/data-migration";
import { updateSubscription } from "@/lib/db/subscriptions";
import { markRefundUsed } from "@/lib/db/customer-profiles";
import { recordSubscriptionRefund } from "@/lib/db/subscription-refunds";
import { updateBusinessStatus } from "@/lib/db/businesses";
import { revokeNangoConnectionsForBusiness } from "@/lib/nango/cleanup";
import { releaseVpsToPool } from "@/lib/db/vps-inventory";
import type { VpsSize } from "@/lib/vps/size";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { sendOwnerEmail } from "@/lib/email/client";
import { sendOpsDidReleaseFailedEmail } from "@/lib/email/ops-notify";
import { buildCancelConfirmationEmail } from "@/lib/email/templates/cancel-confirmation";
import { buildRefundIssuedEmail } from "@/lib/email/templates/refund-issued";
import { resolveOwnerUiLocaleForEmail } from "@/lib/i18n/owner-locale";
import {
  buildOpsVpsDeletionEmail,
  opsNotificationEmail
} from "@/lib/email/templates/ops-vps-deletion";
import {
  TelnyxNumbersClient,
  TelnyxApiError
} from "@/lib/telnyx/numbers";
import {
  deleteTelnyxVoiceRoute,
  upsertBusinessTelnyxSettings
} from "@/lib/db/telnyx-routes";
import type {
  DbUpdateOp,
  EmailOp,
  HostingerOp,
  LifecyclePlan,
  OvhOp,
  SshOp,
  StripeOp,
  TelnyxOp
} from "@/lib/billing/lifecycle";
import { CARRIER_REGISTRATION_FEE_NAME } from "@/lib/plans/carrier-fee";

export type ExecutorDeps = {
  stripe?: Stripe;
  hostinger?: HostingerClient;
  sendEmail?: typeof sendOwnerEmail;
  /** Injected in tests; production default reads TELNYX_API_KEY. */
  telnyxNumbers?: TelnyxNumbersClient;
  /**
   * OVH client surface for `ovhOps` (delete-at-expiration). Injected in
   * tests; the production default is lazily built from OVH_* env vars only
   * when a plan actually carries ovhOps.
   */
  ovh?: { setDeleteAtExpiration(serviceName: string, deleteAtExpiration: boolean): Promise<void> };
};

/* c8 ignore start -- env-var construction: tests inject `deps.telnyxNumbers`.
   Returns null (op skipped, loud log) when the key is unset so a missing env
   var degrades a best-effort cleanup instead of crashing the teardown. */
function defaultTelnyxNumbersClient(): TelnyxNumbersClient | null {
  const apiKey = process.env.TELNYX_API_KEY;
  if (!apiKey) return null;
  return new TelnyxNumbersClient({ apiKey });
}
/* c8 ignore stop */

export type ExecutorExtra = {
  /** Forwarded from the lifecycle caller — we need it to locate the latest charge for refunds. */
  customerProfileId?: string | null;
  businessId: string;
  vpsHost: string | null;
};

export type ExecutorResult = {
  /** Populated iff the plan included a refund_latest_charge op that succeeded. */
  refund?: {
    stripeRefundId: string;
    stripeChargeId: string | null;
    amountCents: number;
  };
};

export async function executeLifecyclePlan(
  plan: LifecyclePlan,
  extra: ExecutorExtra,
  deps: ExecutorDeps = {}
): Promise<ExecutorResult> {
  /* v8 ignore next 3 -- production dependency defaults; tests inject network clients/emailer. */
  const stripe = deps.stripe ?? getStripe();
  const hostinger = deps.hostinger ?? defaultHostingerClient();
  const emailer = deps.sendEmail ?? sendOwnerEmail;
  const result: ExecutorResult = {};

  for (const op of plan.stripeOps) {
    await runStripeOp(op, stripe, result);
  }
  for (const op of plan.sshOps) {
    await runSshOp(op);
  }
  for (const op of plan.hostingerOps) {
    await runHostingerOp(op, hostinger);
  }
  for (const op of plan.ovhOps ?? []) {
    await runOvhOp(op, deps.ovh);
  }
  for (const op of plan.telnyxOps) {
    await runTelnyxOp(op, deps.telnyxNumbers);
  }
  for (const op of plan.dbUpdates) {
    await runDbOp(op, extra, result);
  }
  // Emails last and tolerant — don't block the user's cancel path on SMTP.
  for (const op of plan.emailsToSend) {
    try {
      await runEmailOp(op, emailer, result);
    } catch (err) {
      logger.warn("lifecycle email dispatch failed", {
        type: op.type,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }
  return result;
}

/**
 * Split-phase variant of {@link executeLifecyclePlan} for HTTP callers that
 * can't afford to block on minutes-long SSH backups / Hostinger teardown.
 *
 * Runs the "fast" phase synchronously: Stripe ops (refund + cancel, ~1–3s)
 * and DB updates (tens of ms). This is enough to give the user an accurate
 * yes/no answer on whether the refund succeeded and leaves the
 * `subscriptions` row flipped to canceled + grace_ends_at set so the UI
 * reflects the new state immediately.
 *
 * Trade-off vs. the combined executor: in the all-in-one path the DB
 * updates run LAST so the row only reflects reality if all prior ops
 * succeeded. Here we deliberately flip the DB before the slow phase so
 * the HTTP response can return while SSH backup + Hostinger teardown
 * complete in the background. If the slow phase crashes mid-way:
 *   - User's data is still on the VPS (grace-sweep retries the teardown
 *     30 days later as a backstop).
 *   - User sees "canceled, in grace" in the UI, which matches their
 *     intent.
 *   - Stripe refund is already locked in before we respond.
 *
 * Returns the {@link ExecutorResult} so callers can hand it to
 * {@link executeLifecyclePlanSlowPhase} without re-running Stripe ops.
 */
export async function executeLifecyclePlanFastPhase(
  plan: LifecyclePlan,
  extra: ExecutorExtra,
  deps: ExecutorDeps = {}
): Promise<ExecutorResult> {
  /* v8 ignore next -- production dependency default; tests inject a Stripe client. */
  const stripe = deps.stripe ?? getStripe();
  const result: ExecutorResult = {};
  for (const op of plan.stripeOps) {
    await runStripeOp(op, stripe, result);
  }
  for (const op of plan.dbUpdates) {
    // Pool returns are deferred to the slow phase: marking the box
    // `available` before the SSH backup and stop_vm have run would let a
    // concurrent signup claim + recreate a VM whose tenant data hasn't
    // been backed up yet.
    if (op.type === "return_vps_to_pool") continue;
    await runDbOp(op, extra, result);
  }
  return result;
}

/**
 * Complement to {@link executeLifecyclePlanFastPhase}. Runs the slow ops
 * (SSH backup + Hostinger snapshot/stop/cancel + owner emails) AFTER the
 * HTTP response has been returned. Callers MUST pass the {@link
 * ExecutorResult} returned by the fast phase so the email op can
 * surface the Stripe refund amount we already recorded.
 *
 * All errors are logged but swallowed — the DB state is already
 * authoritative from the fast phase, and the grace-sweep will retry any
 * missed Hostinger ops when the grace window elapses.
 */
export async function executeLifecyclePlanSlowPhase(
  plan: LifecyclePlan,
  priorResult: ExecutorResult,
  deps: ExecutorDeps = {}
): Promise<void> {
  /* v8 ignore start -- production dependency defaults; tests inject clients. */
  const hostinger = deps.hostinger ?? defaultHostingerClient();
  const emailer = deps.sendEmail ?? sendOwnerEmail;
  /* v8 ignore stop */
  const result: ExecutorResult = { ...priorResult };
  for (const op of plan.sshOps) {
    try {
      await runSshOp(op);
    } catch (err) {
      logger.error("lifecycle slow-phase ssh op failed", {
        type: op.type,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }
  for (const op of plan.hostingerOps) {
    try {
      await runHostingerOp(op, hostinger);
    } catch (err) {
      logger.error("lifecycle slow-phase hostinger op failed", {
        type: op.type,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }
  for (const op of plan.ovhOps ?? []) {
    try {
      await runOvhOp(op, deps.ovh);
    } catch (err) {
      logger.error("lifecycle slow-phase ovh op failed", {
        type: op.type,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }
  // DID releases run in the slow phase (fast phase skips telnyxOps
  // entirely): they're best-effort network calls the user's HTTP response
  // must never block on, and — like pool returns — they belong after the
  // backup so a mid-teardown crash retried by the grace sweep re-runs them.
  for (const op of plan.telnyxOps) {
    await runTelnyxOp(op, deps.telnyxNumbers);
  }
  // Pool returns run here — AFTER backup + stop_vm — because a box marked
  // `available` is immediately claimable by a concurrent signup, whose
  // adopt path recreates (wipes) the VM. The fast phase skipped these ops.
  for (const op of plan.dbUpdates) {
    if (op.type !== "return_vps_to_pool") continue;
    await runPoolReturnOp(op);
  }
  for (const op of plan.emailsToSend) {
    try {
      await runEmailOp(op, emailer, result);
    } catch (err) {
      logger.warn("lifecycle slow-phase email dispatch failed", {
        type: op.type,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }
}

async function runStripeOp(op: StripeOp, stripe: Stripe, result: ExecutorResult): Promise<void> {
  switch (op.type) {
    case "set_cancel_at_period_end":
      await stripe.subscriptions.update(op.stripeSubscriptionId, {
        cancel_at_period_end: op.cancelAtPeriodEnd,
        proration_behavior: "none"
      });
      return;
    case "cancel_subscription": {
      const sub = await stripe.subscriptions.retrieve(op.stripeSubscriptionId).catch(() => null);
      const rawSchedule: string | Stripe.SubscriptionSchedule | null | undefined = sub?.schedule;
      const scheduleId: string | null = !rawSchedule
        ? null
        : typeof rawSchedule === "string"
          ? rawSchedule
          : rawSchedule.id;
      if (op.releaseSchedule && scheduleId) {
        await stripe.subscriptionSchedules
          .release(scheduleId)
          .catch((err) =>
            logger.warn("stripe schedule release failed; continuing with cancel", {
              scheduleId,
              error: err instanceof Error ? err.message : String(err)
            })
          );
      }
      if (sub && sub.status !== "canceled") {
        await stripe.subscriptions.cancel(op.stripeSubscriptionId, {
          prorate: false,
          invoice_now: false
        });
      }
      return;
    }
    case "refund_latest_charge": {
      const sub = await stripe.subscriptions.retrieve(op.stripeSubscriptionId);
      const latestInvoiceRaw = sub.latest_invoice;
      const latestInvoiceId =
        typeof latestInvoiceRaw === "string" ? latestInvoiceRaw : latestInvoiceRaw?.id ?? null;
      if (!latestInvoiceId) {
        throw new Error(
          `refund_latest_charge: no latest_invoice on subscription ${op.stripeSubscriptionId}`
        );
      }
      const invoice = await stripe.invoices.retrieve(latestInvoiceId);
      const chargeId = await extractChargeIdFromInvoice(invoice, stripe);
      if (!chargeId) {
        throw new Error(
          `refund_latest_charge: no charge on invoice ${latestInvoiceId} (sub ${op.stripeSubscriptionId})`
        );
      }
      const amountPaidCents = invoice.amount_paid ?? invoice.amount_due ?? 0;
      if (amountPaidCents <= 0) {
        logger.info("refund_latest_charge: invoice has zero amount paid; skipping refund", {
          stripeSubscriptionId: op.stripeSubscriptionId,
          invoiceId: latestInvoiceId
        });
        return;
      }
      // The one-time 10DLC carrier-registration pass-through (Phase C3) is
      // non-refundable — the TCR/carrier fees behind it are non-refundable
      // to us and the checkout discloses it. Carve its line(s) out of the
      // 30-day money-back amount.
      //
      // POST-DISCOUNT: Stripe allocates invoice-level coupons (e.g. the
      // monthly-signup intro coupon) proportionally across ALL line items,
      // including this fee line — on Truly Insurance's Jul 2026 invoice the
      // customer effectively paid $14.02 for the $19.50 fee. Carving out the
      // pre-discount `line.amount` would keep more than the customer
      // actually paid for the fee, silently clawing back part of their plan
      // discount. Subtract each fee line's `discount_amounts` so the
      // carve-out matches real dollars paid.
      const carrierFeeCents = (invoice.lines?.data ?? [])
        .filter((line) => (line.description ?? "").includes(CARRIER_REGISTRATION_FEE_NAME))
        .reduce((sum, line) => {
          const discounted = (line.discount_amounts ?? []).reduce(
            (s, d) => s + (d.amount ?? 0),
            0
          );
          return sum + Math.max((line.amount ?? 0) - discounted, 0);
        }, 0);
      // Term-plan policy (Jul 2026): the planner additionally withholds one
      // month at the tier's monthly-intro rate on annual/biennial refunds —
      // see `termRefundCarveOutCents` in lifecycle.ts. Zero for monthly.
      const termCarveOutCents = op.termCarveOutCents;
      // Billable-usage policy (Jul 2026): the tenant's third-party usage
      // charges (SMS, voice, Gemini spend) are withheld at platform cost —
      // computed by the refund route via src/lib/billing/usage-charges.ts
      // and threaded through the op. Zero when the plan never loaded it.
      const usageCarveOutCents = op.usageCarveOutCents;
      const refundCents = Math.min(
        Math.max(amountPaidCents - carrierFeeCents - termCarveOutCents - usageCarveOutCents, 0),
        amountPaidCents
      );
      if (carrierFeeCents > 0 || termCarveOutCents > 0 || usageCarveOutCents > 0) {
        logger.info("refund_latest_charge: carving out non-refundable amounts", {
          stripeSubscriptionId: op.stripeSubscriptionId,
          invoiceId: latestInvoiceId,
          carrierFeeCents,
          termCarveOutCents,
          usageCarveOutCents,
          refundCents
        });
      }
      if (refundCents <= 0) {
        logger.info("refund_latest_charge: nothing refundable after carve-outs", {
          stripeSubscriptionId: op.stripeSubscriptionId,
          invoiceId: latestInvoiceId
        });
        return;
      }
      const refund = await stripe.refunds.create({
        charge: chargeId,
        amount: refundCents,
        reason: "requested_by_customer",
        metadata: {
          newcoworker_reason: op.reason,
          newcoworker_subscription_id: op.stripeSubscriptionId
        }
      });
      result.refund = {
        stripeRefundId: refund.id,
        stripeChargeId: chargeId,
        amountCents: refundCents
      };
      return;
    }
  }
}

async function runSshOp(op: SshOp): Promise<void> {
  switch (op.type) {
    case "backup_durable_data":
      await backupBusinessData({ businessId: op.businessId, vpsHost: op.vpsHost });
      return;
    case "wipe_byos_box": {
      // Terminal BYOS wipe: dynamic import keeps the executor's module
      // graph free of the provisioning stack for the 99% of plans that
      // never touch a BYOS box.
      const { wipeByosBox } = await import("@/lib/provisioning/byos-wipe");
      await wipeByosBox({ businessId: op.businessId, vpsHost: op.vpsHost });
      return;
    }
    case "restore_durable_data":
      // Restore is only dispatched by change-plan & reactivate flows, which
      // run their own provisioning setup and then invoke the helper
      // directly — we don't route restore through the executor here because
      // the new VPS + SSH key info isn't known to the planner.
      logger.warn("restore_durable_data dispatched through executor; expected out-of-band handling", {
        businessId: op.businessId
      });
      return;
  }
}

async function runOvhOp(op: OvhOp, ovh: ExecutorDeps["ovh"]): Promise<void> {
  /* c8 ignore start -- production default builds the client from env; tests inject deps.ovh */
  const client = ovh ?? (await import("@/lib/ovh/client")).ovhClientFromEnv();
  /* c8 ignore stop */
  switch (op.type) {
    case "ovh_delete_at_expiration":
      await client.setDeleteAtExpiration(op.serviceName, true);
      logger.info("OVH service flipped to delete-at-expiration", {
        serviceName: op.serviceName
      });
      return;
  }
}

async function runHostingerOp(op: HostingerOp, client: HostingerClient): Promise<void> {
  switch (op.type) {
    case "create_snapshot":
      await safeHostinger(() => client.createSnapshot(op.virtualMachineId), "create_snapshot");
      return;
    case "delete_snapshot":
      await safeHostinger(
        () => client.deleteSnapshot(op.virtualMachineId),
        "delete_snapshot",
        /* tolerate404 */ true
      );
      return;
    case "stop_vm":
      // Tolerate 404: the grace-expired-wipe backstop re-emits `stop_vm`
      // even when the VM was already deleted manually in hPanel (the ops
      // deletion-request flow). A 404 there is benign — the goal state is
      // achieved.
      await safeHostinger(
        () => client.stopVirtualMachine(op.virtualMachineId),
        "stop_vm",
        /* tolerate404 */ true
      );
      return;
    case "disable_billing_auto_renewal":
      // Hostinger's public cancel-subscription endpoint is gone (404), so
      // disabling auto-renewal is the strongest automated stop-payment we
      // have; the ops deletion-request email covers the manual remainder.
      // Tolerate 404 for subscriptions already deleted in hPanel.
      await safeHostinger(
        () => client.disableBillingAutoRenewal(op.hostingerBillingSubscriptionId),
        "disable_billing_auto_renewal",
        true
      );
      return;
  }
}

async function safeHostinger<T>(
  fn: () => Promise<T>,
  label: string,
  tolerate404 = false
): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    if (tolerate404 && err instanceof HostingerApiError && err.status === 404) {
      logger.info(`hostinger ${label}: 404 ignored (already gone)`, { error: err.message });
      return null;
    }
    // Re-raise so the lifecycle caller can surface the error; Stripe already
    // succeeded so the user is protected from a double-bill.
    throw err;
  }
}

async function runDbOp(
  op: DbUpdateOp,
  _extra: ExecutorExtra,
  result: ExecutorResult
): Promise<void> {
  switch (op.type) {
    case "update_subscription":
      await updateSubscription(op.subscriptionId, op.patch);
      return;
    case "mark_refund_used":
      if (!result.refund) {
        logger.info("mark_refund_used skipped: no Stripe refund was created", {
          profileId: op.profileId
        });
        return;
      }
      await markRefundUsed(op.profileId, new Date(op.at));
      return;
    case "record_refund": {
      // Executor overrides the planner's placeholder ids with the values we
      // got back from Stripe in this same run. If the refund op didn't
      // actually run (e.g. zero-amount invoice) we skip the record.
      const refundData = result.refund ?? {
        stripeRefundId: op.stripeRefundId,
        stripeChargeId: op.stripeChargeId,
        amountCents: op.amountCents ?? 0
      };
      if (!refundData.stripeRefundId) {
        logger.info("record_refund skipped: no stripe refund id resolved", {
          subscriptionId: op.subscriptionId
        });
        return;
      }
      await recordSubscriptionRefund({
        subscriptionId: op.subscriptionId,
        customerProfileId: op.profileId,
        stripeRefundId: refundData.stripeRefundId,
        stripeChargeId: refundData.stripeChargeId,
        amountCents: refundData.amountCents,
        reason: op.reason
      });
      await updateSubscription(op.subscriptionId, {
        stripe_refund_id: refundData.stripeRefundId,
        refund_amount_cents: refundData.amountCents
      });
      return;
    }
    case "mark_business_wiped":
      await updateBusinessStatus(op.businessId, "wiped");
      // Tear down the tenant's Nango workspace connections AFTER the stamp
      // commits (a failed stamp must leave the tenant intact, and the sweep
      // retries the whole op). The wipe KEEPS the business row, so no
      // cascade ever removes these — without this hook each leaked
      // connection consumes account-wide Nango quota forever. Best-effort
      // by contract: a Nango blip never fails the wipe (the audit script
      // reclaims orphans).
      await revokeNangoConnectionsForBusiness(op.businessId);
      return;
    case "delete_auth_user": {
      const db = await createSupabaseServiceClient();
      const { error } = await db.auth.admin.deleteUser(op.supabaseUserId);
      if (error) {
        const message = error.message ?? String(error);
        if (/not found|does not exist/i.test(message)) {
          logger.info("delete_auth_user ignored: user already gone", {
            supabaseUserId: op.supabaseUserId
          });
          return;
        }
        throw new Error(`delete_auth_user: ${message}`);
      }
      return;
    }
    case "delete_backup_artifact":
      try {
        await deleteBusinessBackup(op.businessId);
      } catch (err) {
        logger.warn("delete_backup_artifact failed", {
          businessId: op.businessId,
          error: err instanceof Error ? err.message : String(err)
        });
      }
      return;
    case "return_vps_to_pool":
      await runPoolReturnOp(op);
      return;
  }
}

/**
 * Best-effort DID release: stop the number's monthly rental at Telnyx, then
 * clean up the routing rows. Never throws — a wipe must not fail because a
 * $1.10/mo number couldn't be released (it's operator-recoverable in the
 * Telnyx portal, and the grace-sweep's idempotent retry re-attempts it).
 * A 404 from Telnyx means the number is already gone — the goal state.
 */
async function runTelnyxOp(
  op: TelnyxOp,
  injectedClient?: TelnyxNumbersClient
): Promise<void> {
  const client = injectedClient ?? defaultTelnyxNumbersClient();
  if (!client) {
    logger.warn("release_did skipped: TELNYX_API_KEY missing", {
      businessId: op.businessId,
      e164: op.e164
    });
    // The wipe stamp that follows removes this business from every retry
    // sweep, so a skipped release would silently rent forever — page ops.
    await sendOpsDidReleaseFailedEmail({
      businessId: op.businessId,
      e164: op.e164,
      reason: "TELNYX_API_KEY missing — release never attempted"
    });
    return;
  }
  try {
    try {
      await client.deletePhoneNumber(op.e164);
      logger.info("release_did: DID released at Telnyx", {
        businessId: op.businessId,
        e164: op.e164
      });
    } catch (err) {
      if (err instanceof TelnyxApiError && err.status === 404) {
        logger.info("release_did: DID already gone at Telnyx (404)", {
          businessId: op.businessId,
          e164: op.e164
        });
      } else {
        throw err;
      }
    }
    // Routing cleanup only after the release (or confirmed-gone) so a
    // Telnyx failure leaves the route intact for the retry to find the DID.
    await deleteTelnyxVoiceRoute(op.e164);
    await upsertBusinessTelnyxSettings({
      businessId: op.businessId,
      telnyxSmsFromE164: null
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.error("release_did failed (continuing teardown)", {
      businessId: op.businessId,
      e164: op.e164,
      error: reason
    });
    // Teardown continues (blocking the wipe on a Telnyx outage would break
    // the retention promise), but nothing retries after the wipe stamp —
    // alert ops so the number gets released manually instead of leaking.
    await sendOpsDidReleaseFailedEmail({
      businessId: op.businessId,
      e164: op.e164,
      reason
    });
  }
}

/**
 * Best-effort pool return: vps_inventory is an economics optimization
 * (adopt-first reuse of owned boxes), never a correctness dependency — a
 * pool write failure must not fail the cancel/wipe. Split out of
 * {@link runDbOp} because the split-phase executor runs this op from the
 * SLOW phase (after backup + stop_vm), where no {@link ExecutorExtra} is
 * available.
 */
async function runPoolReturnOp(
  op: Extract<DbUpdateOp, { type: "return_vps_to_pool" }>
): Promise<void> {
  try {
    await releaseVpsToPool({
      vmId: op.virtualMachineId,
      plan: op.plan as VpsSize,
      hostingerBillingSubscriptionId: op.hostingerBillingSubscriptionId,
      notes: op.notes
    });
    logger.info("VPS returned to reuse pool", {
      virtualMachineId: op.virtualMachineId,
      plan: op.plan
    });
  } catch (err) {
    logger.warn("return_vps_to_pool failed", {
      virtualMachineId: op.virtualMachineId,
      error: err instanceof Error ? err.message : String(err)
    });
  }
}

async function runEmailOp(
  op: EmailOp,
  send: typeof sendOwnerEmail,
  result: ExecutorResult
): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    logger.warn("lifecycle email skipped: RESEND_API_KEY missing", { type: op.type });
    return;
  }
  switch (op.type) {
    case "send_cancel_confirmation": {
      const siteUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
      const { subject, text, html } = buildCancelConfirmationEmail({
        reason: op.reason,
        effectiveAt: op.effectiveAt,
        graceEndsAt: op.graceEndsAt,
        recipientEmail: op.toEmail,
        siteUrl,
        ...(op.timeZone ? { timeZone: op.timeZone } : {}),
        locale: await resolveOwnerUiLocaleForEmail(op.toEmail)
      });
      await send(apiKey, op.toEmail, subject, { text, html });
      return;
    }
    case "send_refund_issued": {
      // Only announce a refund that this plan's refund op actually created.
      // The op can no-op (zero-amount invoice, or the whole payment was the
      // non-refundable carrier fee), in which case emailing "your refund is
      // on its way" with the planner's estimate would be a lie.
      if (!result.refund) {
        logger.info("refund email skipped: no Stripe refund was created", {
          businessId: op.businessId
        });
        return;
      }
      const amountCents = result.refund.amountCents;
      const siteUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
      const { subject, text, html } = buildRefundIssuedEmail({
        amountCents,
        recipientEmail: op.toEmail,
        siteUrl,
        locale: await resolveOwnerUiLocaleForEmail(op.toEmail)
      });
      await send(apiKey, op.toEmail, subject, { text, html });
      return;
    }
    case "send_ops_vps_deletion_request": {
      const siteUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
      const toEmail = opsNotificationEmail();
      const { subject, text, html } = buildOpsVpsDeletionEmail({
        businessId: op.businessId,
        virtualMachineId: op.virtualMachineId,
        hostingerBillingSubscriptionId: op.hostingerBillingSubscriptionId,
        ownerName: op.ownerName,
        ownerEmail: op.ownerEmail,
        tier: op.tier,
        signupDate: op.signupDate,
        refundIssued: result.refund !== undefined || op.refundIssued,
        cancelReason: op.cancelReason,
        vmState: op.vmState,
        siteUrl
      });
      await send(apiKey, toEmail, subject, { text, html });
      // Ops audit trail: manual hPanel deletion was requested for this box.
      logger.info("ops VPS deletion request emailed", {
        businessId: op.businessId,
        virtualMachineId: op.virtualMachineId,
        hostingerBillingSubscriptionId: op.hostingerBillingSubscriptionId,
        toEmail
      });
      return;
    }
  }
}

async function extractChargeIdFromInvoice(
  invoice: Stripe.Invoice,
  stripe: Stripe
): Promise<string | null> {
  // Prefer legacy `invoice.charge` when available.
  const maybeCharge = (invoice as unknown as { charge?: string | Stripe.Charge | null }).charge;
  if (typeof maybeCharge === "string") return maybeCharge;
  if (maybeCharge && typeof maybeCharge === "object" && "id" in maybeCharge) {
    return maybeCharge.id;
  }

  // Stripe's 2024+ API moved `charge` off Invoice; the payment_intent on the
  // invoice is what we can reach from here. Retrieve it and use latest_charge.
  const pi = invoice.payments?.data?.[0]?.payment?.payment_intent;
  if (typeof pi === "string") {
    const paymentIntent = await stripe.paymentIntents.retrieve(pi);
    return chargeIdFromPaymentIntent(paymentIntent);
  }
  if (pi && typeof pi === "object") {
    return chargeIdFromPaymentIntent(pi as Stripe.PaymentIntent);
  }
  return null;
}

function chargeIdFromPaymentIntent(paymentIntent: Stripe.PaymentIntent): string | null {
  const latest = paymentIntent.latest_charge;
  if (typeof latest === "string") return latest;
  if (latest && typeof latest === "object") return latest.id;
  const charges = (paymentIntent as unknown as { charges?: { data?: Stripe.Charge[] } }).charges;
  const charge = charges?.data?.[0];
  return charge?.id ?? null;
}

/** Re-export for convenience so callers can compose executor + planner. */
export { planLifecycleAction } from "@/lib/billing/lifecycle";
