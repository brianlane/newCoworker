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
import { resolveDashboardOwnerEmail } from "@/lib/admin/view-as";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { Card } from "@/components/ui/Card";
import { listEmailLog } from "@/lib/db/email-log";
import { listSendFromOptions } from "@/lib/email/mailbox-options";
import { findContactsByEmails, type EmailContactLink } from "@/lib/db/contact-emails";
import { EmailsList } from "@/components/dashboard/EmailsList";

export const dynamic = "force-dynamic";

export default async function DashboardEmailsPage() {
  const user = await getAuthUser();
  if (!user?.email) redirect("/login?redirectTo=/dashboard/emails");

  // Admin view-as swaps in the impersonated tenant's owner email.
  const ownerEmail = (await resolveDashboardOwnerEmail(user)) ?? user.email;

  const db = await createSupabaseServiceClient();
  const { data: businesses } = await db
    .from("businesses")
    .select("id, name")
    .eq("owner_email", ownerEmail)
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

  const [rows, fromOptions] = await Promise.all([
    listEmailLog(business.id, { limit: 100 }),
    // Best-effort: on any failure the composer falls back to coworker-only send.
    listSendFromOptions(business.id).catch(() => [])
  ]);

  // Link addresses to contact profiles (contacts.email match) so the reading
  // pane's From/To/Cc lines navigate to the contact page. Best-effort — on
  // failure the addresses just render unlinked.
  const emailContacts: Record<string, EmailContactLink> = {};
  try {
    const resolved = await findContactsByEmails(
      business.id,
      rows.flatMap((r) => [r.from_email, r.to_email, r.cc_email]),
      db
    );
    for (const [addr, link] of resolved) emailContacts[addr] = link;
  } catch (e) {
    console.error("emails page contact-link resolution", e);
  }

  return (
    <div className="space-y-6 max-w-6xl">
      <div>
        <h1 className="text-2xl font-bold text-parchment">Emails</h1>
        <p className="text-sm text-parchment/50 mt-1">
          Email activity handled by your AI coworker
        </p>
      </div>

      <EmailsList
        rows={rows}
        businessId={business.id}
        fromOptions={fromOptions}
        emailContacts={emailContacts}
      />
    </div>
  );
}
