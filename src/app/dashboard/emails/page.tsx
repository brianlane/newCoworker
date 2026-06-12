/**
 * Owner-facing email activity index.
 *
 * Mirrors the Texts/Calls server-component pattern: resolve the caller's
 * business via service-role lookup after auth, then render a read-only list
 * of coworker email activity from `email_log` — AiFlow sends (Resend and
 * owner-mailbox) plus the inbound emails that triggered flows.
 */

import { redirect } from "next/navigation";
import { getAuthUser } from "@/lib/auth";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { Card } from "@/components/ui/Card";
import { listEmailLog, type EmailLogRow } from "@/lib/db/email-log";
import { LocalDateTime } from "@/components/dashboard/LocalDateTime";

export const dynamic = "force-dynamic";

function sourceLabel(row: EmailLogRow): string {
  if (row.source === "email_trigger") return "Trigger";
  if (row.source === "owner_mailbox") return "Sent as you";
  return "AiFlow";
}

export default async function DashboardEmailsPage() {
  const user = await getAuthUser();
  if (!user?.email) redirect("/login?redirectTo=/dashboard/emails");

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
          <h1 className="text-2xl font-bold text-parchment">Emails</h1>
          <p className="text-sm text-parchment/50 mt-1">
            Email activity handled by your AI coworker
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

  const rows = await listEmailLog(business.id, { limit: 100 });

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h1 className="text-2xl font-bold text-parchment">Emails</h1>
        <p className="text-sm text-parchment/50 mt-1">
          Email activity handled by your AI coworker
        </p>
      </div>

      <Card padding="sm" className="border-signal-teal/30 bg-signal-teal/5">
        <p className="text-xs text-parchment/70 leading-relaxed">
          Emails your AiFlows send (from the platform or your connected
          mailbox) and the inbound emails that trigger them are recorded here
          so you can review them later.
        </p>
      </Card>

      {rows.length === 0 ? (
        <Card>
          <div className="text-center py-8">
            <p className="text-parchment/60">No email activity yet.</p>
            <p className="text-xs text-parchment/40 mt-2">
              Once an AiFlow sends or is triggered by an email, it will appear
              here.
            </p>
          </div>
        </Card>
      ) : (
        <Card padding="sm">
          <ul className="divide-y divide-parchment/10">
            {rows.map((r) => (
              <li key={r.id} className="px-3 py-3">
                <div className="flex items-center gap-2 flex-wrap">
                  <span
                    className={[
                      "text-[10px] uppercase tracking-wide font-semibold rounded px-1.5 py-0.5",
                      r.direction === "inbound"
                        ? "bg-signal-teal/15 text-signal-teal"
                        : "bg-claw-green/15 text-claw-green"
                    ].join(" ")}
                  >
                    {r.direction === "inbound" ? "Received" : "Sent"}
                  </span>
                  <span className="text-[10px] uppercase tracking-wide text-parchment/40 font-mono">
                    {sourceLabel(r)}
                  </span>
                  <span className="text-sm font-semibold text-parchment truncate">
                    {r.subject || "(no subject)"}
                  </span>
                </div>
                <p className="text-xs text-parchment/60 mt-1 truncate">
                  {r.direction === "inbound"
                    ? `From ${r.from_email ?? "unknown"}`
                    : `To ${r.to_email ?? "unknown"}`}
                  {r.body_preview ? ` — ${r.body_preview}` : ""}
                </p>
                <p className="text-[10px] text-parchment/40 mt-0.5">
                  <LocalDateTime iso={r.created_at} />
                </p>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
