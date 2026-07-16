/**
 * Thread view for one Messenger/Instagram DM conversation, with a manual
 * owner reply box (sends through the same 24h-window-gated Send API path
 * the AI uses).
 *
 * IDOR guard: the conversation row is resolved by id and then verified
 * against the caller's ACTIVE business before any message read — a
 * guessed UUID renders the same not-found state as a missing row
 * (webchat transcript pattern).
 */

import Link from "next/link";
import { redirect } from "next/navigation";
import { resolveActiveBusinessId } from "@/lib/dashboard/active-business";
import { getAuthUser } from "@/lib/auth";
import { Card } from "@/components/ui/Card";
import { LocalDateTime } from "@/components/dashboard/LocalDateTime";
import { MessengerReplyForm } from "@/components/dashboard/MessengerReplyForm";
import {
  getMessengerConversationById,
  listMessengerMessages,
  messengerWindowOpen
} from "@/lib/messenger/db";

export const dynamic = "force-dynamic";

export default async function MessengerConversationPage({
  params
}: {
  params: Promise<{ conversationId: string }>;
}) {
  const { conversationId } = await params;
  const user = await getAuthUser();
  if (!user) redirect("/login?redirectTo=/dashboard/messenger");

  const activeBusinessId = await resolveActiveBusinessId(user);

  const uuidOk = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    conversationId
  );
  const conversation = uuidOk ? await getMessengerConversationById(conversationId) : null;
  const owned =
    conversation && activeBusinessId && conversation.business_id === activeBusinessId;

  if (!owned) {
    return (
      <div className="space-y-6 max-w-3xl">
        <Card>
          <p className="text-parchment/60 text-center py-8">Conversation not found.</p>
        </Card>
        <Link href="/dashboard/messenger" className="text-sm text-claw-green hover:underline">
          ← Back to Messenger
        </Link>
      </div>
    );
  }

  const messages = await listMessengerMessages(conversation.id);
  const who =
    conversation.display_name ||
    conversation.contact_phone ||
    `Lead ${conversation.psid.slice(-6)}`;
  const windowOpen = messengerWindowOpen(conversation);

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <Link href="/dashboard/messenger" className="text-sm text-claw-green hover:underline">
          ← Back to Messenger
        </Link>
        <h1 className="text-2xl font-bold text-parchment mt-2">{who}</h1>
        <p className="text-sm text-parchment/50 mt-1">
          {conversation.platform === "instagram"
            ? "Instagram"
            : conversation.platform === "whatsapp"
              ? "WhatsApp"
              : "Messenger"}
          {conversation.contact_phone ? ` · ${conversation.contact_phone}` : ""}
          {" · started "}
          <LocalDateTime iso={conversation.created_at} style="list" />
        </p>
      </div>

      <Card>
        {messages.length === 0 ? (
          <p className="text-parchment/60 text-center py-8">No messages yet.</p>
        ) : (
          <div className="space-y-3">
            {messages.map((m) => (
              <div
                key={m.id}
                className={`max-w-[85%] rounded-xl px-4 py-2.5 text-sm whitespace-pre-wrap ${
                  m.role === "user"
                    ? "bg-claw-green/15 text-parchment ml-auto"
                    : m.role === "owner"
                      ? "bg-signal-teal/15 text-parchment/90"
                      : "bg-parchment/5 text-parchment/90"
                }`}
              >
                {m.role === "owner" ? (
                  <span className="block text-[10px] uppercase tracking-wider text-signal-teal/70 mb-0.5">
                    You
                  </span>
                ) : null}
                {m.content}
                <span className="block text-[10px] text-parchment/30 mt-1">
                  <LocalDateTime iso={m.created_at} style="list" />
                </span>
              </div>
            ))}
          </div>
        )}
      </Card>

      {windowOpen ? (
        <MessengerReplyForm
          businessId={conversation.business_id}
          conversationId={conversation.id}
          maxLength={conversation.platform === "whatsapp" ? 4096 : 2000}
        />
      ) : (
        <Card>
          <p className="text-xs text-parchment/50">
            Meta&apos;s 24-hour reply window has closed for this conversation — it
            reopens the moment the lead messages again.
            {conversation.contact_phone
              ? " You can still text them from the Texts page."
              : " Capture their phone number next time to follow up by text."}
          </p>
        </Card>
      )}
    </div>
  );
}
