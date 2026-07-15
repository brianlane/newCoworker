/**
 * Fleet-wide admin Web chat index (sidebar item): the most recent widget
 * conversations across EVERY business, newest activity first. Exists so
 * visitor messages are reviewable even for widgets with no tenant
 * dashboard behind them — e.g. the platform's own newcoworker.com chat,
 * whose direct-Gemini tenant nobody logs into. Each row links into the
 * per-business transcript view shipped with the Web chat card.
 */

import Link from "next/link";
import { Card } from "@/components/ui/Card";
import { LocalDateTime } from "@/components/dashboard/LocalDateTime";
import { listRecentWebchatSessions } from "@/lib/webchat/db";

export const dynamic = "force-dynamic";

export default async function AdminWebchatIndexPage() {
  const sessions = await listRecentWebchatSessions({ limit: 100 });

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h1 className="text-2xl font-bold text-parchment">Web chat</h1>
        <p className="text-sm text-parchment/50 mt-1">
          Recent website-widget conversations across all businesses
        </p>
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
                        {s.business_name || s.business_id}
                        {contactBits ? ` · ${contactBits}` : ""}
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
