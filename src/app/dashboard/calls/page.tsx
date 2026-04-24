/**
 * Owner-facing voice call transcript list.
 *
 * Mirrors the dashboard-chat server-component pattern: resolve the caller's
 * business via service-role lookup after auth, then render read-only DB rows.
 * Each row links into `/dashboard/calls/[callControlId]` for the full turn view.
 */

import Link from "next/link";
import { redirect } from "next/navigation";
import { getAuthUser } from "@/lib/auth";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { Card } from "@/components/ui/Card";
import { listTranscriptsForBusiness } from "@/lib/db/voice-transcripts";
import {
  StatusBadge,
  callerLabel,
  formatDateTime,
  formatDuration
} from "@/components/dashboard/voice-transcript-helpers";

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

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h1 className="text-2xl font-bold text-parchment">Call history</h1>
        <p className="text-sm text-parchment/50 mt-1">
          Transcripts of calls handled by your AI coworker
        </p>
      </div>

      <Card padding="sm" className="border-signal-teal/30 bg-signal-teal/5">
        <p className="text-xs text-parchment/70 leading-relaxed">
          Calls handled by your AI assistant are transcribed and stored so you
          can review them later. Transcripts are visible to you only.
        </p>
      </Card>

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
        <Card padding="sm">
          <ul className="divide-y divide-parchment/10">
            {transcripts.map((row) => (
              <li key={row.id}>
                <Link
                  href={`/dashboard/calls/${encodeURIComponent(row.call_control_id)}`}
                  className="flex items-center justify-between gap-4 px-3 py-3 rounded-lg hover:bg-parchment/5 transition-colors"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-parchment truncate">
                        {callerLabel(row.caller_e164)}
                      </span>
                      <StatusBadge status={row.status} />
                    </div>
                    <p className="text-xs text-parchment/50 mt-0.5">
                      {formatDateTime(row.started_at)} ·{" "}
                      {formatDuration(row.started_at, row.ended_at)}
                    </p>
                  </div>
                  <span className="text-parchment/40 text-sm shrink-0">View →</span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
