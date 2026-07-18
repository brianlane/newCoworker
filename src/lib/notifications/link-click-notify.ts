/**
 * Owner alert when a lead taps a tracked SMS short link for the first time.
 * Called from the public /s/<code> redirect route — fire-and-forget.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { resolveContactNames } from "@/lib/db/contact-names";
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
};

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

export async function notifyLinkClickFirstTap(result: LinkClickRpcResult): Promise<void> {
  if (!result.is_first_click) return;

  const db = await createSupabaseServiceClient();
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
  }
}
