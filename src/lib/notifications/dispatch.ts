/**
 * Single entry point for "the AI coworker flagged something the owner should
 * know about". Both `/api/rowboat` and the voice-tools `capture` endpoint
 * call this; the Edge function `notifications` mirrors the logic in Deno.
 *
 * Behavior summary
 * ----------------
 * 1. Resolve recipients from `notification_preferences` first, then
 *    `businesses.owner_email` / env `TELNYX_OWNER_PHONE` / env `ADMIN_EMAIL`
 *    so per-business overrides win, with safe operator fallbacks.
 * 2. Honor the four channel toggles. A toggle that's off causes a
 *    `notifications` row with `status='skipped'` and a `reason` in `payload`
 *    so the dashboard list still reflects what would have been sent.
 * 3. Always write `notifications` rows (sent / failed / skipped) so the
 *    dashboard "Recent notifications" list is complete — this was the
 *    biggest gap before: edge-fn alerts were invisible.
 * 4. Email sends include the RFC 8058 `List-Unsubscribe` /
 *    `List-Unsubscribe-Post` headers and a footer link pointing at
 *    `/api/notifications/unsubscribe?bid=<uuid>`. The bid is the business
 *    UUID; UUID v4 is unguessable and the unsubscribe action is a flag the
 *    owner can re-enable from the dashboard, so this matches what most
 *    mainstream ESPs ship and avoids an extra signing-secret env var.
 */

import { randomUUID } from "node:crypto";
import { getBusiness } from "@/lib/db/businesses";
import { getOrCreateNotificationPreferences } from "@/lib/db/notification-preferences";
import {
  insertNotification,
  type NotificationDeliveryChannel,
  type NotificationRow,
  type NotificationStatus
} from "@/lib/db/notifications";
import { sendOwnerEmail } from "@/lib/email/client";
import { buildBrandedEmailHtml } from "@/lib/email/branded-html";
import { sendTelnyxSms, getTelnyxMessagingForBusiness } from "@/lib/telnyx/messaging";
import { coerceOwnerPhoneToE164 } from "@/lib/telnyx/assign-did";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import {
  notificationCategoryEnabled,
  resolveNotificationCategory,
  type CategoryPreferenceFlags
} from "@/lib/notifications/categories";
import { deliverWhatsApp } from "@/lib/whatsapp/deliver";
import { logger } from "@/lib/logger";
import { resolveOwnerUiLocaleForEmail } from "@/lib/i18n/owner-locale";
import { emailMessagesForLocale } from "@/lib/i18n/email-copy";

export type NotificationKind = "urgent_alert" | "voice_capture" | "digest" | string;

export type DispatchInput = {
  businessId: string;
  /** Short human-readable headline used as the subject prefix and stored in `summary`. */
  summary: string;
  kind: NotificationKind;
  /** Extra context written to the `payload` jsonb on every row produced. */
  payload?: Record<string, unknown>;
  /** Optional override of the email body; defaults to summary + dashboard link. */
  emailBody?: string;
  /** Optional override of the SMS body; defaults to "New Coworker Alert: {summary}". */
  smsBody?: string;
  /** Optional override of the email subject; defaults to "Urgent: {summary}". */
  emailSubject?: string;
};

export type DispatchChannelResult = {
  channel: NotificationDeliveryChannel;
  status: NotificationStatus;
  reason?: string;
  notificationId: string;
};

export type DispatchResult = {
  results: DispatchChannelResult[];
};

export type ResolvedTargets = {
  email: string | null;
  /** The business owner's login email — the address `ui_locale` is keyed to. */
  ownerEmail: string | null;
  phone: string | null;
  smsUrgentEnabled: boolean;
  /** WhatsApp channel toggle (delivery still requires a connected integration). */
  whatsappUrgentEnabled: boolean;
  emailUrgentEnabled: boolean;
  emailDigestEnabled: boolean;
  dashboardEnabled: boolean;
  unsubscribed: boolean;
  /** Per-event-category filters (see lib/notifications/categories.ts). */
  categories: CategoryPreferenceFlags;
};

/**
 * Resolve "where do owner alerts go?" using per-business preferences first,
 * then the business's onboarding email, then env-level operator fallbacks.
 *
 * Falls back gracefully on DB errors — we never want to silently drop an
 * urgent alert because preferences couldn't be read. The caller still gets
 * a result with the operator-level fallbacks active.
 */
