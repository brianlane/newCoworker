/**
 * Owner-facing Messenger/Instagram DM conversation index.
 *
 * Mirrors the Web chat index: server-component list of conversations with
 * captured contact details, each linking into the thread view. Reached
 * via a sidebar item that only renders once the business has an ACTIVE
 * Meta connection, direct URL access without one gets a friendly
 * "connect Facebook first" state instead of a 404.
 */

import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";
import { resolveActiveBusinessId } from "@/lib/dashboard/active-business";
import { getAuthUser } from "@/lib/auth";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { Card } from "@/components/ui/Card";
import { LocalDateTime } from "@/components/dashboard/LocalDateTime";
import { listMessengerConversationsForBusiness } from "@/lib/messenger/db";
import { getPublicMetaConnection } from "@/lib/db/meta-connections";
import { messengerAllowedForTier } from "@/lib/messenger/tier-gate";

export const dynamic = "force-dynamic";

export default async function DashboardMessengerPage() {
  const t = await getTranslations("dashboard.pages");
  const user = await getAuthUser();
  if (!user) redirect("/login?redirectTo=/dashboard/messenger");
  if (!user.email) redirect("/login?redirectTo=/dashboard/messenger");

  const db = await createSupabaseServiceClient();
  const activeBusinessId = await resolveActiveBusinessId(user);
  const { data: businesses } = await db
    .from("businesses")
    .select("id, name, tier")
    .in("id", activeBusinessId ? [activeBusinessId] : [])
    .limit(1);

  const business = businesses?.[0] ?? null;

  const header = (
    <div>
      <h1 className="text-2xl font-bold text-parchment">{t("messengerTitle")}</h1>
      <p className="text-sm text-parchment/50 mt-1">
        {t("messengerSubtitle")}
      </p>
    </div>
  );

  if (!business) {
    return (
      <div className="space-y-6 max-w-4xl">
        {header}
        <Card>
          <div className="text-center py-8">
            <p className="text-parchment/60 mb-4">{t("noCoworker")}</p>
            <a
              href="/onboard"
              className="inline-block rounded-lg bg-claw-green text-deep-ink px-5 py-2.5 font-semibold text-sm hover:bg-claw-green/90 transition-colors"
            >{t("getStarted")}</a>
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
              Once connected, every Messenger and Instagram DM lands here. On
              Standard and above, your coworker replies within seconds.
            </p>
            <Link
              href="/dashboard/integrations/meta"
              className="inline-block rounded-lg bg-claw-green text-deep-ink px-5 py-2.5 font-semibold text-sm hover:bg-claw-green/90 transition-colors"
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
  const aiAllowed = messengerAllowedForTier(
    (business as { tier?: string | null }).tier
  );

  return (
    <div className="space-y-6 max-w-4xl">
      {header}
      {!aiAllowed ? (
        <Card>
          <div className="py-4 px-1">
            <p className="text-parchment/70 text-sm mb-1">
              Automatic replies are a Standard and Enterprise feature.
            </p>
            <p className="text-xs text-parchment/40 mb-3">
              Conversations still land here so you can reply yourself. Upgrade to
              have your coworker answer Messenger, Instagram, and WhatsApp DMs.
            </p>
            <a
              href="/pricing"
              className="inline-block rounded-lg bg-claw-green text-deep-ink px-5 py-2.5 font-semibold text-sm hover:bg-claw-green/90 transition-colors"
            >
              See plans
            </a>
          </div>
        </Card>
      ) : null}

      {conversations.length === 0 ? (
        <Card>
          <div className="text-center py-8">
            <p className="text-parchment/60">No conversations yet.</p>
            <p className="text-xs text-parchment/40 mt-2">
              {aiAllowed
                ? "When someone messages your Facebook Page (or Instagram account), the conversation appears here and your coworker replies automatically."
                : "When someone messages your Facebook Page (or Instagram account), the conversation appears here so you can reply. Automatic coworker replies need Standard or Enterprise."}
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
                        {c.platform === "instagram"
                          ? "Instagram"
                          : c.platform === "whatsapp"
                            ? "WhatsApp"
                            : "Messenger"}
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
