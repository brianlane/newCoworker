/**
 * Owner alert when a lead taps a tracked SMS short link.
 * Called from the public /s/<code> redirect route, fire-and-forget.
 *
 * Truthfulness gates, in order:
 *   1. The RPC's `should_notify`, true exactly once per link, for the first
 *      click OUTSIDE the prefetch window (delivery-time preview fetches are
 *      logged but never alert; `notified_at` stamps the dedupe atomically).
 *   2. Per-contact throttle, a lead tapping links in several messages of
 *      one thread is ONE engagement moment: at most one alert per contact
 *      per hour, other leads unaffected.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { resolveContactNames } from "@/lib/db/contact-names";
import { hasRecentNotificationForContact } from "@/lib/db/notifications";
import { dispatchUrgentNotification } from "@/lib/notifications/dispatch";
import { logger } from "@/lib/logger";

export type LinkClickRpcResult = {
  ok: true;
  url: string;
  business_id: string;
  link_id: string;
  short_code: string;
  click_count: number;
  to_e164: string | null;
  original_url: string;
  flow_id: string | null;
  run_id: string | null;
  is_first_click: boolean;
  is_prefetch: boolean;
  should_notify: boolean;
  /**
   * False for an owner/teammate notification link: the RPC resolved it
   * without recording anything, so the stats fields above are absent and
   * there is nothing to alert about. Optional because rows predating the
   * column, and the tracked branch of the RPC, simply say true.
   */
  tracked?: boolean;
};

/** At most one link_click alert per contact per hour. */
export const LINK_CLICK_CONTACT_THROTTLE_MS = 60 * 60 * 1000;

type ServiceClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

/**
 * Give the link its alert back. The RPC stamps `notified_at` atomically with
 * `should_notify` (that is the concurrent-tap dedupe), so any path that ends
 * WITHOUT an owner alert must release the stamp, otherwise this link's one
 * alert is consumed by a notification that never happened. Best-effort: a
 * failed release stays at-most-once by design (never alert-storms).
 */
async function releaseNotifyStamp(db: ServiceClient, result: LinkClickRpcResult): Promise<void> {
  try {
    await db.from("sms_links").update({ notified_at: null }).eq("id", result.link_id);
  } catch (err) {
    logger.warn("link-click-notify: notified_at release failed", {
      businessId: result.business_id,
      linkId: result.link_id,
      error: err instanceof Error ? err.message : String(err)
    });
  }
}

/**
 * Longest destination we inline into an alert. Long enough to identify a
 * page, short enough that a Stripe Checkout URL (which runs to hundreds of
 * characters of opaque session id) cannot turn one SMS into four.
 */
const MAX_DESTINATION_DISPLAY = 60;

/**
 * What the lead actually opened, as a human label plus a compact address.
 *
 * The label alone used to be the whole alert, and it was only ever the
 * hostname, so every tap on anything we host read "tapped your
 * newcoworker.com". On 2026-08-24 a lead asked for a payment link, the
 * coworker answered with the signup questionnaire, and the owner could not
 * tell from the alert which of the two he had been sent. The address is what
 * makes the alert answer that question without a database query.
 */
export function describeLinkDestination(url: string): { label: string; display: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { label: "link", display: "link" };
  }

  const host = parsed.hostname.replace(/^www\./, "");
  const path = parsed.pathname === "/" ? "" : parsed.pathname;
  const full = `${host}${path}`;
  const display =
    full.length > MAX_DESTINATION_DISPLAY
      ? `${full.slice(0, MAX_DESTINATION_DISPLAY - 3)}...`
      : full || "link";

  // Recognized destinations are named, because "payment link" is the thing
  // an owner reacts to; the address below it is the proof.
  if (/(^|\.)stripe\.com$/i.test(host) || path.startsWith("/pay/")) {
    return { label: "payment link", display };
  }
  if (/calendly/i.test(host) || /(^|\.)cal\.com$/i.test(host) || path.startsWith("/book/")) {
    return { label: "booking link", display };
  }
  if (path.startsWith("/onboard")) {
    return { label: "signup questionnaire", display };
  }
  // Unrecognized: the address IS the most useful label. Returning it as both
  // keeps the caller from rendering "example.com: example.com/offer".
  return { label: display, display };
}

/**
 * "payment link: checkout.stripe.com/..." for a destination we can name,
 * and just the address otherwise, so a label never repeats itself.
 */
export function linkDestinationPhrase(url: string): string {
  const { label, display } = describeLinkDestination(url);
  return label === display ? label : `${label}: ${display}`;
}

/**
 * Which surface sent the link. An owner reading "sent by your AI coworker's
 * reply" knows immediately whether to go correct the agent or their own
 * copy, which is the first question every one of these alerts raises.
 */
