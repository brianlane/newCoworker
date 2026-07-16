/**
 * Owner-facing WhatsApp conversation index — the platform-filtered twin of
 * /dashboard/messenger (threads open in the shared conversation view).
 * Reached via a sidebar item that only renders once the business has an
 * ACTIVE WhatsApp connection; direct URL access without one gets a
 * friendly "connect WhatsApp first" state instead of a 404.
 */

import Link from "next/link";
import { redirect } from "next/navigation";
import { resolveActiveBusinessId } from "@/lib/dashboard/active-business";
import { getAuthUser } from "@/lib/auth";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { Card } from "@/components/ui/Card";
import { LocalDateTime } from "@/components/dashboard/LocalDateTime";
import { listMessengerConversationsForBusiness } from "@/lib/messenger/db";
import { getPublicWhatsAppConnection } from "@/lib/db/whatsapp-connections";

export const dynamic = "force-dynamic";

export default async function DashboardWhatsAppPage() {
  const user = await getAuthUser();
  if (!user) redirect("/login?redirectTo=/dashboard/whatsapp");
  if (!user.email) redirect("/login?redirectTo=/dashboard/whatsapp");

  const db = await createSupabaseServiceClient();
  const activeBusinessId = await resolveActiveBusinessId(user);
  const { data: businesses } = await db
    .from("businesses")
    .select("id, name")
    .in("id", activeBusinessId ? [activeBusinessId] : [])
    .limit(1);

  const business = businesses?.[0] ?? null;

  const header = (
    <div>
      <h1 className="text-2xl font-bold text-parchment">WhatsApp</h1>
      <p className="text-sm text-parchment/50 mt-1">
        WhatsApp conversations with your business number
      </p>
    </div>
  );

  if (!business) {
    return (
      <div className="space-y-6 max-w-4xl">
        {header}
        <Card>
          <div className="text-center py-8">
            <p className="text-parchment/60 mb-4">No coworker provisioned yet.</p>
            <a
              href="/onboard"
              className="inline-block rounded-lg bg-claw-green text-deep-ink px-5 py-2.5 font-semibold text-sm hover:bg-opacity-90 transition-colors"
            >
              Get Started →
            </a>
          </div>
        </Card>
      </div>
    );
  }

  const connection = await getPublicWhatsAppConnection(business.id).catch(() => null);
  if (!connection?.is_active) {
    return (
      <div className="space-y-6 max-w-4xl">
        {header}
        <Card>
          <div className="text-center py-8">
            <p className="text-parchment/60 mb-2">
              Connect WhatsApp Business first to chat with leads here.
            </p>
            <p className="text-xs text-parchment/40 mb-4">
              Once connected, every WhatsApp message lands here, your coworker replies
              within seconds, and AiFlows can message contacts on WhatsApp too.
            </p>
            <Link
              href="/dashboard/integrations/whatsapp"
              className="inline-block rounded-lg bg-claw-green text-deep-ink px-5 py-2.5 font-semibold text-sm hover:bg-opacity-90 transition-colors"
            >
              Connect WhatsApp →
            </Link>
          </div>
        </Card>
      </div>
    );
  }

  const conversations = await listMessengerConversationsForBusiness(business.id, {
    limit: 50,
    platform: "whatsapp"
  });

  return (
    <div className="space-y-6 max-w-4xl">
      {header}

      {conversations.length === 0 ? (
        <Card>
          <div className="text-center py-8">
            <p className="text-parchment/60">No conversations yet.</p>
            <p className="text-xs text-parchment/40 mt-2">
              When someone messages your WhatsApp number
              {connection.display_phone_number ? ` (${connection.display_phone_number})` : ""},
              the conversation appears here and your coworker replies automatically.
            </p>
          </div>
        </Card>
      ) : (
        <Card>
          <ul className="divide-y divide-parchment/10">
            {conversations.map((c) => {
              const who = c.display_name || c.contact_phone || `+${c.psid}`;
              return (
                <li key={c.id}>
                  <a
                    href={`/dashboard/messenger/${c.id}`}
                    className="flex items-center justify-between gap-4 py-3 px-1 hover:bg-parchment/5 rounded-lg transition-colors"
                  >
                    <div className="min-w-0">
                      <p className="text-sm text-parchment truncate">{who}</p>
                      <p className="text-xs text-parchment/40 truncate">
                        WhatsApp
                        {c.contact_phone && c.contact_phone !== who
                          ? ` · ${c.contact_phone}`
                          : ""}
                      </p>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-xs text-parchment/60">
                        {c.message_count} message{c.message_count === 1 ? "" : "s"}
                      </p>
                      <p className="text-xs text-parchment/40">
                        <LocalDateTime iso={c.last_user_message_at} style="list" />
                      </p>
                    </div>
                  </a>
                </li>
              );
            })}
          </ul>
        </Card>
      )}
    </div>
  );
}
