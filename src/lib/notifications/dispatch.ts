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
 *    dashboard "Recent notifications" list is complete, this was the
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
  listRecentAlertsAbout,
  insertNotification,
  type NotificationDeliveryChannel,
  type NotificationRow,
  type NotificationStatus
} from "@/lib/db/notifications";
import { sendOwnerEmail } from "@/lib/email/client";
import { buildBrandedEmailHtml } from "@/lib/email/branded-html";
import { sendTelnyxSms, getTelnyxMessagingForBusiness } from "@/lib/telnyx/messaging";
import { coerceOwnerPhoneToE164 } from "@/lib/telnyx/assign-did";
import { alphaOwnerAlertProfile, withAlphaNoReplyLine } from "@/lib/telnyx/alpha-sender";
import { smsDestinationCountry } from "@/lib/sms/destination-rates";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import {
  notificationCategoryEnabled,
  resolveNotificationCategory,
  type CategoryPreferenceFlags
} from "@/lib/notifications/categories";
import { deliverWhatsApp } from "@/lib/whatsapp/deliver";
import { getPublicWhatsAppConnection } from "@/lib/db/whatsapp-connections";
import {
  buildSlackAlertBlocks,
  deliverSlackAlert,
  slackAlertTargetState
} from "@/lib/slack/deliver";
import {
  resolveContactOwnerTarget,
  type ContactOwnerTarget
} from "../../../supabase/functions/_shared/contact_owner_target";
import { recordUnownedLeadAlert } from "../../../supabase/functions/_shared/unowned_lead_alerts";
import { logger } from "@/lib/logger";
import { recordSystemLog } from "@/lib/db/system-logs";
import { resolveOwnerUiLocaleForEmail } from "@/lib/i18n/owner-locale";
import {
  notificationMustBePhiFree,
  phiFreeNotificationCopy
} from "../../../supabase/functions/_shared/hipaa_notification_redaction";
import { emailMessagesForLocale } from "@/lib/i18n/email-copy";
import type { AppLocale } from "@/i18n/routing";

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
  /**
   * Optional H1. Defaults to the subject, which is right for a short generic
   * alert and wrong for a long specific one: an alert whose subject already
   * names the person, the phone, and the time repeated all three as a
   * heading and then a third time in the first body line.
   */
  emailHeading?: string;
  /**
   * Where the alert's button, its copy-and-paste fallback link, and the SMS
   * link all point, app-relative (e.g. `/dashboard/customers/%2B1555...`).
   * Defaults to `/dashboard`. Locale-independent by design, so it is settable
   * without going through the template.
   */
  ctaPath?: string;
  /** Optional button label; defaults to the localized "Open dashboard". */
  ctaLabel?: string;
  /**
   * Locale-aware copy for alerts whose wording is more than one line.
   *
   * The owner's locale is resolved HERE, from the recipient address, so a
   * caller cannot know it in advance. Handing the caller a callback keeps the
   * copy in its own template module (the README's rule for owner
   * transactional email) while the locale stays where it is resolved.
   * Explicit `emailSubject` / `emailBody` / `emailHeading` still win, so an
   * override is always available.
   */
  emailTemplate?: (locale: AppLocale) => {
    subject: string;
    heading: string;
    body: string;
    ctaLabel: string;
    ctaPath: string;
  };
  /**
   * The contact this alert is ABOUT, when it is about one. Supplying it
   * redirects the page to whichever teammate owns that contact, falling back
   * to the business owner. Omitted by every business-level alert (billing,
   * plan, system health), which stays owner-addressed.
   */
  contactE164?: string | null;
  /**
   * Lead type ("seller" / "buyer") for an alert about a lead NOBODY owns.
   *
   * An unowned lead is alerted to the teammates who cover that type before it
   * falls to the business owner. Omitting this, or passing a tag no teammate
   * carries, alerts every broadcast-eligible teammate: the filter degrades to
   * noise, never to silence.
   */
  leadTag?: string | null;
  /**
   * The lead's display name, used only to label a claimable team broadcast
   * ("which lead did you mean?"). Optional: an unnamed lead is still
   * claimable, it just shows as its number.
   */
  leadLabel?: string | null;
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
  /**
   * `businesses.hipaa_mode`. UNDEFINED (not false) when the business row could
   * not be read, which notificationMustBePhiFree treats as "redact": see that
   * helper for why this one fails closed.
   */
  hipaaMode?: boolean;
  /** The business owner's login email, the address `ui_locale` is keyed to. */
  ownerEmail: string | null;
  /** The first of {@link phones}, kept so single-recipient callers are unchanged. */
  phone: string | null;
  /**
   * Every phone the SMS leg should reach. One entry in the ordinary case; the
   * whole lead-type-tagged roster when the alert is about a lead NOBODY owns.
   */
  phones: string[];
  smsUrgentEnabled: boolean;
  /** WhatsApp channel toggle (delivery still requires a connected integration). */
  whatsappUrgentEnabled: boolean;
  /**
   * Whether this business has ever connected WhatsApp. False means the
   * channel is not applicable to them and NO whatsapp row is written at all,
   * on any branch. Fails toward true on a read error, so a blip degrades to
   * the old (noisy but honest) behavior rather than silencing a tenant who
   * really is connected.
   */
  whatsappConnected: boolean;
  /**
   * Owner preference: deliver urgent alerts on WhatsApp INSTEAD of SMS.
   * Gated on {@link whatsappDeliverable}, never on {@link whatsappConnected}.
   */
  whatsappReplacesSms: boolean;
  /**
   * Whether the WhatsApp connection can actually DELIVER right now: the row
   * exists AND is active. Distinct from {@link whatsappConnected}, which
   * only asks "is this channel applicable to this business?" and fails
   * toward TRUE. This one fails toward FALSE, because it is the gate that
   * SUPPRESSES the SMS leg: an inactive/expired connection refuses with
   * `connection_inactive` inside deliverWhatsApp, so treating a mere row as
   * proof of delivery would leave the owner with no phone channel at all.
   */
  whatsappDeliverable: boolean;
  /** Slack channel toggle (delivery still requires a picked alert channel). */
  slackUrgentEnabled: boolean;
  /** Same never-connected silence rule as whatsappConnected. */
  slackConnected: boolean;
  emailUrgentEnabled: boolean;
  emailDigestEnabled: boolean;
  dashboardEnabled: boolean;
  unsubscribed: boolean;
  /** Per-event-category filters (see lib/notifications/categories.ts). */
  categories: CategoryPreferenceFlags;
  /**
   * How a contact-scoped alert was routed, when a contact was supplied.
   * Null when the caller passed none (the business-level alerts).
   */
  routing: ContactOwnerTarget | null;
};

