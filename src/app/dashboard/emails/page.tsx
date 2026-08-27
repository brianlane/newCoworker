/**
 * Owner-facing email activity index.
 *
 * Mirrors the Texts/Calls server-component pattern: resolve the caller's
 * business via service-role lookup after auth, then render a read-only list
 * of coworker email activity from `email_log`, AiFlow sends (Resend and
 * owner-mailbox) plus the inbound emails that triggered flows.
 */

import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { resolveActiveBusinessId } from "@/lib/dashboard/active-business";
import { getAuthUser } from "@/lib/auth";
import { resolveDashboardOwnerEmail } from "@/lib/admin/view-as";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { Card } from "@/components/ui/Card";
import { getEmailLogRow, listEmailLog } from "@/lib/db/email-log";
import {
  coerceEmailsFiltersForMailbox,
  coerceEmailsViewFilter,
  emailListFiltersFromView,
  parseEmailsViewFilter,
  withLinkedEmailRow
} from "@/lib/dashboard/email-filters";
import {
  mailboxOptionsFromSendFrom,
  parseMailboxFilter
} from "@/lib/dashboard/email-mailbox";
import { listSendFromOptions } from "@/lib/email/mailbox-options";
import { findContactsByEmails, type EmailContactLink } from "@/lib/db/contact-emails";
import { listAiFlows } from "@/lib/ai-flows/db";
import { flowHasTenantEmailTrigger, flowUpsertsBeforeOutreach } from "@/lib/email/replay";
import { EmailsList } from "@/components/dashboard/EmailsList";

export const dynamic = "force-dynamic";

export default async function DashboardEmailsPage({
  searchParams
}: {
  searchParams: Promise<{
    view?: string;
    folder?: string;
    label?: string;
    id?: string;
    mailbox?: string;
  }>;
}) {
  const t = await getTranslations("dashboard.pages");
  const user = await getAuthUser();
  const sp = await searchParams;
  const selectedId = typeof sp.id === "string" ? sp.id.trim() : "";
  if (!user?.email) {
    // Keep the id across the login bounce, or the owner lands on the right
    // page with the wrong message open (which is the whole point of the link).
    const back = selectedId
      ? `/dashboard/emails?id=${encodeURIComponent(selectedId)}`
      : "/dashboard/emails";
    redirect(`/login?redirectTo=${encodeURIComponent(back)}`);
  }

  const labelFilter = typeof sp.label === "string" ? sp.label.trim() : "";

  // Admin view-as swaps in the impersonated tenant's owner email.
  const ownerEmail = (await resolveDashboardOwnerEmail(user)) ?? user.email;

  const db = await createSupabaseServiceClient();
  const activeBusinessId = await resolveActiveBusinessId(user);
  // The sender list is fetched BEFORE the mail query, not alongside it: it is
  // what the mailbox chips are built from, and the chosen chip narrows the
  // query itself. Best-effort on failure, which just hides the chips.
  const [{ data: businesses }, fromOptions] = await Promise.all([
    db
      .from("businesses")
      .select("id, name")
      .in("id", activeBusinessId ? [activeBusinessId] : [])
      .order("created_at", { ascending: false }),
    activeBusinessId
      ? listSendFromOptions(activeBusinessId).catch(() => [])
      : Promise.resolve([])
  ]);

  const business = businesses?.[0] ?? null;

  if (!business) {
    return (
      <div className="space-y-6 max-w-4xl">
        <div>
          <h1 className="text-2xl font-bold text-parchment">{t("emailsTitle")}</h1>
          <p className="text-sm text-parchment/50 mt-1">
            {t("emailsSubtitle")}
          </p>
        </div>
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

  const mailboxOptions = mailboxOptionsFromSendFrom(fromOptions);
  const mailboxFilter = parseMailboxFilter(sp.mailbox, mailboxOptions);
  const requestedFolder = typeof sp.folder === "string" ? sp.folder.trim() : "";
  const requestedView = coerceEmailsViewFilter(
    parseEmailsViewFilter(sp.view),
    requestedFolder
  );
  // A connected mailbox carries no folders/archive/unread state, so those
  // chips widen rather than render an empty page.
  const { view: viewFilter, folder: folderFilter } = coerceEmailsFiltersForMailbox({
    view: requestedView,
    folder: requestedFolder,
    mailbox: mailboxFilter
  });
  const listFilters = emailListFiltersFromView({
    view: viewFilter,
    folder: folderFilter,
    label: labelFilter,
    mailbox: mailboxFilter,
    limit: 100
  });

  const [listRows, flows, linkedRow] = await Promise.all([
    listEmailLog(business.id, listFilters),
    // Replay targets ("Replay through flow" on unmatched inbox mail): enabled
    // flows that read the AI mailbox. Best-effort, no flows just hides the
    // action.
    listAiFlows(business.id).catch(() => []),
    // The row a deep link names, fetched separately so a link tapped days
    // later still opens: the list above is capped at the newest 100, and the
    // reading pane resolves its selection against that array. Best-effort, so
    // a bad or foreign id just opens the page normally.
    selectedId ? getEmailLogRow(business.id, selectedId).catch(() => null) : null
  ]);
  const rows = withLinkedEmailRow(listRows, linkedRow);
  // Same gate as the replay route: only flows that file the lead before any
  // outreach can guarantee a replay never re-texts an existing contact.
  const replayFlows = flows
    .filter(
      (f) =>
        f.enabled &&
        flowHasTenantEmailTrigger(f.definition) &&
        flowUpsertsBeforeOutreach(f.definition)
    )
    .map((f) => ({ id: f.id, name: f.name }));

  // Link addresses to contact profiles (contacts.email match) so the reading
  // pane's From/To/Cc lines navigate to the contact page. Best-effort, on
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
        <h1 className="text-2xl font-bold text-parchment">{t("emailsTitle")}</h1>
        <p className="text-sm text-parchment/50 mt-1">
          {t("emailsSubtitle")}
        </p>
      </div>

      <EmailsList
        rows={rows}
        businessId={business.id}
        fromOptions={fromOptions}
        emailContacts={emailContacts}
        replayFlows={replayFlows}
        mailboxOptions={mailboxOptions}
        initialView={viewFilter}
        initialFolder={folderFilter}
        initialLabel={labelFilter}
        initialMailbox={mailboxFilter}
        initialSelectedId={selectedId}
      />
    </div>
  );
}
