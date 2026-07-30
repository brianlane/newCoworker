/**
 * Grant membership subscription pack add-ons after each paid invoice.
 *
 * Reads compact `addonVoice` / `addonSms` / `addonChat` metadata on the
 * Stripe subscription (stamped at Checkout) and grants through the same
 * RPCs as standalone Billing top-ups. Idempotency key is invoice-scoped so
 * renewals grant fresh allotments without colliding with prior invoices.
 *
 * Also callable from Checkout completion (signup / change-plan) once the
 * local sub is active, using the session's invoice id so a raced
 * `invoice.paid` and `checkout.session.completed` share the same key.
 */

import type Stripe from "stripe";
import type { BillingPeriod } from "@/lib/plans/tier";
import { getStripe } from "@/lib/stripe/client";
import { getSubscription, stripeSubscriptionPeriodCache } from "@/lib/db/subscriptions";
import { logger } from "@/lib/logger";
import {
  parseMembershipPackAddonMetadata,
  sessionHasMembershipPackAddons,
  type MembershipPackAddonMetaEntry
} from "@/lib/billing/membership-pack-addons";

function invoiceExpiresAt(invoice: Stripe.Invoice, periodEnd: Date): Date {
  const createdSec =
    typeof invoice.created === "number" && Number.isFinite(invoice.created)
      ? invoice.created
      : Math.floor(Date.now() / 1000);
  const purchasedAt = new Date(createdSec * 1000);
  const plus30Ms = purchasedAt.getTime() + 30 * 24 * 60 * 60 * 1000;
  return periodEnd.getTime() >= plus30Ms ? periodEnd : new Date(plus30Ms);
}

function sourceIdForGrant(
  invoiceId: string,
  category: "voice" | "sms" | "chat",
  packId: string
): string {
  return `inv_${invoiceId}:${category}:${packId}`;
}

/**
 * Months covered by this Stripe subscription's current cadence.
 * Uses the plan item's recurring interval so term→monthly rollover
 * (ensureCommitmentSchedule) automatically drops the multiplier to 1.
 */
export function commitmentMonthsFromStripeSubscription(
  stripeSubscription: Stripe.Subscription
): number {
  const planItem = stripeSubscription.items?.data?.[0];
  const recurring = planItem?.price?.recurring;
  if (!recurring) return 1;
  if (recurring.interval === "year") {
    return Math.max(1, (recurring.interval_count ?? 1) * 12);
  }
  if (recurring.interval === "month") {
    return Math.max(1, recurring.interval_count ?? 1);
  }
  return 1;
}

function totalGrant(
  entries: MembershipPackAddonMetaEntry[],
  months: number
): { packId: string; amount: number }[] {
  return entries.map((e) => ({
    packId: e.packId,
    amount: e.unitSize * e.quantity * months
  }));
}

function stripeRefId(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value;
  if (value && typeof value === "object" && "id" in value) {
    const id = (value as { id?: unknown }).id;
    return typeof id === "string" && id.trim() ? id : null;
  }
  return null;
}

