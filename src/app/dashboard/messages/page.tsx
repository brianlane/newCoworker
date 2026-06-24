/**
 * Owner-facing SMS conversation index.
 *
 * Mirrors the call-history server-component pattern (`/dashboard/calls`):
 * resolve the caller's business via service-role lookup after auth, then
 * render read-only conversation summaries grouped by customer phone.
 *
 * Each row links into `/dashboard/messages/[customerE164]` for the full
 * thread view. Phone numbers are URL-encoded once when building the link
 * and again decoded automatically by Next on the receiving route.
 */

import Link from "next/link";
import { redirect } from "next/navigation";
import { getAuthUser } from "@/lib/auth";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { Card } from "@/components/ui/Card";
import { listConversationsForBusiness } from "@/lib/db/sms-history";
import { resolveContactNames, type ContactName } from "@/lib/db/contact-names";
import { LocalDateTime } from "@/components/dashboard/LocalDateTime";
import { SmsComposeNew } from "@/components/dashboard/SmsComposeNew";

export const dynamic = "force-dynamic";

export default async function DashboardMessagesPage() {
  const user = await getAuthUser();
  if (!user) redirect("/login?redirectTo=/dashboard/messages");
  if (!user.email) redirect("/login?redirectTo=/dashboard/messages");

  const db = await createSupabaseServiceClient();
  const { data: businesses } = await db
    .from("businesses")
    .select("id, name")
    .eq("owner_email", user.email)
    .order("created_at", { ascending: false });

  const business = businesses?.[0] ?? null;

  if (!business) {
    return (
      <div className="space-y-6 max-w-4xl">
        <div>
          <h1 className="text-2xl font-bold text-parchment">Text history</h1>
          <p className="text-sm text-parchment/50 mt-1">
            SMS conversations handled by your AI coworker
          </p>
        </div>
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

  const conversations = await listConversationsForBusiness(business.id, { limit: 50 });
  const contactNames = await resolveContactNames(
    business.id,
    conversations.map((c) => c.customerE164)
  ).catch(() => new Map<string, ContactName>());

  return (
    <div className="space-y-6 max-w-4xl">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-parchment">Text history</h1>
          <p className="text-sm text-parchment/50 mt-1">
            SMS conversations handled by your AI coworker
          </p>
        </div>
        <SmsComposeNew businessId={business.id} />
      </div>

      <Card padding="sm" className="border-signal-teal/30 bg-signal-teal/5">
        <p className="text-xs text-parchment/70 leading-relaxed">
          Texts answered by your AI assistant are stored so you can review
          them later. Conversations are visible to you only.
        </p>
      </Card>

      {conversations.length === 0 ? (
        <Card>
          <div className="text-center py-8">
            <p className="text-parchment/60">No texts yet.</p>
            <p className="text-xs text-parchment/40 mt-2">
              Once a customer texts your coworker, the thread will appear here.
            </p>
          </div>
        </Card>
      ) : (
        <Card padding="sm">
          <ul className="divide-y divide-parchment/10">
            {conversations.map((c) => {
              const contact = contactNames.get(c.customerE164);
              return (
              <li key={c.customerE164}>
                <Link
                  href={`/dashboard/messages/${encodeURIComponent(c.customerE164)}`}
                  className="flex items-center justify-between gap-4 px-3 py-3 rounded-lg hover:bg-parchment/5 transition-colors"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-parchment truncate">
                        {contact?.name ?? c.customerE164}
                      </span>
                      {contact && (
                        <span className="text-[10px] uppercase tracking-wide text-parchment/40">
                          {contact.kind === "employee"
                            ? "employee"
                            : contact.kind === "owner"
                              ? "owner"
                              : null}
                        </span>
                      )}
                      {contact && (
                        <span className="text-[10px] text-parchment/40 font-mono">
                          {c.customerE164}
                        </span>
                      )}
                      <span className="text-[10px] uppercase tracking-wide text-parchment/40 font-mono">
                        {c.messageCount} msg{c.messageCount === 1 ? "" : "s"}
                      </span>
                    </div>
                    <p className="text-xs text-parchment/60 mt-0.5 truncate">
                      {c.lastMessage}
                    </p>
                    <p className="text-[10px] text-parchment/40 mt-0.5">
                      <LocalDateTime iso={c.lastMessageAt} />
                    </p>
                  </div>
                  <span className="text-parchment/40 text-sm shrink-0">View →</span>
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
