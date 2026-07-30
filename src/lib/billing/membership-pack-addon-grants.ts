/**
 * Apply membership Checkout pack add-ons after the subscription is active.
 *
 * Reads `addonVoice*` / `addonSms*` / `addonChat*` metadata stamped by
 * `resolveMembershipPackAddons` and grants through the same RPCs as
 * standalone Billing top-ups (idempotent on checkout session id).
 */

import type Stripe from "stripe";
import { getStripe } from "@/lib/stripe/client";
import { getSubscription } from "@/lib/db/subscriptions";
import { stripeSubscriptionPeriodCache } from "@/lib/db/subscriptions";
import { logger } from "@/lib/logger";
import {
  parseChatCreditMicrosFromMetadata,
  parseSmsBonusTextsFromMetadata,
  parseVoiceBonusSecondsFromMetadata
} from "@/lib/billing/usage-pack-metadata";
import { sessionHasMembershipPackAddons } from "@/lib/billing/membership-pack-addons";

function sessionExpiresAt(session: Stripe.Checkout.Session, periodEnd: Date): Date {
  const createdSec =
    typeof session.created === "number" && Number.isFinite(session.created)
      ? session.created
      : Math.floor(Date.now() / 1000);
  const purchasedAt = new Date(createdSec * 1000);
  const plus30Ms = purchasedAt.getTime() + 30 * 24 * 60 * 60 * 1000;
  return periodEnd.getTime() >= plus30Ms ? periodEnd : new Date(plus30Ms);
}

async function resolveActiveGrantContext(
  businessId: string,
  session: Stripe.Checkout.Session,
  eventId: string,
  kind: string
): Promise<{ expiresAt: Date } | null> {
  const subRow = await getSubscription(businessId);
  if (!subRow?.stripe_subscription_id || subRow.status !== "active") {
    logger.warn(`membership_pack_addon ${kind}: no active subscription; grant blocked`, {
      eventId,
      businessId,
      sessionId: session.id,
      status: subRow?.status ?? null
    });
    return null;
  }

  let stripeSub: Stripe.Subscription;
  try {
    stripeSub = await getStripe().subscriptions.retrieve(subRow.stripe_subscription_id);
  } catch (err) {
    logger.error(`membership_pack_addon ${kind}: Stripe subscription retrieve failed`, {
      eventId,
      businessId,
      subscriptionId: subRow.stripe_subscription_id,
      error: err instanceof Error ? err.message : String(err)
    });
    return null;
  }
  if (stripeSub.status !== "active" && stripeSub.status !== "trialing") {
    logger.warn(`membership_pack_addon ${kind}: Stripe subscription not entitled; grant blocked`, {
      eventId,
      businessId,
      stripeStatus: stripeSub.status
    });
    return null;
  }

  const periodCache = stripeSubscriptionPeriodCache(stripeSub);
  const endIso =
    "stripe_current_period_end" in periodCache ? periodCache.stripe_current_period_end : undefined;
  if (!endIso) {
    logger.warn(`membership_pack_addon ${kind}: missing billing period end; grant blocked`, {
      eventId,
      businessId
    });
    return null;
  }

  return { expiresAt: sessionExpiresAt(session, new Date(endIso)) };
}

/**
 * Grant any membership pack add-ons on a completed Checkout Session.
 * Safe to call when metadata has no add-ons (no-op). Idempotent via RPCs.
 */
export async function applyMembershipPackAddonsFromCheckout(
  session: Stripe.Checkout.Session,
  eventId: string
): Promise<void> {
  const metadata = session.metadata ?? {};
  if (!sessionHasMembershipPackAddons(metadata)) return;

  const businessId = metadata.businessId?.trim();
  if (!businessId) {
    logger.warn("membership_pack_addon: missing businessId", {
      eventId,
      sessionId: session.id
    });
    return;
  }

  const ctx = await resolveActiveGrantContext(businessId, session, eventId, "shared");
  if (!ctx) return;

  const { createSupabaseServiceClient } = await import("@/lib/supabase/server");
  const db = await createSupabaseServiceClient();
  const expiresAt = ctx.expiresAt.toISOString();

  const voiceSeconds = parseVoiceBonusSecondsFromMetadata(metadata.addonVoiceSeconds ?? null);
  if (voiceSeconds != null) {
    const { data, error } = await db.rpc("apply_voice_bonus_grant_from_checkout", {
      p_business_id: businessId,
      p_checkout_session_id: session.id,
      p_seconds_purchased: voiceSeconds,
      p_expires_at: expiresAt
    });
    if (error) {
      logger.error("membership_pack_addon voice grant failed", {
        eventId,
        sessionId: session.id,
        businessId,
        error: error.message
      });
    } else {
      logger.info("membership_pack_addon voice grant recorded", {
        eventId,
        sessionId: session.id,
        businessId,
        voiceSeconds,
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

  const smsTexts = parseSmsBonusTextsFromMetadata(metadata.addonSmsTexts ?? null);
  if (smsTexts != null) {
    const { data, error } = await db.rpc("apply_sms_bonus_grant_from_checkout", {
      p_business_id: businessId,
      p_checkout_session_id: session.id,
      p_texts_purchased: smsTexts,
      p_expires_at: expiresAt
    });
    if (error) {
      logger.error("membership_pack_addon sms grant failed", {
        eventId,
        sessionId: session.id,
        businessId,
        error: error.message
      });
    } else {
      logger.info("membership_pack_addon sms grant recorded", {
        eventId,
        sessionId: session.id,
        businessId,
        smsTexts,
        result: data
      });
    }
  }

  const creditMicros = parseChatCreditMicrosFromMetadata(metadata.addonChatMicros ?? null);
  if (creditMicros != null) {
    const { data, error } = await db.rpc("apply_chat_credit_grant_from_checkout", {
      p_business_id: businessId,
      p_checkout_session_id: session.id,
      p_credit_micros: creditMicros,
      p_expires_at: expiresAt
    });
    if (error) {
      logger.error("membership_pack_addon chat grant failed", {
        eventId,
        sessionId: session.id,
        businessId,
        error: error.message
      });
    } else {
      logger.info("membership_pack_addon chat grant recorded", {
        eventId,
        sessionId: session.id,
        businessId,
        creditMicros,
        result: data
      });
    }
  }
}
