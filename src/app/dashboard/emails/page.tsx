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
import { listEmailLog } from "@/lib/db/email-log";
import { EmailsList } from "@/components/dashboard/EmailsList";

export const dynamic = "force-dynamic";

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
          Every email your coworker handles is recorded here
        </p>
      </Card>

      {rows.length === 0 ? (
        <Card>
          <div className="text-center py-8">
            <p className="text-parchment/60">No email activity yet.</p>
            <p className="text-xs text-parchment/40 mt-2">
              Once an email is sent or received, it will appear here.
            </p>
          </div>
        </Card>
      ) : (
        <EmailsList rows={rows} />
      )}
    </div>
  );
}