/**
 * Resolve "where do owner alerts go?" using per-business preferences first,
 * then the business's onboarding email, then env-level operator fallbacks.
 *
 * When `contactE164` names the contact the alert is ABOUT, the resolved
 * phone (and the email, when the roster row has one) is redirected to the
 * teammate who owns that contact, see
 * supabase/functions/_shared/contact_owner_target.ts for the ladder and why
 * it ignores the per-employee availability flags. Business-level alerts pass
 * no contact and are unaffected.
 *
 * Falls back gracefully on DB errors, we never want to silently drop an
 * urgent alert because preferences couldn't be read. The caller still gets
 * a result with the operator-level fallbacks active.
 *
 * Note the per-business toggles below still apply to a redirected page: the
 * `notification_preferences` row has no per-employee dimension, so switching
 * `sms_urgent` off is the BUSINESS's kill switch and silences the teammate's
 * page too. That is deliberate; do not invent a dimension the table cannot
 * express.
 */
export async function resolveNotificationTargets(
  businessId: string,
  contactE164?: string | null,
  /** Lead type used to narrow an unowned-lead broadcast. See DispatchInput. */
  leadTag?: string | null
): Promise<ResolvedTargets> {
  const fallbackEmail = process.env.ADMIN_EMAIL?.trim() || null;
  const fallbackPhone = coerceOwnerPhoneToE164(process.env.TELNYX_OWNER_PHONE);
  let prefsEmail: string | null = null;
  let prefsPhone: string | null = null;
  let smsUrgent = true;
  let whatsappUrgent = true;
  // Reroute preference defaults OFF (fail toward delivering on both
  // channels), unlike the channel toggles above which fail toward on.
  let whatsappReplacesSms = false;
  let slackUrgent = true;
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
    // NANP coercion only, a bare 10-digit number becomes +1XXXXXXXXXX; an
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
    // ?? false: rows read before 20260822125053 keep SMS delivery unchanged.
    whatsappReplacesSms = prefs.whatsapp_replaces_sms ?? false;
    // ?? true: rows read before 20260822113305, same posture.
    slackUrgent = prefs.slack_urgent ?? true;
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

  let hipaaMode: boolean | undefined;
  try {
    const business = await getBusiness(businessId);
    ownerEmail = business?.owner_email?.trim() || null;
    // Definite boolean only when a row actually came back. getBusiness
    // swallows its errors and returns null, so `business?.hipaa_mode === true`
    // would quietly turn a failed read into "not HIPAA" and send content: the
    // null case has to stay UNKNOWN for the fail-closed default to mean
    // anything. The catch below covers a genuine throw the same way.
    hipaaMode = business ? business.hipaa_mode === true : undefined;
  } catch (err) {
    logger.warn("resolveNotificationTargets: business lookup failed", {
      businessId,
      error: err instanceof Error ? err.message : String(err)
    });
  }

  // "Has this business ever connected WhatsApp?", the public read, because
  // this is an existence check and never needs the encrypted access token.
  // Two verdicts from one lookup, with DELIBERATELY OPPOSITE failure
  // directions: `connected` decides whether to write a row at all (fails
  // toward true: better a noisy honest skip than silence for a tenant who
  // really is connected), while `deliverable` decides whether to suppress
  // the SMS leg (fails toward false: never trade a working channel for an
  // uncertain one).
  let whatsappConnected = true;
  let whatsappDeliverable = false;
  try {
    const waConnection = await getPublicWhatsAppConnection(businessId);
    whatsappConnected = waConnection !== null;
    whatsappDeliverable = waConnection?.is_active === true;
  } catch (err) {
    logger.warn("resolveNotificationTargets: whatsapp connection lookup failed", {
      businessId,
      error: err instanceof Error ? err.message : String(err)
    });
  }

  // Same question for Slack (fails toward connected inside the helper).
  const slackState = await slackAlertTargetState(businessId);

  const ownerAlertEmail = prefsEmail ?? ownerEmail ?? fallbackEmail;
  const ownerAlertPhone = prefsPhone ?? fallbackPhone;

  // Contact-scoped alerts belong to whoever owns the lead. Wrapped like the
  // two lookups above: resolveContactOwnerTarget never throws, but building
  // the service client can, and an alert must never be lost because we could
  // not work out who to redirect it to. Degrades to the business owner.
  let routing: ContactOwnerTarget | null = null;
  if (contactE164) {
    try {
      const db = await createSupabaseServiceClient();
      routing = await resolveContactOwnerTarget(db, businessId, contactE164, leadTag);
    } catch (err) {
      logger.warn("resolveNotificationTargets: contact-owner lookup failed", {
        businessId,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }
  const redirected = routing?.target === "contact_owner";
  const primaryPhone = redirected ? routing!.phone : ownerAlertPhone;
  // Every phone the SMS leg should reach. One entry for the ordinary owner or
  // contact-owner case; the whole tagged roster when nobody owns the lead.
  // `phone` stays the FIRST of these so the per-channel skip rows, the
  // WhatsApp leg, and every existing caller keep reading one recipient.
  const phones =
    routing?.target === "team_broadcast"
      ? routing.team.map((m) => m.phone)
      : primaryPhone
        ? [primaryPhone]
        : [];

  return {
    phones,
    hipaaMode,
    // Email redirects only when the roster row actually has an address;
    // otherwise it stays with the owner so a redirected alert keeps a second
    // delivery path (see contact_owner_target's emailTarget).
    email:
      routing?.emailTarget === "contact_owner" ? routing.email : ownerAlertEmail,
    ownerEmail,
    phone: phones[0] ?? null,
    routing,
    smsUrgentEnabled: smsUrgent,
    whatsappUrgentEnabled: whatsappUrgent,
    whatsappReplacesSms,
    whatsappDeliverable,
    whatsappConnected,
    slackUrgentEnabled: slackUrgent,
    slackConnected: slackState.connected,
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
/**
 * The urgent-alert flood cap: how many SENT alerts about one contact fit in
 * the window before further ones are skipped. Exported so tests pin the
 * policy numbers rather than restating them.
 */
export const URGENT_ALERT_COOLDOWN_WINDOW_MS = 30 * 60 * 1000;

/**
 * Backstop only. It was 2, which is what silently ate the THIRD alert about
 * a lead sitting on a Zoom waiting for an owner who never joined (KYP Ads,
 * 2026-08-24): three alerts in twelve minutes, each saying something new and
 * more urgent than the last, and the one that finally said "urgently" and
 * "ASAP" reached nobody on any channel.
 *
 * A count cannot tell a flood from an escalation, so the duplicate check
 * below does that job and this is only the last line of defence against a
 * runaway loop. Six still cuts the incident it was built for (seventeen
 * identical alerts in ten minutes) well before it becomes seventeen.
 */
export const URGENT_ALERT_COOLDOWN_MAX = 6;

/**
 * How alike two alerts must be before the newer one is treated as a repeat.
 * High on purpose: a bot loop restates itself almost verbatim, while a real
 * escalation changes its words as the situation changes.
 */
export const URGENT_ALERT_DUPLICATE_SIMILARITY = 0.9;

/**
 * Jaccard overlap of two alert summaries' word sets, 0 to 1.
 *
 * Word-set rather than string equality because a looping alert often carries
 * one varying fragment (a timestamp, a quoted reply) inside otherwise
 * identical copy, and exact matching would let all seventeen through.
 * Punctuation and case are stripped so "James has NOT joined!" and "james
 * has not joined" are the same alert.
 */
export function alertSummarySimilarity(a: string, b: string): number {
  const words = (text: string) =>
    new Set(
      text
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, " ")
        .split(/\s+/)
        .filter(Boolean)
    );
  const left = words(a);
  const right = words(b);
  if (left.size === 0 || right.size === 0) return left.size === right.size ? 1 : 0;
  let shared = 0;
  for (const w of left) if (right.has(w)) shared += 1;
  return shared / (left.size + right.size - shared);
}

export async function dispatchUrgentNotification(
  input: DispatchInput
): Promise<DispatchResult> {
  const targets = await resolveNotificationTargets(
    input.businessId,
    input.contactE164,
    input.leadTag
  );
  // Strip trailing slash for parity with the Edge-function helpers and to
  // avoid `https://example.com//dashboard` / `//api/...` if the env var was
  // set with a stray slash.
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
  // Where this alert's links point. `/dashboard` unless the caller named a
  // deeper destination: an alert that asks for one specific action should
  // land on the screen that performs it, and the button, the fallback link,
  // and the SMS link must not disagree about where that is.
  // HIPAA lane: every channel below hands content to a vendor that cannot
  // hold PHI (Resend has no BAA, Meta and Slack are third-party, and Telnyx
  // SMS rides the narrow conduit exception). When on, the alert degrades to a
  // doorbell and the real content is read back from the dashboard instead.
  const phiFree = notificationMustBePhiFree(targets.hipaaMode)
    ? phiFreeNotificationCopy(`${appUrl}/dashboard`)
    : null;
  // The deep link is itself a disclosure: callers pass paths like
  // `/dashboard/customers/%2B15551234567`, and a patient's phone number is an
  // identifier. A HIPAA alert points at the plain dashboard so neither the
  // email button nor the SMS link carries one.
  const dashboardUrl = phiFree
    ? `${appUrl}/dashboard`
    : `${appUrl}${input.ctaPath ?? "/dashboard"}`;
  const summary = input.summary;
  const kind = input.kind;
  const payload: Record<string, unknown> = {
    summary,
    ...(input.payload ?? {}),
    // The contact this alert is ABOUT (not who receives it) plus a
    // per-dispatch id. Together they are what countRecentNotificationsAbout
    // keys the cooldown below on: about_e164 selects the rows, dispatch_id
    // collapses this dispatch's one-row-per-channel fan-out to one event.
    ...(input.contactE164 ? { about_e164: input.contactE164 } : {}),
    dispatch_id: randomUUID(),
    // Why this alert reached whoever it reached, mirrors the
    // notify_lead_owner step's target/matched_by so run history and the
    // dashboard can both explain a recipient.
    ...(targets.routing
      ? {
          routed_to: targets.routing.target,
          routed_member_id: targets.routing.memberId,
          routed_member_name: targets.routing.memberName,
          matched_by: targets.routing.matchedBy,
          routing_reason: targets.routing.reason
        }
      : {})
  };
  const results: DispatchChannelResult[] = [];

  // Per-contact flood cooldown (Amy Laidlaw, 2026-08-07): a bot-vs-bot SMS
  // loop fired notify_team once per lap, seventeen "[Coworker] Follow up
  // with Aaron" alerts in ten minutes, each by SMS AND email. Alerts about
  // one contact are capped: once URGENT_ALERT_COOLDOWN_MAX have been sent
  // about the same number inside the window, further ones write skipped
  // history rows and deliver nothing. Two legitimate alerts about the same
  // person in half an hour still land; the third-plus is a flood by any
  // cause. Only alerts that name a contact are gated (a business-wide alert
  // has no about_e164 to key on), and a failed count fails open to sending:
  // this gate must never be the reason an owner missed a real emergency.
  if (input.contactE164) {
    let recent: { events: number; summaries: string[] } = { events: 0, summaries: [] };
    try {
      recent = await listRecentAlertsAbout(
        input.businessId,
        kind,
        input.contactE164,
        URGENT_ALERT_COOLDOWN_WINDOW_MS
      );
    } catch (err) {
      logger.warn("notifications.dispatch: cooldown read failed, sending anyway", {
        businessId: input.businessId,
        error: err instanceof Error ? err.message : String(err)
      });
    }
    // A repeat is the actual flood signal. A loop restates itself; a real
    // escalation says something new each time, so it is never squashed here
    // however fast it arrives.
    const duplicateOf = recent.summaries.find(
      (previous) =>
        alertSummarySimilarity(previous, summary) >= URGENT_ALERT_DUPLICATE_SIMILARITY
    );
    const reason = duplicateOf
      ? "contact_alert_duplicate"
      : recent.events >= URGENT_ALERT_COOLDOWN_MAX
        ? "contact_alert_cooldown"
        : null;
    if (reason) {
      // The dashboard is NEVER gated: it makes no noise, it is the record of
      // what happened, and suppressing it is what made the eaten alert
      // invisible after the fact as well as at the time.
      const gatedChannels = (["email", "sms", "whatsapp", "slack"] as const).filter(
        (channel) =>
          (channel !== "whatsapp" || targets.whatsappConnected) &&
          (channel !== "slack" || targets.slackConnected)
      );
      // Every row of a suppressed dispatch is stamped so the backstop count
      // cannot see it. Without this the dashboard row, which IS genuinely
      // sent, counts as an alert event, and a burst of squashed repeats
      // would burn the budget and mute the next real escalation: exactly
      // the failure this gate was rewritten to prevent. Bugbot, PR #1617.
      const suppressedPayload = { ...payload, suppressed: reason };
      results.push(
        await recordRow(input.businessId, "dashboard", "sent", summary, kind, suppressedPayload)
      );
      for (const channel of gatedChannels) {
        results.push(
          await recordRow(
            input.businessId,
            channel,
            "skipped",
            summary,
            kind,
            suppressedPayload,
            reason
          )
        );
      }
      logger.warn("notifications.dispatch: contact alert suppressed", {
        businessId: input.businessId,
        kind,
        aboutE164: input.contactE164,
        reason,
        recentEvents: recent.events
      });
      return { results };
    }
  }

  // Category gate (BizBlasts-style per-event-type prefs): when the owner
  // switched this event's category off, no channel fires, but every channel
  // still gets a `skipped` history row so the dashboard list reflects what
  // was suppressed and why. "general" is never gated. WhatsApp is excluded
  // for a business that never connected it: an unavailable channel has
  // nothing to report about a suppressed alert.
  const category = resolveNotificationCategory(kind);
  if (!notificationCategoryEnabled(category, targets.categories)) {
    const reason = `category_${category}_disabled`;
    const gatedChannels = (["dashboard", "email", "sms", "whatsapp", "slack"] as const).filter(
      (channel) =>
        (channel !== "whatsapp" || targets.whatsappConnected) &&
        (channel !== "slack" || targets.slackConnected)
    );
    for (const channel of gatedChannels) {
      results.push(
        await recordRow(input.businessId, channel, "skipped", summary, kind, payload, reason)
      );
    }
    return { results };
  }

  // 1) Dashboard channel, only suppressed if the toggle is off (or unsubscribed-from-all).
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
    // so the link resolves to /api/notifications/unsubscribe, the route the
    // unsubscribe handler is mounted at.
    const unsubscribeUrl = `${appUrl}/api/notifications/unsubscribe?bid=${encodeURIComponent(
      input.businessId
    )}`;
    // Rendered here, not by the caller, because the locale is only known
    // once the recipient is resolved. Explicit fields still win over it.
    // Redacted copy is rebuilt here because the owner's locale is only known
    // once the recipient is resolved. It wins over caller-supplied fields AND
    // the template: an override is a caller convenience, never a way to put
    // patient detail back into a HIPAA tenant's outbound mail.
    const phiFreeEmail = phiFree ? phiFreeNotificationCopy(dashboardUrl, ownerLocale) : null;
    const templated = phiFree ? undefined : input.emailTemplate?.(ownerLocale);
    const subject =
      phiFreeEmail?.emailSubject ??
      input.emailSubject ??
      templated?.subject ??
      emailCopy.common.urgentSubject.replace("{summary}", summary);
    const body =
      phiFreeEmail?.emailBody ??
      input.emailBody ??
      templated?.body ??
      `${emailCopy.common.urgentBody.replace("{summary}", summary)}\n\nView details: ${dashboardUrl}`;
    const bodyParagraphs = body.split(/\n\n+/).filter(Boolean);
    // A template may carry its own destination, but an explicit ctaPath wins:
    // it is the one the SMS link and the fallback link already used, and a
    // button pointing somewhere the other two do not is worse than either.
    const ctaHref =
      !input.ctaPath && templated?.ctaPath ? `${appUrl}${templated.ctaPath}` : dashboardUrl;
    const html = buildBrandedEmailHtml({
      siteUrl: appUrl,
      documentTitle: subject,
      // Falling back to the subject keeps every existing alert byte-identical.
      heading: phiFreeEmail?.emailHeading ?? input.emailHeading ?? templated?.heading ?? subject,
      bodyBlocks: bodyParagraphs.map((t) => ({ kind: "text" as const, text: t })),
      cta: {
        label: input.ctaLabel ?? templated?.ctaLabel ?? emailCopy.common.openDashboard,
        href: ctaHref
      },
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
  } else if (
    targets.whatsappReplacesSms &&
    targets.whatsappDeliverable &&
    targets.whatsappUrgentEnabled &&
    targets.routing?.target !== "contact_owner" &&
    // Never lets a single WhatsApp message stand in for a whole-team
    // broadcast: the preference belongs to the owner's number, and the
    // audience here is every teammate who covers this lead type.
    targets.routing?.target !== "team_broadcast"
  ) {
    // The owner opted to receive this on WhatsApp INSTEAD of SMS. Gated on
    // whatsappDeliverable, NOT whatsappConnected: the latter is true for a
    // row that exists but is inactive or token-lapsed, which deliverWhatsApp
    // refuses with `connection_inactive`, suppressing SMS on that basis
    // would leave the owner with NO phone channel (Bugbot f574b3a4). Never
    // applied to an alert redirected to a teammate's phone either: the
    // preference belongs to the owner's number, and a teammate's number may
    // not have WhatsApp at all. An out-of-window send whose template is
    // still in Meta review records its own honest skip row, so the two rows
    // together always tell the owner what happened.
    results.push(
      await recordRow(
        input.businessId,
        "sms",
        "skipped",
        summary,
        kind,
        { ...payload, recipient: targets.phone },
        "whatsapp_preferred"
      )
    );
  } else {
    // One send per recipient. `phones` holds exactly one entry unless the
    // alert is about a lead nobody owns, in which case it is the lead-type
    // tagged roster and each teammate gets their own send, their own
    // outbound log row, and their own sent/failed notification row. One
    // teammate's failed send must never suppress the rest of the team.
    for (const recipientPhone of targets.phones) {
      // An international owner phone with the alpha profile configured rides
      // the platform's one-way NEWCOWORKER sender (long codes cannot
      // originate international SMS: Telnyx ticket #557577), no-reply line
      // appended since that sender has no inbound path. Env unset = null =
      // today's behavior. Owner alerts only, mirroring the notifications
      // Edge function.
      const alphaProfile = alphaOwnerAlertProfile(smsDestinationCountry(recipientPhone));
      // The summary usually ends with "." and the template appends its own;
      // trim trailing periods so the alert never reads "dashboard.. Details:".
      const alertLine =
        phiFree?.smsBody ??
        input.smsBody ??
        `New Coworker Alert: ${summary.replace(/\.+$/, "")}. Details: ${dashboardUrl}`;
      // The claim affordance goes on ONLY when a team broadcast is about to
      // record a row for the digit to attach to. Inviting "1" on an
      // owner-addressed alert would send it to an unrelated live offer, which
      // is exactly the failure claimable alerts exist to remove. Callers
      // cannot make this call: they do not know how routing will resolve.
      const claimable =
        targets.routing?.target === "team_broadcast"
          ? `${alertLine}\nReply 1 to claim, or claim them in the dashboard.`
          : alertLine;
      const text = alphaProfile ? withAlphaNoReplyLine(claimable) : claimable;
      try {
        const tenantConfig = await getTelnyxMessagingForBusiness(input.businessId);
        // On the alpha profile the sender IS the profile's alpha identity:
        // swap the profile in and drop the tenant from-number.
        const config = alphaProfile
          ? // rcsAgentId nulled explicitly: the branded RCS agent must never
            // be the sender identity for an alpha-routed alert.
            { ...tenantConfig, messagingProfileId: alphaProfile, fromE164: undefined, rcsAgentId: null }
          : tenantConfig;
        // Owner alerts are METERED like everything else (nothing is exempt,
        // Jul 14 2026 policy) but never REFUSED: "operational" mode counts
        // the send (plan/bonus/overage) without the hard stop, so the cap
        // alert itself can outrun the cap it reports.
        const { id: telnyxMessageId, channel: sentChannel } = await sendTelnyxSms(
          config,
          recipientPhone,
          text,
          {
            meterBusinessId: input.businessId,
            meterMode: "operational"
          }
        );
        // Best-effort durable log so the alert renders in the owner's dashboard
        // Messages thread (merged from sms_outbound_log, see
        // src/lib/db/sms-history.ts). Mirrors the notifications Edge function.
        // A failed insert must not fail the dispatch: the SMS already went out.
        try {
          const db = await createSupabaseServiceClient();
          const { error: logErr } = await db.from("sms_outbound_log").insert({
            business_id: input.businessId,
            to_e164: recipientPhone,
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
            recipient: recipientPhone
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
            { ...payload, recipient: recipientPhone },
            err instanceof Error ? err.message : "send_failed"
          )
        );
      }
    }
    // Make the broadcast claimable by text. Teammates reply "1" to team texts
    // out of habit (every other one ends in "Reply 1 to claim"), and without
    // a record that digit resolves against some unrelated older offer. Only
    // a real team broadcast gets one: an owner-addressed alert has nobody to
    // race. Never throws, so a bookkeeping failure cannot cost the alert that
    // already went out.
    if (targets.routing?.target === "team_broadcast") {
      try {
        const db = await createSupabaseServiceClient();
        await recordUnownedLeadAlert(db, {
          businessId: input.businessId,
          leadE164: input.contactE164,
          leadLabel: input.leadLabel ?? null,
          recipients: targets.phones,
          nowMs: Date.now()
        });
      } catch (err) {
        logger.warn("notifications.dispatch: claimable alert record failed", {
          businessId: input.businessId,
          error: err instanceof Error ? err.message : String(err)
        });
      }
    }
  }

  // 4) WhatsApp channel. A business that NEVER connected WhatsApp records
  // NOTHING here: every alert used to write a `skipped: not_connected` row,
  // which for the (majority) never-connected tenants was 1-2 rows of pure
  // noise per event, forever (Amy's Jul 31 list was the trigger). An
  // INACTIVE/expired connection still records an honest skip row: that one
  // is owner-actionable. Out-of-window sends ride the owner-alert utility
  // template; a template still in Meta review is likewise recorded as
  // skipped, never failed.
  //
  // The connection check is the OUTERMOST gate on purpose. It used to sit
  // below the no-phone / toggle-off branches, so a never-connected tenant
  // still collected `no_phone` and `whatsapp_urgent_disabled` rows, the
  // same noise, arriving through a different door.
  if (!targets.whatsappConnected) {
    // Not applicable to this business: no row, no delivery attempt.
  } else if (targets.routing?.target === "team_broadcast") {
    // An unowned-lead broadcast is many recipients; this leg is single
    // recipient and owner-shaped (it reads the OWNER's language preference
    // and rides the owner-alert template). WhatsApping only the first
    // teammate would deliver to an arbitrary subset of the audience, so the
    // whole team takes the SMS above and this channel sits out. No row, same
    // reasoning as the never-connected case: not a WhatsApp-shaped event.
  } else if (!targets.phone) {
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
    // The summary usually ends with "." and the template appends its own;
    // trim trailing periods so the alert never reads "dashboard.. Details:".
    const text =
      phiFree?.smsBody ??
      input.smsBody ??
      `New Coworker Alert: ${summary.replace(/\.+$/, "")}. Details: ${dashboardUrl}`;
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
      } else if (delivered.reason === "not_connected") {
        // Never connected: the channel is not applicable, no row (see the
        // section comment above).
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

  // 5) Slack channel. Same never-connected silence rule as WhatsApp: a
  // business that never connected Slack records NOTHING here. A connected
  // workspace with a problem (uninstalled, no channel picked, tier) records
  // an honest owner-actionable skip row. Delivery details (tier re-check,
  // channel resolution, the actual post) live in deliverSlackAlert.
  if (!targets.slackConnected) {
    // Not applicable to this business: no row, no delivery attempt.
  } else if (!targets.slackUrgentEnabled || targets.unsubscribed) {
    results.push(
      await recordRow(
        input.businessId,
        "slack",
        "skipped",
        summary,
        kind,
        payload,
        targets.unsubscribed ? "unsubscribed" : "slack_urgent_disabled"
      )
    );
  } else {
    const text =
      phiFree?.smsBody ??
      input.smsBody ??
      `New Coworker Alert: ${summary.replace(/\.+$/, "")}. Details: ${dashboardUrl}`;
    try {
      const delivered = await deliverSlackAlert({
        businessId: input.businessId,
        text,
        blocks: buildSlackAlertBlocks({
          summary: phiFree?.summary ?? summary,
          detailsUrl: dashboardUrl
        })
      });
      if (delivered.ok) {
        results.push(
          await recordRow(input.businessId, "slack", "sent", summary, kind, {
            ...payload,
            recipient: delivered.channelName
              ? `#${delivered.channelName}`
              : delivered.channelId
          })
        );
      } else if (delivered.reason === "not_connected") {
        // Raced a disconnect since the existence check: treat as never
        // connected, no row (see the section comment above).
      } else {
        results.push(
          await recordRow(
            input.businessId,
            "slack",
            delivered.reason === "send_failed" ? "failed" : "skipped",
            summary,
            kind,
            payload,
            delivered.detail ? `${delivered.reason}:${delivered.detail}` : delivered.reason
          )
        );
      }
    } catch (err) {
      logger.warn("notifications.dispatch: slack send failed", {
        businessId: input.businessId,
        error: err instanceof Error ? err.message : String(err)
      });
      results.push(
        await recordRow(
          input.businessId,
          "slack",
          "failed",
          summary,
          kind,
          payload,
          err instanceof Error ? err.message : "send_failed"
        )
      );
    }
  }

  await reportFailedChannels(input.businessId, kind, summary, results);
  return { results };
}

/**
 * Raise a failed alert delivery onto the admin dashboard's System Errors
 * card (any `system_logs` row at level "error" lands there).
 *
 * Why this exists. Alert-send failures were already RECORDED on the
 * notification row and nothing ever read them, so a tenant whose owner
 * alerts had been failing for weeks looked identical to a healthy one. KYP
 * Ads' team texts had been failing to an unreachable number since late July
 * and surfaced only when a lead sat waiting on a Zoom. Recorded is not the
 * same as noticed.
 *
 * One row per dispatch, not per channel, and only when something actually
 * failed: a `skipped` channel is a decision, not a fault. The message
 * distinguishes a partial failure from an alert that reached NOBODY, which
 * is the one worth waking up for.
 */
export async function reportFailedChannels(
  businessId: string,
  kind: NotificationKind,
  summary: string,
  results: DispatchChannelResult[]
): Promise<void> {
  const failed = results.filter((r) => r.status === "failed");
  if (failed.length === 0) return;
  const delivered = results.filter((r) => r.status === "sent");
  await recordSystemLog({
    businessId,
    level: "error",
    source: "notifications",
    event: "alert_delivery_failed",
    message:
      (delivered.length === 0
        ? "An urgent alert reached NOBODY: "
        : "An urgent alert failed on some channels: ") +
      failed.map((f) => `${f.channel} (${f.reason ?? "no reason given"})`).join(", ") +
      (delivered.length > 0
        ? `. Delivered on ${delivered.map((d) => d.channel).join(", ")}.`
        : "."),
    payload: {
      kind,
      summary,
      failedChannels: failed.map((f) => ({ channel: f.channel, reason: f.reason ?? null })),
      deliveredChannels: delivered.map((d) => d.channel)
    }
  });
}

export type { NotificationRow };
