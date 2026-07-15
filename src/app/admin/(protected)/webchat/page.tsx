/**
 * Admin sidebar Web chat view: visitor transcripts from the PLATFORM'S OWN
 * newcoworker.com chat widget.
 *
 * That widget runs on the direct-Gemini reply engine with no tenant
 * dashboard behind it, so this page is the only place its conversations
 * are reviewed. The backing business is resolved the same way the
 * marketing page embeds the widget — NEXT_PUBLIC_WEBCHAT_SITE_KEY →
 * chat_widget_settings by key hash — so rotating the key or re-pointing
 * it at another business keeps this view honest with zero config drift.
 * Rows link into the per-business transcript pages that ship with the
 * admin Web chat card.
 */

import Link from "next/link";
import { Card } from "@/components/ui/Card";
import { LocalDateTime } from "@/components/dashboard/LocalDateTime";
import { hashWebchatToken, parseWidgetKey } from "@/lib/webchat/keys";
import {
  getWidgetSettingsByKeyHash,
  listWebchatSessionsForBusiness
} from "@/lib/webchat/db";

export const dynamic = "force-dynamic";

export default async function AdminSiteWebchatPage() {
  const header = (
    <div>
      <h1 className="text-2xl font-bold text-parchment">Web chat</h1>
      <p className="text-sm text-parchment/50 mt-1">
        Visitor conversations from the chat widget on newcoworker.com
      </p>
    </div>
  );

  const siteKey = parseWidgetKey(process.env.NEXT_PUBLIC_WEBCHAT_SITE_KEY);
  const settings = siteKey
    ? await getWidgetSettingsByKeyHash(hashWebchatToken(siteKey))
    : null;

  if (!settings) {
    return (
      <div className="space-y-6 max-w-4xl">
        {header}
        <Card>
          <p className="text-parchment/60 text-center py-8">
            {siteKey
              ? "The configured site key doesn't resolve to a widget — was it rotated without updating NEXT_PUBLIC_WEBCHAT_SITE_KEY?"
              : "NEXT_PUBLIC_WEBCHAT_SITE_KEY is not set, so no widget is running on newcoworker.com."}
          </p>
        </Card>
      </div>
    );
  }

  const sessions = await listWebchatSessionsForBusiness(settings.business_id, {
    limit: 100
  });

  return (
    <div className="space-y-6 max-w-4xl">
      <div className="flex items-start justify-between gap-4">
        {header}
        <Link
          href={`/admin/${settings.business_id}`}
          className="text-sm text-claw-green hover:underline shrink-0 mt-1"
        >
          Backing business →
        </Link>
      </div>

      {sessions.length === 0 ? (
        <Card>
          <p className="text-parchment/60 text-center py-8">No web chat sessions yet.</p>
        </Card>
      ) : (
        <Card>
          <ul className="divide-y divide-parchment/10">
            {sessions.map((s) => {
              const who =
                s.visitor_name || s.visitor_email || s.visitor_phone || "Anonymous visitor";
              const contactBits = [s.visitor_email, s.visitor_phone]
                .filter((v) => v && v !== who)
                .join(" · ");
              return (
                <li key={s.id}>
                  <Link
                    href={`/admin/${s.business_id}/webchat/${s.id}`}
                    className="flex items-center justify-between gap-4 py-3 px-1 hover:bg-parchment/5 rounded-lg transition-colors"
                  >
                    <div className="min-w-0">
                      <p className="text-sm text-parchment truncate">{who}</p>
                      <p className="text-xs text-parchment/40 truncate">
                        {contactBits || "No contact details captured"}
                      </p>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-xs text-parchment/60">
                        {s.message_count} message{s.message_count === 1 ? "" : "s"}
                      </p>
                      <p className="text-xs text-parchment/40">
                        <LocalDateTime iso={s.last_seen_at} style="list" />
                      </p>
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        </Card>
      )}
    </div>
  );
}
