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
 *   3. Hostinger ops: snapshot → stop VM → cancel billing.
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

function defaultHostingerClient(): HostingerClient {
  return new HostingerClient({
    baseUrl: process.env.HOSTINGER_API_BASE_URL ?? DEFAULT_HOSTINGER_BASE_URL,
    token: process.env.HOSTINGER_API_TOKEN ?? ""
  });
}
import {
  backupBusinessData,
  deleteBusinessBackup
} from "@/lib/hostinger/data-migration";
import { updateSubscription } from "@/lib/db/subscriptions";
import { markRefundUsed } from "@/lib/db/customer-profiles";
import { recordSubscriptionRefund } from "@/lib/db/subscription-refunds";
import { updateBusinessStatus } from "@/lib/db/businesses";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { sendOwnerEmail } from "@/lib/email/client";
import { buildCancelConfirmationEmail } from "@/lib/email/templates/cancel-confirmation";
import { buildRefundIssuedEmail } from "@/lib/email/templates/refund-issued";
import type {
  DbUpdateOp,
  EmailOp,
  HostingerOp,
  LifecyclePlan,
  SshOp,
  StripeOp
} from "@/lib/billing/lifecycle";

export type ExecutorDeps = {
  stripe?: Stripe;
  hostinger?: HostingerClient;
  sendEmail?: typeof sendOwnerEmail;
};

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
      const refund = await stripe.refunds.create({
        charge: chargeId,
        amount: amountPaidCents,
        reason: "requested_by_customer",
        metadata: {
          newcoworker_reason: op.reason,
          newcoworker_subscription_id: op.stripeSubscriptionId
        }
      });
      result.refund = {
        stripeRefundId: refund.id,
        stripeChargeId: chargeId,
        amountCents: amountPaidCents
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
      await safeHostinger(() => client.stopVirtualMachine(op.virtualMachineId), "stop_vm");
      return;
    case "cancel_billing_subscription":
      await safeHostinger(
        () => client.cancelBillingSubscription(op.hostingerBillingSubscriptionId),
        "cancel_billing_subscription",
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
      const { subject, text } = buildCancelConfirmationEmail({
        reason: op.reason,
        effectiveAt: op.effectiveAt,
        graceEndsAt: op.graceEndsAt
      });
      await send(apiKey, op.toEmail, subject, text);
      return;
    }
    case "send_refund_issued": {
      const amountCents = result.refund?.amountCents ?? op.amountCents;
      if (!result.refund && amountCents <= 0) {
        logger.info("refund email skipped: no Stripe refund was created", {
          businessId: op.businessId
        });
        return;
      }
      const { subject, text } = buildRefundIssuedEmail({ amountCents });
      await send(apiKey, op.toEmail, subject, text);
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
