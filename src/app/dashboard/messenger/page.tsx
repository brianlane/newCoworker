/**
 * Owner-facing Messenger/Instagram DM conversation index.
 *
 * Mirrors the Web chat index: server-component list of conversations with
 * captured contact details, each linking into the thread view. Reached
 * via a sidebar item that only renders once the business has an ACTIVE
 * Meta connection — direct URL access without one gets a friendly
 * "connect Facebook first" state instead of a 404.
 */

import Link from "next/link";
import { redirect } from "next/navigation";
import { resolveActiveBusinessId } from "@/lib/dashboard/active-business";
import { getAuthUser } from "@/lib/auth";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { Card } from "@/components/ui/Card";
import { LocalDateTime } from "@/components/dashboard/LocalDateTime";
import { listMessengerConversationsForBusiness } from "@/lib/messenger/db";
import { getPublicMetaConnection } from "@/lib/db/meta-connections";

export const dynamic = "force-dynamic";

export default async function DashboardMessengerPage() {
  const user = await getAuthUser();
  if (!user) redirect("/login?redirectTo=/dashboard/messenger");
  if (!user.email) redirect("/login?redirectTo=/dashboard/messenger");

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
      <h1 className="text-2xl font-bold text-parchment">Messenger</h1>
      <p className="text-sm text-parchment/50 mt-1">
        Facebook Messenger and Instagram DM conversations with your Page
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

  const connection = await getPublicMetaConnection(business.id).catch(() => null);
  // Same gate as the sidebar: paused (is_active=false) connections stop
  // webhook routing and sends, so the inbox points back to Integrations.
  if (connection?.status !== "active" || !connection.is_active) {
    return (
      <div className="space-y-6 max-w-4xl">
        {header}
        <Card>
          <div className="text-center py-8">
            <p className="text-parchment/60 mb-2">
              Connect your Facebook Page first to chat with leads on Messenger.
            </p>
            <p className="text-xs text-parchment/40 mb-4">
              Once connected, every Messenger and Instagram DM lands here and your
              coworker replies within seconds.
            </p>
            <Link
              href="/dashboard/integrations/meta"
              className="inline-block rounded-lg bg-claw-green text-deep-ink px-5 py-2.5 font-semibold text-sm hover:bg-opacity-90 transition-colors"
            >
              Connect Facebook →
            </Link>
          </div>
        </Card>
      </div>
    );
  }

  const conversations = await listMessengerConversationsForBusiness(business.id, {
    limit: 50
  });

  return (
    <div className="space-y-6 max-w-4xl">
      {header}

      {conversations.length === 0 ? (
        <Card>
          <div className="text-center py-8">
            <p className="text-parchment/60">No conversations yet.</p>
            <p className="text-xs text-parchment/40 mt-2">
              When someone messages your Facebook Page (or Instagram account), the
              conversation appears here and your coworker replies automatically.
            </p>
          </div>
        </Card>
      ) : (
        <Card>
          <ul className="divide-y divide-parchment/10">
            {conversations.map((c) => {
              const who = c.display_name || c.contact_phone || `Lead ${c.psid.slice(-6)}`;
              return (
                <li key={c.id}>
                  <a
                    href={`/dashboard/messenger/${c.id}`}
                    className="flex items-center justify-between gap-4 py-3 px-1 hover:bg-parchment/5 rounded-lg transition-colors"
                  >
                    <div className="min-w-0">
                      <p className="text-sm text-parchment truncate">{who}</p>
                      <p className="text-xs text-parchment/40 truncate">
                        {c.platform === "instagram" ? "Instagram" : "Messenger"}
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
