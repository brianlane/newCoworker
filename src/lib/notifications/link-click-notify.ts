/**
 * Owner alert when a lead taps a tracked SMS short link.
 * Called from the public /s/<code> redirect route — fire-and-forget.
 *
 * Truthfulness gates, in order:
 *   1. The RPC's `should_notify` — true exactly once per link, for the first
 *      click OUTSIDE the prefetch window (delivery-time preview fetches are
 *      logged but never alert; `notified_at` stamps the dedupe atomically).
 *   2. Per-contact throttle — a lead tapping links in several messages of
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
};

/** At most one link_click alert per contact per hour. */
export const LINK_CLICK_CONTACT_THROTTLE_MS = 60 * 60 * 1000;

type ServiceClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

/**
 * Give the link its alert back. The RPC stamps `notified_at` atomically with
 * `should_notify` (that is the concurrent-tap dedupe), so any path that ends
 * WITHOUT an owner alert must release the stamp — otherwise this link's one
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

function linkDestinationLabel(url: string): string {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    if (/calendly/i.test(host)) return "booking link";
    if (/cal\.com/i.test(host)) return "booking link";
    return host || "link";
  } catch {
    return "link";
  }
}

export async function notifyLinkClick(result: LinkClickRpcResult): Promise<void> {
  if (!result.should_notify) return;

  const db = await createSupabaseServiceClient();

  // Per-contact collapse: several links first-tapped in one sitting (the
  // greeting's and the nudges' links all point at the same booking page)
  // must not each ping the owner. Fail toward delivering — a throttle read
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
        // No alert went out for THIS link — release its stamp so a tap in a
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

  const destLabel = linkDestinationLabel(result.original_url);
  const summary = `${contactLabel} tapped your ${destLabel}`;
  const phoneSuffix =
    result.to_e164 && contactLabel !== result.to_e164 ? ` (${result.to_e164})` : "";
  const smsBody = `${businessName}: ${contactLabel}${phoneSuffix} just opened your ${destLabel}.`;
  const threadHref = result.to_e164
    ? `/dashboard/messages/${encodeURIComponent(result.to_e164)}`
    : "/dashboard/messages";

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
        thread_href: threadHref
      },
      smsBody,
      emailSubject: `Lead link click: ${contactLabel}`
    });
  } catch (err) {
    logger.warn("link-click-notify: dispatch failed", {
      businessId: result.business_id,
      linkId: result.link_id,
      error: err instanceof Error ? err.message : String(err)
    });
    // A THROWN dispatch means no alert and no audit rows — give the alert
    // back so the lead's next human tap retries (the hourly throttle bounds
    // how often).
    await releaseNotifyStamp(db, result);
  }
}
