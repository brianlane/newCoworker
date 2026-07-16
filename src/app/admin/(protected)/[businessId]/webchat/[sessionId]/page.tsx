/**
 * Admin read-only transcript for one website-chat-widget session.
 *
 * Same rendering as the owner-facing /dashboard/webchat/[sessionId] view.
 * IDOR guard: the session must belong to the businessId in the URL — a
 * guessed session UUID under the wrong business renders the same
 * not-found state as a missing row.
 */

import Link from "next/link";
import { Card } from "@/components/ui/Card";
import { LocalDateTime } from "@/components/dashboard/LocalDateTime";
import { getWebchatSessionById, listWebchatMessages } from "@/lib/webchat/db";
import { VisitorMetaCard } from "@/components/webchat/VisitorMetaCard";

export const dynamic = "force-dynamic";

export default async function AdminWebchatSessionPage({
  params
}: {
  params: Promise<{ businessId: string; sessionId: string }>;
}) {
  const { businessId, sessionId } = await params;

  const uuidOk = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    sessionId
  );
  const session = uuidOk ? await getWebchatSessionById(sessionId) : null;
  const owned = session && session.business_id === businessId;

  if (!owned) {
    return (
      <div className="space-y-6 max-w-3xl">
        <Card>
          <p className="text-parchment/60 text-center py-8">Conversation not found.</p>
        </Card>
        <Link
          href={`/admin/${businessId}/webchat`}
          className="text-sm text-claw-green hover:underline"
        >
          ← Back to web chats
        </Link>
      </div>
    );
  }

  const messages = await listWebchatMessages(session.id);
  const who =
    session.visitor_name || session.visitor_email || session.visitor_phone || "Anonymous visitor";

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <Link
          href={`/admin/${businessId}/webchat`}
          className="text-sm text-claw-green hover:underline"
        >
          ← Back to web chats
        </Link>
        <h1 className="text-2xl font-bold text-parchment mt-2">{who}</h1>
        <p className="text-sm text-parchment/50 mt-1">
          {[session.visitor_email, session.visitor_phone].filter(Boolean).join(" · ") ||
            "No contact details captured"}
          {" · started "}
          <LocalDateTime iso={session.created_at} style="list" />
        </p>
      </div>

      <VisitorMetaCard visitorMeta={session.visitor_meta ?? null} />

      <Card>
        {messages.length === 0 ? (
          <p className="text-parchment/60 text-center py-8">No messages in this session.</p>
        ) : (
          <div className="space-y-3">
            {messages.map((m) => (
              <div
                key={m.id}
                className={`max-w-[85%] rounded-xl px-4 py-2.5 text-sm whitespace-pre-wrap ${
                  m.role === "user"
                    ? "bg-claw-green/15 text-parchment ml-auto"
                    : m.role === "assistant"
                      ? "bg-parchment/5 text-parchment/90"
                      : "text-parchment/40 text-xs text-center mx-auto bg-transparent"
                }`}
              >
                {m.content}
                <span className="block text-[10px] text-parchment/30 mt-1">
                  <LocalDateTime iso={m.created_at} style="list" />
                </span>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