async function resolveInvoiceForSession(
  session: Stripe.Checkout.Session
): Promise<Stripe.Invoice | null> {
  const stripe = getStripe();
  const invoiceId = stripeRefId(session.invoice);
  if (invoiceId) {
    try {
      return await stripe.invoices.retrieve(invoiceId);
    } catch (err) {
      logger.warn("membership_pack_addon: session invoice retrieve failed", {
        sessionId: session.id,
        invoiceId,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  const subscriptionId = stripeRefId(session.subscription);
  // Callers validate subscription id first; keep this guard for safety.
  /* c8 ignore next */
  if (!subscriptionId) return null;

  try {
    const listed = await stripe.invoices.list({
      subscription: subscriptionId,
      limit: 1
    });
    return listed.data[0] ?? null;
  } catch (err) {
    logger.warn("membership_pack_addon: subscription invoices list failed", {
      sessionId: session.id,
      subscriptionId,
      error: err instanceof Error ? err.message : String(err)
    });
    return null;
  }
}

/**
 * Grant membership pack add-ons for a paid invoice.
 * Safe when metadata has no add-ons (no-op). Idempotent per invoice + pack.
 */
export async function applyMembershipPackAddonsFromInvoice(params: {
  invoice: Stripe.Invoice;
  stripeSubscription: Stripe.Subscription;
  businessId: string;
  /** Ignored for grant sizing; kept for call-site compatibility. */
  billingPeriod?: BillingPeriod;
  eventId: string;
}): Promise<void> {
  const { invoice, stripeSubscription, businessId, eventId } = params;
  const metadata = stripeSubscription.metadata ?? {};
  if (!sessionHasMembershipPackAddons(metadata)) return;

  const entitled =
    stripeSubscription.status === "active" || stripeSubscription.status === "trialing";
  if (!entitled) {
    logger.warn("membership_pack_addon invoice: Stripe subscription not entitled; grant blocked", {
      eventId,
      businessId,
      invoiceId: invoice.id,
      stripeStatus: stripeSubscription.status
    });
    return;
  }

  const subRow = await getSubscription(businessId);
  if (!subRow || subRow.status !== "active") {
    logger.warn("membership_pack_addon invoice: no active local subscription; grant blocked", {
      eventId,
      businessId,
      invoiceId: invoice.id,
      status: subRow?.status ?? null
    });
    return;
  }

  const periodCache = stripeSubscriptionPeriodCache(stripeSubscription);
  const endIso =
    "stripe_current_period_end" in periodCache ? periodCache.stripe_current_period_end : undefined;
  if (!endIso) {
    logger.warn("membership_pack_addon invoice: missing billing period end; grant blocked", {
      eventId,
      businessId,
      invoiceId: invoice.id
    });
    return;
  }

  const months = commitmentMonthsFromStripeSubscription(stripeSubscription);
  const parsed = parseMembershipPackAddonMetadata(metadata);
  const expiresAt = invoiceExpiresAt(invoice, new Date(endIso)).toISOString();
  const { createSupabaseServiceClient } = await import("@/lib/supabase/server");
  const db = await createSupabaseServiceClient();

  for (const { packId, amount } of totalGrant(parsed.voice, months)) {
    /* c8 ignore next */
    if (amount <= 0) continue;
    const sourceId = sourceIdForGrant(invoice.id, "voice", packId);
    const { data, error } = await db.rpc("apply_voice_bonus_grant_from_checkout", {
      p_business_id: businessId,
      p_checkout_session_id: sourceId,
      p_seconds_purchased: amount,
      p_expires_at: expiresAt
    });
    if (error) {
      logger.error("membership_pack_addon voice grant failed", {
        eventId,
        invoiceId: invoice.id,
        businessId,
        packId,
        error: error.message
      });
    } else {
      logger.info("membership_pack_addon voice grant recorded", {
        eventId,
        invoiceId: invoice.id,
        businessId,
        packId,
        voiceSeconds: amount,
        result: data
      });
      const payload = data as { ok?: boolean } | null;
      if (payload?.ok === true) {
        const { error: armErr } = await db.rpc("voice_sync_low_balance_alert_armed_for_business", {
          p_business_id: businessId,
          p_threshold_seconds: 300
        });
        if (armErr) {
          logger.warn("membership_pack_addon voice re-arm failed", {
            businessId,
            error: armErr.message
          });
        }
      }
    }
  }

  for (const { packId, amount } of totalGrant(parsed.sms, months)) {
    /* c8 ignore next */
    if (amount <= 0) continue;
    const sourceId = sourceIdForGrant(invoice.id, "sms", packId);
    const { data, error } = await db.rpc("apply_sms_bonus_grant_from_checkout", {
      p_business_id: businessId,
      p_checkout_session_id: sourceId,
      p_texts_purchased: amount,
      p_expires_at: expiresAt
    });
    if (error) {
      logger.error("membership_pack_addon sms grant failed", {
        eventId,
        invoiceId: invoice.id,
        businessId,
        packId,
        error: error.message
      });
    } else {
      logger.info("membership_pack_addon sms grant recorded", {
        eventId,
        invoiceId: invoice.id,
        businessId,
        packId,
        smsTexts: amount,
        result: data
      });
    }
  }

  for (const { packId, amount } of totalGrant(parsed.chat, months)) {
    /* c8 ignore next */
    if (amount <= 0) continue;
    const sourceId = sourceIdForGrant(invoice.id, "chat", packId);
    const { data, error } = await db.rpc("apply_chat_credit_grant_from_checkout", {
      p_business_id: businessId,
      p_checkout_session_id: sourceId,
      p_credit_micros: amount,
      p_expires_at: expiresAt
    });
    if (error) {
      logger.error("membership_pack_addon chat grant failed", {
        eventId,
        invoiceId: invoice.id,
        businessId,
        packId,
        error: error.message
      });
    } else {
      logger.info("membership_pack_addon chat grant recorded", {
        eventId,
        invoiceId: invoice.id,
        businessId,
        packId,
        creditMicros: amount,
        result: data
      });
    }
  }
}

/**
 * Grant packs after Checkout activates the local subscription.
 * Resolves the session invoice and delegates to the invoice grant path so
 * renewals and first-invoice races share the same idempotency keys.
 */
export async function applyMembershipPackAddonsFromCheckout(
  session: Stripe.Checkout.Session,
  eventId: string
): Promise<void> {
  const metadata = session.metadata ?? {};
  if (!sessionHasMembershipPackAddons(metadata)) return;

  const businessId = metadata.businessId?.trim();
  if (!businessId) {
    logger.warn("membership_pack_addon checkout: missing businessId", {
      eventId,
      sessionId: session.id
    });
    return;
  }

  const subscriptionId = stripeRefId(session.subscription);
  if (!subscriptionId) {
    logger.warn("membership_pack_addon checkout: missing subscription id", {
      eventId,
      sessionId: session.id
    });
    return;
  }

  const invoice = await resolveInvoiceForSession(session);
  if (!invoice) {
    logger.info("membership_pack_addon checkout: no invoice yet; invoice.paid will grant", {
      eventId,
      sessionId: session.id,
      subscriptionId
    });
    return;
  }

  let stripeSubscription: Stripe.Subscription;
  try {
    stripeSubscription = await getStripe().subscriptions.retrieve(subscriptionId);
  } catch (err) {
    logger.error("membership_pack_addon checkout: Stripe subscription retrieve failed", {
      eventId,
      businessId,
      subscriptionId,
      error: err instanceof Error ? err.message : String(err)
    });
    return;
  }

  await applyMembershipPackAddonsFromInvoice({
    invoice,
    stripeSubscription,
    businessId,
    eventId
  });
}