export async function resolveNotificationTargets(
  businessId: string
): Promise<ResolvedTargets> {
  const fallbackEmail = process.env.ADMIN_EMAIL?.trim() || null;
  const fallbackPhone = coerceOwnerPhoneToE164(process.env.TELNYX_OWNER_PHONE);
  let prefsEmail: string | null = null;
  let prefsPhone: string | null = null;
  let smsUrgent = true;
  let whatsappUrgent = true;
  let emailUrgent = true;
  let emailDigest = true;
  let dashboardAlerts = true;
  let unsubscribed = false;
  let ownerEmail: string | null = null;
  // Category filters default ON (fail toward delivering) so a prefs read
  // hiccup can never silently drop an urgent alert.
  let categories: CategoryPreferenceFlags = {
    category_leads: true,
    category_team: true,
    category_system: true
  };

  try {
    const prefs = await getOrCreateNotificationPreferences(businessId);
    prefsEmail = prefs.alert_email?.trim() || null;
    // Normalize to E.164 at READ time, not just at save time: rows written
    // before the preferences route validated (observed live: Amy's
    // "6026951142", saved June 2026, failed its first urgent SMS with Telnyx
    // 40310 "Invalid 'to' address" a month later) must still deliver.
    // NANP coercion only — a bare 10-digit number becomes +1XXXXXXXXXX; an
    // ambiguous value we can't safely coerce is treated as no phone (the
    // dispatch writes an honest `skipped: no_phone` row) rather than sent to
    // Telnyx to fail.
    const rawPrefsPhone = prefs.phone_number?.trim() || null;
    prefsPhone = coerceOwnerPhoneToE164(rawPrefsPhone);
    if (rawPrefsPhone && !prefsPhone) {
      logger.warn("resolveNotificationTargets: stored alert phone is not coercible to E.164", {
        businessId
      });
    }
    smsUrgent = prefs.sms_urgent;
    // ?? true: rows read before the 20260811210000 migration keep the
    // channel on (delivery still requires a connected integration).
    whatsappUrgent = prefs.whatsapp_urgent ?? true;
    emailUrgent = prefs.email_urgent;
    emailDigest = prefs.email_digest;
    dashboardAlerts = prefs.dashboard_alerts;
    unsubscribed = prefs.unsubscribed_at !== null;
    categories = {
      // ?? true: rows read before the 20260823000000 migration ran (or
      // stale PostgREST schema cache) simply keep every category on.
      category_leads: prefs.category_leads ?? true,
      category_team: prefs.category_team ?? true,
      category_system: prefs.category_system ?? true
    };
  } catch (err) {
    logger.warn("resolveNotificationTargets: preferences lookup failed", {
      businessId,
      error: err instanceof Error ? err.message : String(err)
    });
  }

  try {
    const business = await getBusiness(businessId);
    ownerEmail = business?.owner_email?.trim() || null;
  } catch (err) {
    logger.warn("resolveNotificationTargets: business lookup failed", {
      businessId,
      error: err instanceof Error ? err.message : String(err)
    });
  }

  return {
    email: prefsEmail ?? ownerEmail ?? fallbackEmail,
    ownerEmail,
    phone: prefsPhone ?? fallbackPhone,
    smsUrgentEnabled: smsUrgent,
    whatsappUrgentEnabled: whatsappUrgent,
    emailUrgentEnabled: emailUrgent,
    emailDigestEnabled: emailDigest,
    dashboardEnabled: dashboardAlerts,
    unsubscribed,
    categories
  };
}

async function recordRow(
  businessId: string,
  channel: NotificationDeliveryChannel,
  status: NotificationStatus,
  summary: string,
  kind: NotificationKind,
  payload: Record<string, unknown>,
  reason?: string
): Promise<DispatchChannelResult> {
  const id = randomUUID();
  try {
    await insertNotification({
      id,
      business_id: businessId,
      delivery_channel: channel,
      status,
      kind,
      summary,
      payload: reason ? { ...payload, reason } : payload
    } as Parameters<typeof insertNotification>[0]);
  } catch (err) {
    logger.warn("notifications.dispatch: failed to insert history row", {
      businessId,
      channel,
      status,
      error: err instanceof Error ? err.message : String(err)
    });
  }
  return { channel, status, reason, notificationId: id };
}

/**
 * Send urgent owner alerts across the configured channels and write a
 * `notifications` row for every channel attempted.
 */
