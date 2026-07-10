/**
 * Read-only transcript view for one website-chat-widget session.
 *
 * IDOR guard: the session row is resolved by id and then verified against
 * the caller's ACTIVE business before any message read — a guessed UUID
 * renders the same not-found state as a missing row.
 */

import Link from "next/link";
import { redirect } from "next/navigation";
import { resolveActiveBusinessId } from "@/lib/dashboard/active-business";
import { getAuthUser } from "@/lib/auth";
import { Card } from "@/components/ui/Card";
import { LocalDateTime } from "@/components/dashboard/LocalDateTime";
import {
  getWebchatSessionById,
  listWebchatMessages
} from "@/lib/webchat/db";

export const dynamic = "force-dynamic";

export default async function WebchatSessionPage({
  params
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const { sessionId } = await params;
  const user = await getAuthUser();
  if (!user) redirect("/login?redirectTo=/dashboard/webchat");

  const activeBusinessId = await resolveActiveBusinessId(user);

  const uuidOk = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    sessionId
  );
  const session = uuidOk ? await getWebchatSessionById(sessionId) : null;
  const owned = session && activeBusinessId && session.business_id === activeBusinessId;

  if (!owned) {
    return (
      <div className="space-y-6 max-w-3xl">
        <Card>
          <p className="text-parchment/60 text-center py-8">Conversation not found.</p>
        </Card>
        <Link href="/dashboard/webchat" className="text-sm text-claw-green hover:underline">
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
        <Link href="/dashboard/webchat" className="text-sm text-claw-green hover:underline">
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
