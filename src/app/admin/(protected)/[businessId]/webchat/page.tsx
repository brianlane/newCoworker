/**
 * Admin review of a business's website-chat-widget conversations.
 *
 * Exists because a widget can run with NO tenant dashboard behind it: the
 * platform's own newcoworker.com chat is a direct-Gemini tenant nobody
 * logs into, so visitor transcripts must be reviewable from the admin
 * side. Mirrors the owner-facing /dashboard/webchat index (same db
 * helpers, same list shape); auth is the admin (protected) layout.
 */

import Link from "next/link";
import { notFound } from "next/navigation";
import { getBusiness } from "@/lib/db/businesses";
import { Card } from "@/components/ui/Card";
import { LocalDateTime } from "@/components/dashboard/LocalDateTime";
import { listWebchatSessionsForBusiness } from "@/lib/webchat/db";

export const dynamic = "force-dynamic";

export default async function AdminWebchatPage({
  params
}: {
  params: Promise<{ businessId: string }>;
}) {
  const { businessId } = await params;
  const business = await getBusiness(businessId);
  if (!business) notFound();

  const sessions = await listWebchatSessionsForBusiness(businessId, { limit: 100 });

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <Link
          href={`/admin/${businessId}`}
          className="text-sm text-claw-green hover:underline"
        >
          ← Back to {business.name || "business"}
        </Link>
        <h1 className="text-2xl font-bold text-parchment mt-2">Web chat conversations</h1>
        <p className="text-sm text-parchment/50 mt-1">
          Visitor sessions from the chat widget on this business&apos;s website
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
                    href={`/admin/${businessId}/webchat/${s.id}`}
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