export async function dispatchUrgentNotification(
  input: DispatchInput
): Promise<DispatchResult> {
  const targets = await resolveNotificationTargets(input.businessId);
  // Strip trailing slash for parity with the Edge-function helpers and to
  // avoid `https://example.com//dashboard` / `//api/...` if the env var was
  // set with a stray slash.
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
  const dashboardUrl = `${appUrl}/dashboard`;
  const summary = input.summary;
  const kind = input.kind;
  const payload: Record<string, unknown> = { summary, ...(input.payload ?? {}) };
  const results: DispatchChannelResult[] = [];

  // Category gate (BizBlasts-style per-event-type prefs): when the owner
  // switched this event's category off, no channel fires — but every channel
  // still gets a `skipped` history row so the dashboard list reflects what
  // was suppressed and why. "general" is never gated.
  const category = resolveNotificationCategory(kind);
  if (!notificationCategoryEnabled(category, targets.categories)) {
    const reason = `category_${category}_disabled`;
    for (const channel of ["dashboard", "email", "sms", "whatsapp"] as const) {
      results.push(
        await recordRow(input.businessId, channel, "skipped", summary, kind, payload, reason)
      );
    }
    return { results };
  }

  // 1) Dashboard channel — only suppressed if the toggle is off (or unsubscribed-from-all).
  if (targets.dashboardEnabled && !targets.unsubscribed) {
    results.push(
      await recordRow(input.businessId, "dashboard", "sent", summary, kind, payload)
    );
  } else {
    results.push(
      await recordRow(
        input.businessId,
        "dashboard",
        "skipped",
        summary,
        kind,
        payload,
        targets.unsubscribed ? "unsubscribed" : "dashboard_alerts_disabled"
      )
    );
  }

  // 2) Email channel.
  if (!targets.email) {
    results.push(
      await recordRow(
        input.businessId,
        "email",
        "skipped",
        summary,
        kind,
        payload,
        "no_email"
      )
    );
  } else if (!targets.emailUrgentEnabled || targets.unsubscribed) {
    results.push(
      await recordRow(
        input.businessId,
        "email",
        "skipped",
        summary,
        kind,
        { ...payload, recipient: targets.email },
        targets.unsubscribed ? "unsubscribed" : "email_urgent_disabled"
      )
    );
  } else {
    const ownerLocale = await resolveOwnerUiLocaleForEmail(targets.email);
    const emailCopy = emailMessagesForLocale(ownerLocale);
    // Build off the app origin (not dashboardUrl, which has /dashboard appended)
    // so the link resolves to /api/notifications/unsubscribe — the route the
    // unsubscribe handler is mounted at.
    const unsubscribeUrl = `${appUrl}/api/notifications/unsubscribe?bid=${encodeURIComponent(
      input.businessId
    )}`;
    const subject =
      input.emailSubject ?? emailCopy.common.urgentSubject.replace("{summary}", summary);
    const body =
      input.emailBody ??
      `${emailCopy.common.urgentBody.replace("{summary}", summary)}\n\nView details: ${dashboardUrl}`;
    const bodyParagraphs = body.split(/\n\n+/).filter(Boolean);
    const html = buildBrandedEmailHtml({
      siteUrl: appUrl,
      documentTitle: subject,
      heading: subject,
      bodyBlocks: bodyParagraphs.map((t) => ({ kind: "text" as const, text: t })),
      cta: { label: emailCopy.common.openDashboard, href: dashboardUrl },
      unsubscribeUrl,
      recipientEmail: targets.email
    });
    try {
      await sendOwnerEmail(process.env.RESEND_API_KEY ?? "", targets.email, subject, {
        text: body,
        html,
        unsubscribeUrl
      });
      results.push(
        await recordRow(input.businessId, "email", "sent", summary, kind, {
          ...payload,
          recipient: targets.email
        })
      );
    } catch (err) {
      logger.warn("notifications.dispatch: email send failed", {
        businessId: input.businessId,
        error: err instanceof Error ? err.message : String(err)
      });
      results.push(
        await recordRow(
          input.businessId,
          "email",
          "failed",
          summary,
          kind,
          { ...payload, recipient: targets.email },
          err instanceof Error ? err.message : "send_failed"
        )
      );
    }
  }

  // 3) SMS channel.
  if (!targets.phone) {
    results.push(
      await recordRow(input.businessId, "sms", "skipped", summary, kind, payload, "no_phone")
    );
  } else if (!targets.smsUrgentEnabled || targets.unsubscribed) {
    results.push(
      await recordRow(
        input.businessId,
        "sms",
        "skipped",
        summary,
        kind,
        { ...payload, recipient: targets.phone },
        targets.unsubscribed ? "unsubscribed" : "sms_urgent_disabled"
      )
    );
  } else {
    const text = input.smsBody ?? `New Coworker Alert: ${summary}. Details: ${dashboardUrl}`;
    try {
      const config = await getTelnyxMessagingForBusiness(input.businessId);
      // Owner alerts are METERED like everything else (nothing is exempt —
      // Jul 14 2026 policy) but never REFUSED: "operational" mode counts
      // the send (plan/bonus/overage) without the hard stop, so the cap
      // alert itself can outrun the cap it reports.
      const { id: telnyxMessageId, channel: sentChannel } = await sendTelnyxSms(
        config,
        targets.phone,
        text,
        {
          meterBusinessId: input.businessId,
          meterMode: "operational"
        }
      );
      // Best-effort durable log so the alert renders in the owner's dashboard
      // Messages thread (merged from sms_outbound_log — see
      // src/lib/db/sms-history.ts). Mirrors the notifications Edge function.
      // A failed insert must not fail the dispatch — the SMS already went out.
      try {
        const db = await createSupabaseServiceClient();
        const { error: logErr } = await db.from("sms_outbound_log").insert({
          business_id: input.businessId,
          to_e164: targets.phone,
          from_e164: config.fromE164 ?? null,
          body: text,
          source: "owner_alert",
          run_id: null,
          flow_id: null,
          telnyx_message_id: telnyxMessageId,
          channel: sentChannel
        });
        if (logErr) {
          logger.warn("notifications.dispatch: owner_alert outbound log insert failed", {
            businessId: input.businessId,
            error: logErr.message
          });
        }
      } catch (logCatchErr) {
        logger.warn("notifications.dispatch: owner_alert outbound log insert threw", {
          businessId: input.businessId,
          error: logCatchErr instanceof Error ? logCatchErr.message : String(logCatchErr)
        });
      }
      results.push(
        await recordRow(input.businessId, "sms", "sent", summary, kind, {
          ...payload,
          recipient: targets.phone
        })
      );
    } catch (err) {
      logger.warn("notifications.dispatch: sms send failed", {
        businessId: input.businessId,
        error: err instanceof Error ? err.message : String(err)
      });
      results.push(
        await recordRow(
          input.businessId,
          "sms",
          "failed",
          summary,
          kind,
          { ...payload, recipient: targets.phone },
          err instanceof Error ? err.message : "send_failed"
        )
      );
    }
  }

  // 4) WhatsApp channel. Fully additive: no connected WhatsApp integration
  // just writes an honest skip row (deliverWhatsApp's not_connected). Out-
  // of-window sends ride the owner-alert utility template; a template still
  // in Meta review is likewise recorded as skipped, never failed.
  if (!targets.phone) {
    results.push(
      await recordRow(input.businessId, "whatsapp", "skipped", summary, kind, payload, "no_phone")
    );
  } else if (!targets.whatsappUrgentEnabled || targets.unsubscribed) {
    results.push(
      await recordRow(
        input.businessId,
        "whatsapp",
        "skipped",
        summary,
        kind,
        { ...payload, recipient: targets.phone },
        targets.unsubscribed ? "unsubscribed" : "whatsapp_urgent_disabled"
      )
    );
  } else {
    const text = input.smsBody ?? `New Coworker Alert: ${summary}. Details: ${dashboardUrl}`;
    try {
      // Owner alerts follow the owner's saved UI language, keyed to the
      // OWNER login email (a custom alert_email may be someone else's).
      const whatsappLocaleEmail = targets.ownerEmail ?? targets.email;
      const delivered = await deliverWhatsApp({
        businessId: input.businessId,
        to: targets.phone,
        text,
        audience: "owner",
        language: whatsappLocaleEmail
          ? await resolveOwnerUiLocaleForEmail(whatsappLocaleEmail)
          : "en"
      });
      if (delivered.ok) {
        results.push(
          await recordRow(input.businessId, "whatsapp", "sent", summary, kind, {
            ...payload,
            recipient: targets.phone,
            via: delivered.via
          })
        );
      } else {
        results.push(
          await recordRow(
            input.businessId,
            "whatsapp",
            delivered.reason === "send_failed" ? "failed" : "skipped",
            summary,
            kind,
            { ...payload, recipient: targets.phone },
            delivered.reason
          )
        );
      }
    } catch (err) {
      logger.warn("notifications.dispatch: whatsapp send failed", {
        businessId: input.businessId,
        error: err instanceof Error ? err.message : String(err)
      });
      results.push(
        await recordRow(
          input.businessId,
          "whatsapp",
          "failed",
          summary,
          kind,
          { ...payload, recipient: targets.phone },
          err instanceof Error ? err.message : "send_failed"
        )
      );
    }
  }

  return { results };
}

export type { NotificationRow };
