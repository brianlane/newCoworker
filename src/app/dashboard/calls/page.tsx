/**
 * Owner-facing voice call transcript list.
 *
 * Mirrors the dashboard-chat server-component pattern: resolve the caller's
 * business via service-role lookup after auth, then render read-only DB rows.
 * Each row links into `/dashboard/calls/[callControlId]` for the full turn view.
 */

import { redirect } from "next/navigation";
import { getAuthUser } from "@/lib/auth";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { Card } from "@/components/ui/Card";
import { listTranscriptsForBusiness } from "@/lib/db/voice-transcripts";
import { callerLabel } from "@/components/dashboard/voice-transcript-helpers";
import { CallsList, type CallListRow } from "@/components/dashboard/CallsList";
import { resolveContactNames, type ContactName } from "@/lib/db/contact-names";

export const dynamic = "force-dynamic";

export default async function DashboardCallsPage() {
  const user = await getAuthUser();
  if (!user) redirect("/login?redirectTo=/dashboard/calls");
  if (!user.email) redirect("/login?redirectTo=/dashboard/calls");

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
          <h1 className="text-2xl font-bold text-parchment">Call history</h1>
          <p className="text-sm text-parchment/50 mt-1">
            Transcripts of calls handled by your AI coworker
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

  const transcripts = await listTranscriptsForBusiness(business.id, { limit: 50 });
  // Name known callers (owner / roster members / manual overrides) instead of
  // only pretty-printing the raw E.164.
  const contactNames = await resolveContactNames(
    business.id,
    transcripts.map((t) => t.caller_e164).filter((p): p is string => Boolean(p)),
    db
  ).catch(() => new Map<string, ContactName>());

  const rows: CallListRow[] = transcripts.map((row) => {
    const contact = row.caller_e164 ? contactNames.get(row.caller_e164) : undefined;
    return {
      id: row.id,
      label: contact?.name ?? callerLabel(row.caller_e164),
      e164: row.caller_e164,
      badgeKind:
        contact?.kind === "employee"
          ? "employee"
          : contact?.kind === "owner"
            ? "owner"
            : null,
      status: row.status,
      direction: row.direction,
      startedAt: row.started_at,
      endedAt: row.ended_at
    };
  });

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h1 className="text-2xl font-bold text-parchment">Call history</h1>
        <p className="text-sm text-parchment/50 mt-1">
          Transcripts of calls handled by your AI coworker
        </p>
      </div>

      {transcripts.length === 0 ? (
        <Card>
          <div className="text-center py-8">
            <p className="text-parchment/60">No calls yet.</p>
            <p className="text-xs text-parchment/40 mt-2">
              Once a customer calls your coworker, their transcript will appear here.
            </p>
          </div>
        </Card>
      ) : (
        <CallsList rows={rows} />
      )}
    </div>
  );
}
