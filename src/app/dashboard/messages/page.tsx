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

import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { resolveActiveBusinessId } from "@/lib/dashboard/active-business";
import { getAuthUser } from "@/lib/auth";
import { resolveDashboardOwnerEmail } from "@/lib/admin/view-as";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { Card } from "@/components/ui/Card";
import { listConversationsForBusiness } from "@/lib/db/sms-history";
import { resolveContactNames, type ContactName } from "@/lib/db/contact-names";
import { rcsChannelActiveForBusiness } from "@/lib/telnyx/messaging";
import { smsToolsAllowedForTier } from "@/lib/plans/sms-tools";
import { listAiFlows } from "@/lib/ai-flows/db";
import { flowUpsertsBeforeOutreach } from "@/lib/email/replay";
import { flowHasSmsTrigger } from "@/lib/sms/replay";
import { MessagesList, type MessageListRow } from "@/components/dashboard/MessagesList";
import { SmsReplayPanel } from "@/components/dashboard/SmsReplayPanel";
import {
  SmsComposeNew,
  type SmsTemplateOption
} from "@/components/dashboard/SmsComposeNew";
import { SmsToolsPanel, type ScheduledSmsItem } from "@/components/dashboard/SmsToolsPanel";

export const dynamic = "force-dynamic";

export default async function DashboardMessagesPage() {
  const t = await getTranslations("dashboard.pages");
  const user = await getAuthUser();
  if (!user) redirect("/login?redirectTo=/dashboard/messages");
  if (!user.email) redirect("/login?redirectTo=/dashboard/messages");

  // Admin view-as swaps in the impersonated tenant's owner email.
  const ownerEmail = (await resolveDashboardOwnerEmail(user)) ?? user.email;

  const db = await createSupabaseServiceClient();
  const activeBusinessId = await resolveActiveBusinessId(user);
  const { data: businesses } = await db
    .from("businesses")
    .select("id, name, tier")
    .in("id", activeBusinessId ? [activeBusinessId] : [])
    .order("created_at", { ascending: false });

  const business = businesses?.[0] ?? null;

  if (!business) {
    return (
      <div className="space-y-6 max-w-4xl">
        <div>
          <h1 className="text-2xl font-bold text-parchment">{t("messagesTitle")}</h1>
          <p className="text-sm text-parchment/50 mt-1">
            {t("messagesSubtitle")}
          </p>
        </div>
        <Card>
          <div className="text-center py-8">
            <p className="text-parchment/60 mb-4">{t("noCoworker")}</p>
            <a
              href="/onboard"
              className="inline-block rounded-lg bg-claw-green text-deep-ink px-5 py-2.5 font-semibold text-sm hover:bg-opacity-90 transition-colors"
            >{t("getStarted")}</a>
          </div>
        </Card>
      </div>
    );
  }

  // Scheduled + template SMS (Standard+ perk): fetch the composer picker data
  // and the tools panel contents for entitled tenants. Pending scheduled rows
  // are ALWAYS fetched — after a tier downgrade an owner must still see and
  // cancel what they queued while on Standard (the sweep would fail those
  // rows at dispatch time, but silently hiding them here would be worse).
  const smsToolsEnabled = smsToolsAllowedForTier(
    (business as { tier?: string | null }).tier
  );

  // Every read below keys only on the business id, so one parallel batch
  // replaces what used to be ~5 sequential round-trips:
  // - conversations: the thread list itself.
  // - rcsEnabled: RCS-first tenants (Standard+, approved agent, concrete
  //   from-number for the SMS fallback — the same precondition sendTelnyxSms
  //   checks) get a softened emoji hint in the composer: the rich message
  //   delivers as typed, only the SMS fallback copy is capped.
  // - rawFlows: replay targets ("Replay missed texts") — best-effort: no
  //   flows just hides the panel.
  // - templates / pending / history: pending rows soonest-first (so an owner
  //   with a deep queue always sees — and can cancel — what dispatches
  //   next), plus a short tail of recent dispatched/canceled rows for
  //   context (entitled tenants only).
  const [
    conversations,
    rcsEnabled,
    rawFlows,
    { data: templateRows },
    { data: pendingRows },
    { data: historyRows }
  ] = await Promise.all([
    listConversationsForBusiness(business.id, { limit: 50 }),
    rcsChannelActiveForBusiness(db, business.id),
    listAiFlows(business.id).catch(() => []),
    smsToolsEnabled
      ? db
          .from("sms_templates")
          .select("id, name, body")
          .eq("business_id", business.id)
          .order("name", { ascending: true })
      : Promise.resolve({ data: [] }),
    db
      .from("scheduled_sms")
      .select("id, to_e164, body, send_at, status, error")
      .eq("business_id", business.id)
      .eq("status", "pending")
      .order("send_at", { ascending: true })
      .limit(50),
    smsToolsEnabled
      ? db
          .from("scheduled_sms")
          .select("id, to_e164, body, send_at, status, error")
          .eq("business_id", business.id)
          .neq("status", "pending")
          .order("send_at", { ascending: false })
          .limit(5)
      : Promise.resolve({ data: [] })
  ]);

  const contactNames = await resolveContactNames(
    business.id,
    conversations.map((c) => c.customerE164)
  ).catch(() => new Map<string, ContactName>());

  // Enabled SMS-triggered flows that file the lead before any outreach — the
  // same gate as the replay route, mirroring the Emails page.
  const replayFlows = rawFlows
    .filter(
      (f) =>
        f.enabled && flowHasSmsTrigger(f.definition) && flowUpsertsBeforeOutreach(f.definition)
    )
    .map((f) => ({ id: f.id, name: f.name }));

  const templates = (templateRows ?? []) as SmsTemplateOption[];
  const scheduled: ScheduledSmsItem[] = (
    [...(pendingRows ?? []), ...(historyRows ?? [])] as Array<{
      id: string;
      to_e164: string;
      body: string;
      send_at: string;
      status: string;
      error: string | null;
    }>
  ).map((s) => ({
    id: s.id,
    toE164: s.to_e164,
    body: s.body,
    sendAt: s.send_at,
    status: s.status,
    error: s.error
  }));

  const rows: MessageListRow[] = conversations.map((c) => {
    const contact = contactNames.get(c.customerE164);
    return {
      customerE164: c.customerE164,
      name: contact?.name ?? c.customerE164,
      badgeKind:
        contact?.kind === "employee"
          ? "employee"
          : contact?.kind === "owner"
            ? "owner"
            : null,
      lastMessage: c.lastMessage,
      lastMessageAt: c.lastMessageAt,
      messageCount: c.messageCount
    };
  });

  return (
    <div className="space-y-6 max-w-4xl">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-parchment">{t("messagesTitle")}</h1>
          <p className="text-sm text-parchment/50 mt-1">
            {t("messagesSubtitle")}
          </p>
        </div>
        <SmsComposeNew
          businessId={business.id}
          rcsEnabled={rcsEnabled}
          templates={templates}
          schedulingEnabled={smsToolsEnabled}
        />
      </div>

      <SmsReplayPanel businessId={business.id} flows={replayFlows} />

      {(smsToolsEnabled || scheduled.length > 0) && (
        <SmsToolsPanel
          businessId={business.id}
          templates={templates}
          scheduled={scheduled}
          toolsEnabled={smsToolsEnabled}
        />
      )}

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
        <MessagesList rows={rows} />
      )}
    </div>
  );
}