const LINK_SOURCE_LABELS: Record<string, string> = {
  sms_auto_reply: "your AI coworker's reply",
  ai_flow: "an AiFlow",
  aiflow: "an AiFlow",
  voice_follow_up: "a call follow up",
  owner_notify: "an owner alert",
  owner_manual: "a message you sent"
};

export function linkSourceLabel(source: string | null | undefined): string | null {
  if (!source) return null;
  return LINK_SOURCE_LABELS[source] ?? source;
}

export async function notifyLinkClick(result: LinkClickRpcResult): Promise<void> {
  // An owner/teammate link records no clicks at all, so there is no
  // engagement to report. Checked ahead of should_notify so the guarantee is
  // stated here too, not left resting on the RPC's flag alone.
  if (result.tracked === false) return;
  if (!result.should_notify) return;

  const db = await createSupabaseServiceClient();

  // Per-contact collapse: several links first-tapped in one sitting (the
  // greeting's and the nudges' links all point at the same booking page)
  // must not each ping the owner. Fail toward delivering, a throttle read
  // error must not eat a real engagement alert.
  if (result.to_e164) {
    try {
      const recent = await hasRecentNotificationForContact(
        result.business_id,
        "link_click",
        result.to_e164,
        LINK_CLICK_CONTACT_THROTTLE_MS,
        db
      );
      if (recent) {
        // No alert went out for THIS link, release its stamp so a tap in a
        // later engagement moment (past the throttle window) still alerts.
        await releaseNotifyStamp(db, result);
        return;
      }
    } catch (err) {
      logger.warn("link-click-notify: throttle check failed; delivering", {
        businessId: result.business_id,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  const { data: business } = await db
    .from("businesses")
    .select("name")
    .eq("id", result.business_id)
    .maybeSingle();
  const businessName = (business as { name?: string } | null)?.name?.trim() || "Your business";

  let contactLabel = "A lead";
  if (result.to_e164) {
    const names = await resolveContactNames(result.business_id, [result.to_e164], db);
    contactLabel = names.get(result.to_e164)?.name ?? result.to_e164;
  }

  const { label: destLabel } = describeLinkDestination(result.original_url);
  const destPhrase = linkDestinationPhrase(result.original_url);
  const summary = `${contactLabel} tapped your ${destPhrase}`;
  const phoneSuffix =
    result.to_e164 && contactLabel !== result.to_e164 ? ` (${result.to_e164})` : "";
  const smsBody = `${businessName}: ${contactLabel}${phoneSuffix} just opened your ${destPhrase}`;
  const threadHref = result.to_e164
    ? `/dashboard/messages/${encodeURIComponent(result.to_e164)}`
    : "/dashboard/messages";

  // `sms_links.source` is not in the RPC's return, and adding it there would
  // be a migration for one string. This read only happens on the alert path,
  // which is already past both the once-per-link stamp and the hourly
  // per-contact throttle, so it is rare by construction. Best-effort: the
  // alert is worth more than the attribution line.
  let sourceLabel: string | null = null;
  try {
    const { data: linkRow } = await db
      .from("sms_links")
      .select("source")
      .eq("id", result.link_id)
      .maybeSingle();
    sourceLabel = linkSourceLabel((linkRow as { source?: string | null } | null)?.source);
  } catch (err) {
    logger.warn("link-click-notify: source lookup failed", {
      businessId: result.business_id,
      linkId: result.link_id,
      error: err instanceof Error ? err.message : String(err)
    });
  }

  // The email has room the SMS does not, so it carries the UNtruncated
  // destination: the address is the whole point of the alert.
  const emailBody = [
    `${contactLabel}${phoneSuffix} opened your ${destPhrase}.`,
    `Where it went: ${result.original_url}`,
    sourceLabel ? `Sent by: ${sourceLabel}` : null
  ]
    .filter(Boolean)
    .join("\n\n");

  try {
    await dispatchUrgentNotification({
      businessId: result.business_id,
      summary,
      kind: "link_click",
      payload: {
        link_id: result.link_id,
        short_code: result.short_code,
        original_url: result.original_url,
        to_e164: result.to_e164,
        flow_id: result.flow_id,
        run_id: result.run_id,
        click_count: result.click_count,
        thread_href: threadHref,
        destination_label: destLabel,
        source: sourceLabel
      },
      smsBody,
      emailSubject: `Lead link click: ${contactLabel} opened your ${destLabel}`,
      emailBody,
      // Without this the button said "Open dashboard" and landed on the bare
      // dashboard, one more hop from the conversation the alert is about.
      ctaPath: threadHref,
      ctaLabel: "Open the conversation"
    });
  } catch (err) {
    logger.warn("link-click-notify: dispatch failed", {
      businessId: result.business_id,
      linkId: result.link_id,
      error: err instanceof Error ? err.message : String(err)
    });
    // A THROWN dispatch means no alert and no audit rows, give the alert
    // back so the lead's next human tap retries (the hourly throttle bounds
    // how often).
    await releaseNotifyStamp(db, result);
  }
}
