/**
 * Owner-facing website-chat-widget conversation index (Standard+).
 *
 * Mirrors the Texts index pattern (`/dashboard/messages`): server-component
 * list of visitor sessions with captured contact details, each linking into
 * the read-only transcript view. Starter tenants get an upgrade card — the
 * sidebar link stays visible as an upsell, same as Analytics.
 */

import { redirect } from "next/navigation";
import { resolveActiveBusinessId } from "@/lib/dashboard/active-business";
import { getAuthUser } from "@/lib/auth";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { Card } from "@/components/ui/Card";
import { LocalDateTime } from "@/components/dashboard/LocalDateTime";
import { listWebchatSessionsForBusiness } from "@/lib/webchat/db";
import { webchatAllowedForTier } from "@/lib/webchat/tier-gate";

export const dynamic = "force-dynamic";

export default async function DashboardWebchatPage() {
  const user = await getAuthUser();
  if (!user) redirect("/login?redirectTo=/dashboard/webchat");
  if (!user.email) redirect("/login?redirectTo=/dashboard/webchat");

  const db = await createSupabaseServiceClient();
  const activeBusinessId = await resolveActiveBusinessId(user);
  const { data: businesses } = await db
    .from("businesses")
    .select("id, name, tier")
    .in("id", activeBusinessId ? [activeBusinessId] : [])
    .order("created_at", { ascending: false });

  const business = businesses?.[0] ?? null;

  const header = (
    <div>
      <h1 className="text-2xl font-bold text-parchment">Web chat</h1>
      <p className="text-sm text-parchment/50 mt-1">
        Conversations from the chat widget on your website
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

  if (!webchatAllowedForTier(business.tier)) {
    return (
      <div className="space-y-6 max-w-4xl">
        {header}
        <Card>
          <div className="text-center py-8">
            <p className="text-parchment/60 mb-2">
              The website chat widget is a Standard and Enterprise feature.
            </p>
            <p className="text-xs text-parchment/40 mb-4">
              Put your coworker on your own website: instant answers for visitors, every
              conversation captured as a lead.
            </p>
            <a
              href="/pricing"
              className="inline-block rounded-lg bg-claw-green text-deep-ink px-5 py-2.5 font-semibold text-sm hover:bg-opacity-90 transition-colors"
            >
              Upgrade to Standard →
            </a>
          </div>
        </Card>
      </div>
    );
  }

  const sessions = await listWebchatSessionsForBusiness(business.id, { limit: 50 });

  return (
    <div className="space-y-6 max-w-4xl">
      <div className="flex items-start justify-between gap-4">
        {header}
        <a
          href="/dashboard/settings"
          className="text-sm text-claw-green hover:underline shrink-0 mt-1"
        >
          Widget settings →
        </a>
      </div>

      {sessions.length === 0 ? (
        <Card>
          <div className="text-center py-8">
            <p className="text-parchment/60">No web chats yet.</p>
            <p className="text-xs text-parchment/40 mt-2">
              Enable the widget under Settings and paste the snippet into your website —
              visitor conversations will appear here.
            </p>
          </div>
        </Card>
      ) : (
        <Card>
          <ul className="divide-y divide-parchment/10">
            {sessions.map((s) => {
              const who =
                s.visitor_name ||
                s.visitor_email ||
                s.visitor_phone ||
                "Anonymous visitor";
              const contactBits = [s.visitor_email, s.visitor_phone]
                .filter((v) => v && v !== who)
                .join(" · ");
              return (
                <li key={s.id}>
                  <a
                    href={`/dashboard/webchat/${s.id}`}
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
