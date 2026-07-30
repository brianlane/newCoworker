/**
 * Grant membership subscription pack add-ons after each paid invoice.
 *
 * Reads compact `addonVoice` / `addonSms` / `addonChat` metadata on the
 * Stripe subscription (stamped at Checkout) and grants through the same
 * RPCs as standalone Billing top-ups. Idempotency key is invoice-scoped so
 * renewals grant fresh allotments without colliding with prior invoices.
 */

import type Stripe from "stripe";
import type { BillingPeriod } from "@/lib/plans/tier";
import { getSubscription, stripeSubscriptionPeriodCache } from "@/lib/db/subscriptions";
import { logger } from "@/lib/logger";
import {
  grantAmountForPeriod,
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

function totalGrant(
  entries: MembershipPackAddonMetaEntry[],
  period: BillingPeriod
): { packId: string; amount: number }[] {
  return entries.map((e) => ({
    packId: e.packId,
    amount: grantAmountForPeriod(e.unitSize, e.quantity, period)
  }));
}

/**
 * Grant membership pack add-ons for a paid invoice.
 * Safe when metadata has no add-ons (no-op). Idempotent per invoice + pack.
 */
export async function applyMembershipPackAddonsFromInvoice(params: {
  invoice: Stripe.Invoice;
  stripeSubscription: Stripe.Subscription;
  businessId: string;
  billingPeriod: BillingPeriod;
  eventId: string;
}): Promise<void> {
  const { invoice, stripeSubscription, businessId, billingPeriod, eventId } = params;
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
  if (!subRow?.stripe_subscription_id || subRow.status !== "active") {
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

  const parsed = parseMembershipPackAddonMetadata(metadata);
  const expiresAt = invoiceExpiresAt(invoice, new Date(endIso)).toISOString();
  const { createSupabaseServiceClient } = await import("@/lib/supabase/server");
  const db = await createSupabaseServiceClient();

  for (const { packId, amount } of totalGrant(parsed.voice, billingPeriod)) {
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

  for (const { packId, amount } of totalGrant(parsed.sms, billingPeriod)) {
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

  for (const { packId, amount } of totalGrant(parsed.chat, billingPeriod)) {
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
 * @deprecated Membership packs grant on invoice.paid. Kept as a no-op so
 * call sites that still import the Checkout-session helper stay safe.
 */
export async function applyMembershipPackAddonsFromCheckout(
  _session: Stripe.Checkout.Session,
  _eventId: string
): Promise<void> {
  // Intentionally empty: first invoice + renewals grant via
  // applyMembershipPackAddonsFromInvoice to avoid double-grants.
}
