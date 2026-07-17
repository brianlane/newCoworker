/**
 * Per-customer detail view (Phase 4).
 *
 * Server-renders the cross-channel profile, then hands a small client
 * island the editable pinned-notes / display-name fields and the
 * delete affordance. Read-only sections (rolling LLM summary, SMS
 * tail, channel timestamps) stay in the server component so first
 * paint is fast and pinned-notes drafts don't clobber on hot reload.
 */

import { notFound, redirect } from "next/navigation";
import { resolveActiveBusinessId } from "@/lib/dashboard/active-business";
import Link from "next/link";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { resolveDashboardOwnerEmail } from "@/lib/admin/view-as";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { Card } from "@/components/ui/Card";
import { LocalDateTime } from "@/components/dashboard/LocalDateTime";
import {
  getCustomerMemory,
  listCustomerMemories,
  listSmsHistoryForCustomer
} from "@/lib/customer-memory/db";
import { listTranscriptsForCaller } from "@/lib/db/voice-transcripts";
import { listEmailLogForAddress } from "@/lib/db/email-log";
import { getContactActivity, type ActivityItem } from "@/lib/db/activity";
import { Badge } from "@/components/ui/Badge";
import { ACTIVITY_BADGE } from "@/components/dashboard/activity-badge";
import { CustomerProfileEditor } from "@/components/dashboard/CustomerProfileEditor";
import { ContactReplyModeToggle } from "@/components/dashboard/ContactReplyModeToggle";
import { CustomerEmailComposer } from "@/components/dashboard/CustomerEmailComposer";
import { CustomerMergeAction } from "@/components/dashboard/CustomerMergeAction";
import { resolveContactNames, type ContactName } from "@/lib/db/contact-names";
import { listTeamMembers } from "@/lib/db/employees";
import { listBusinessDocumentsForContact } from "@/lib/documents/db";
import { RequestDocumentsAction } from "@/components/dashboard/RequestDocumentsAction";
import { ensureTenantMailbox, tenantMailboxAddress } from "@/lib/email/tenant-mailbox";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ customerE164: string }> };

export default async function CustomerDetailPage({ params }: Props) {
  const user = await getAuthUser();
  if (!user) redirect("/login?redirectTo=/dashboard/customers");
  if (!user.email) redirect("/login?redirectTo=/dashboard/customers");

  const raw = (await params).customerE164;
  let customerE164: string;
  try {
    customerE164 = decodeURIComponent(raw);
  } catch {
    customerE164 = raw;
  }
  // E.164 or a 3-8 digit short code (service/lead-source contacts).
  if (!/^(\+[1-9]\d{6,15}|\d{3,8})$/.test(customerE164)) {
    notFound();
  }

  // Admin view-as swaps in the impersonated tenant's owner email.
  const ownerEmail = (await resolveDashboardOwnerEmail(user)) ?? user.email;

  const db = await createSupabaseServiceClient();
  const activeBusinessId = await resolveActiveBusinessId(user);
  const { data: businesses } = await db
    .from("businesses")
    .select("id, name")
    .in("id", activeBusinessId ? [activeBusinessId] : [])
    .order("created_at", { ascending: false });

  const business = businesses?.[0];
  if (!business) redirect("/onboard");

  // Defense-in-depth (resolveActiveBusinessId already validated access):
  // customer profiles are day-to-day inbox work, so staff+ may open them.
  if (!user.isAdmin) await requireBusinessRole(business.id, "operate_messages");

  const memory = await getCustomerMemory(business.id, customerE164);
  if (!memory) notFound();

  // Phase 4 + 4b: pull SMS + voice in parallel so the page hydrates in
  // one round-trip group rather than serial. Voice list is capped at
  // 10 — the per-call transcript page is one click away for full detail.
  // Both lists key off the PROFILE's primary number + its merged aliases —
  // not the URL value, which after a merge may itself be an alias (the
  // alias-aware getCustomerMemory above already resolved it). Keying off
  // the raw URL number dropped everything stored under the primary.
  // All five reads depend only on `memory` (already resolved), so they run
  // as ONE parallel group. This matters doubly for residency (vps-mode)
  // tenants, where each read is a tunnel round-trip to their box —
  // serially these were ~5 RTTs, now the page pays one.
  const [smsHistory, voiceTranscripts, allCustomers, emailHistory, contactNames, teamMembers, activityItems, contactDocuments, mailboxAddress] =
    await Promise.all([
      listSmsHistoryForCustomer(business.id, memory.customer_e164, {
        limit: 50,
        aliases: memory.alias_e164s ?? []
      }),
      // Tolerate transcript table errors here so a voice-table outage
      // doesn't block the SMS-only customer detail page from rendering.
      listTranscriptsForCaller(business.id, memory.customer_e164, {
        limit: 10,
        aliases: memory.alias_e164s ?? []
      }).catch(() => []),
      listCustomerMemories(business.id, { limit: 200 }).catch(() => []),
      // Email rollup: only when the profile has a linked address. Tolerate a
      // log-table error so it never blocks the rest of the page.
      memory.email
        ? listEmailLogForAddress(business.id, memory.email, { limit: 20 }).catch(() => [])
        : Promise.resolve([]),
      // Owner/employee/manual-override names win over the stored
      // display_name for the header.
      resolveContactNames(
        business.id,
        [memory.customer_e164, ...(memory.alias_e164s ?? [])],
        db
      ).catch(() => new Map<string, ContactName>()),
      // Roster for the "Owned by" picker; tolerated so a roster-table error
      // never blocks the profile page.
      listTeamMembers(business.id, db).catch(() => []),
      // Unified activity timeline (calls, texts, emails, AiFlow runs where
      // this person is the lead); tolerated so a feed error never blocks
      // the profile page.
      getContactActivity(
        business.id,
        {
          e164s: [memory.customer_e164, ...(memory.alias_e164s ?? [])],
          email: memory.email
        },
        {},
        db
      ).catch(() => [] as ActivityItem[]),
      // Linked records (policies, contracts, memberships); tolerated so a
      // documents-table error never blocks the profile page.
      listBusinessDocumentsForContact(business.id, memory.id, db).catch(() => []),
      // AI mailbox address for the "Request documents" action; tolerated —
      // a mailbox-table error just hides the action.
      ensureTenantMailbox(business.id, db)
        .then((row) => tenantMailboxAddress(row.local_part))
        .catch(() => null)
    ]);
  // Merge is "same person, two numbers" — only ever fold a customer into another
  // customer. Exclude self and any non-customer directory row (company short
  // codes, vendors, testers, owner/employee) so an irreversible merge can never
  // collapse a real person into a lead-source or vendor entry.
  const mergeCandidates = allCustomers
    .filter((c) => c.customer_e164 !== memory.customer_e164 && c.type === "customer")
    .map((c) => ({ customerE164: c.customer_e164, displayName: c.display_name }));

  // The URL number can be a merged-in alias, and the owner/override identity
  // may live on the alias rather than the profile's primary. Prefer the
  // primary, then the URL number, then any alias that resolved.
  const headerContact =
    contactNames.get(memory.customer_e164) ??
    contactNames.get(customerE164) ??
    (memory.alias_e164s ?? [])
      .map((a) => contactNames.get(a))
      .find((c): c is ContactName => Boolean(c));
  const headerName =
    headerContact?.name ?? (memory.display_name?.trim() || memory.customer_e164);
  // Overlaid identity wins for the badge; otherwise show the stored type.
  const headerBadge =
    headerContact?.kind === "owner" || headerContact?.kind === "employee"
      ? headerContact.kind
      : memory.type;

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <Link
          href="/dashboard/customers"
          className="text-xs text-parchment/50 hover:text-parchment/80 transition-colors"
        >
          ← Contacts
        </Link>
        <div className="flex items-center gap-2 mt-2 flex-wrap">
          <h1 className="text-2xl font-bold text-parchment">{headerName}</h1>
          {headerBadge && (
            <span className="text-[10px] uppercase tracking-wide text-parchment/40">
              {headerBadge}
            </span>
          )}
        </div>
        {headerName !== memory.customer_e164 && (
          <p className="text-sm text-parchment/50 font-mono mt-0.5">
            {memory.customer_e164}
          </p>
        )}
        <div className="mt-2 flex flex-wrap gap-2 text-xs">
          {memory.last_channel && (
            <span className="text-parchment/70 bg-parchment/10 rounded px-2 py-0.5 uppercase tracking-wide">
              last via {memory.last_channel}
            </span>
          )}
          <span className="text-parchment/70 bg-parchment/10 rounded px-2 py-0.5">
            {memory.total_interaction_count} total interaction
            {memory.total_interaction_count === 1 ? "" : "s"}
          </span>
          {memory.last_interaction_at && (
            <span className="text-parchment/70 bg-parchment/10 rounded px-2 py-0.5">
              last seen <LocalDateTime iso={memory.last_interaction_at} />
            </span>
          )}
          {(memory.alias_e164s ?? []).map((alias) => (
            <span
              key={alias}
              className="text-parchment/70 bg-parchment/10 rounded px-2 py-0.5 font-mono"
              title="Merged-in number; texts and calls from it land on this profile"
            >
              also {alias}
            </span>
          ))}
        </div>
      </div>

      <CustomerProfileEditor
        businessId={business.id}
        customerE164={memory.customer_e164}
        // Prefill with the EFFECTIVE name shown in the header (resolved
        // owner/employee/manual-label identity), falling back to the stored
        // display_name — so editing starts from the current value instead of a
        // blank box for derived names. Never seed the bare E.164 (headerName's
        // last-resort fallback): a contact with no name keeps the field empty so
        // the placeholder shows and an unchanged save writes nothing.
        initialDisplayName={headerContact?.name ?? memory.display_name}
        initialPinnedMd={memory.pinned_md}
        initialEmail={memory.email}
        // Prefill with the EFFECTIVE type shown in the header badge — the
        // owner/employee overlay wins over the stored type — so editing starts
        // from the displayed value, not the raw stored one. (As with the name,
        // an unchanged save writes nothing because this is also the dirty-check
        // baseline.)
        initialType={headerBadge}
        initialTags={memory.tags ?? []}
        initialOwnerEmployeeId={memory.owner_employee_id}
        initialBirthday={memory.birthday}
        teamMembers={teamMembers.map((m) => ({ id: m.id, name: m.name }))}
      />

      <ContactReplyModeToggle
        businessId={business.id}
        customerE164={memory.customer_e164}
        initialMode={memory.sms_reply_mode}
      />

      {/* Document request: customers with a real (textable) number only —
          short-code/service rows can't receive the request SMS. */}
      {memory.type === "customer" &&
        /^\+[1-9]\d{6,15}$/.test(memory.customer_e164) &&
        mailboxAddress && (
          <RequestDocumentsAction
            businessId={business.id}
            customerE164={memory.customer_e164}
            customerName={headerName === memory.customer_e164 ? "" : headerName}
            mailboxAddress={mailboxAddress}
            currentTags={memory.tags ?? []}
          />
        )}

      {/* Merge is customer-to-customer only. Hide it when THIS profile is a
          non-customer (company short code, vendor, tester, owner/employee) so a
          directory row can never be folded into a customer and deleted — the
          target list is already restricted to customers above. */}
      {memory.type === "customer" && (
        <CustomerMergeAction
          businessId={business.id}
          customerE164={memory.customer_e164}
          candidates={mergeCandidates}
        />
      )}

      <Card>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-parchment">Activity</h2>
          {/* Bidirectional: the task board's cards link here, and a lead in
              motion (tagged, or with AiFlow runs in the feed) links back to
              its card on the board. */}
          {((memory.tags ?? []).length > 0 ||
            activityItems.some((i) => i.kind === "aiflow")) && (
            <Link
              href={`/dashboard/tasks?lead=${encodeURIComponent(memory.customer_e164)}`}
              className="text-xs text-claw-green hover:underline"
            >
              View on task board →
            </Link>
          )}
        </div>
        {activityItems.length === 0 ? (
          <p className="text-xs text-parchment/50">
            No recent activity for this contact.
          </p>
        ) : (
          <ul className="divide-y divide-parchment/10">
            {activityItems.map((item) => (
              <li key={item.id}>
                <Link
                  href={item.href}
                  className="flex items-center justify-between gap-3 py-2 group"
                >
                  <div className="min-w-0">
                    <p className="text-sm text-parchment/90 truncate group-hover:text-signal-teal transition-colors">
                      {item.label}
                    </p>
                    <p className="text-[10px] uppercase tracking-wide text-parchment/40">
                      <LocalDateTime iso={item.at} />
                    </p>
                  </div>
                  <Badge variant={ACTIVITY_BADGE[item.kind].variant}>
                    {ACTIVITY_BADGE[item.kind].label}
                  </Badge>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {contactDocuments.length > 0 && (
        <Card>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-parchment">Documents on file</h2>
            <Link
              href="/dashboard/memory"
              className="text-xs text-claw-green hover:underline"
            >
              Manage documents →
            </Link>
          </div>
          <ul className="divide-y divide-parchment/10">
            {contactDocuments.map((doc) => {
              const badges = contactDocBadges(doc);
              return (
                <li key={doc.id} className="py-2 flex flex-wrap items-center gap-2">
                  <span className="text-sm text-parchment/90">{doc.title}</span>
                  <span className="rounded border border-parchment/20 px-1.5 py-0.5 text-[11px] text-parchment/50">
                    {doc.category}
                  </span>
                  {badges.renewal && (
                    <span
                      className={`rounded border px-1.5 py-0.5 text-[11px] ${
                        badges.renewal.urgent
                          ? "text-spark-orange border-spark-orange/40"
                          : "text-parchment/50 border-parchment/20"
                      }`}
                    >
                      {badges.renewal.text}
                    </span>
                  )}
                  {badges.expired && (
                    <span className="rounded border border-spark-orange/50 px-1.5 py-0.5 text-[11px] text-spark-orange">
                      Expired
                    </span>
                  )}
                  {doc.record_fields && Object.keys(doc.record_fields).length > 0 && (
                    <span className="w-full text-[11px] text-parchment/50">
                      {Object.entries(doc.record_fields)
                        .map(([key, value]) => `${key}: ${value}`)
                        .join(" · ")}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      {memory.summary_md?.trim() ? (
        <Card>
          <h2 className="text-sm font-semibold text-parchment mb-2">
            Rolling summary
          </h2>
          <p className="text-xs text-parchment/40 mb-3">
            Auto-generated from SMS + voice history.
            {memory.last_summarized_at && (
              <>
                {" "}
                Last refreshed{" "}
                <LocalDateTime iso={memory.last_summarized_at} />.
              </>
            )}
          </p>
          <pre className="text-sm text-parchment/80 whitespace-pre-wrap font-sans leading-relaxed">
            {memory.summary_md}
          </pre>
        </Card>
      ) : (
        <Card>
          <h2 className="text-sm font-semibold text-parchment mb-2">
            Rolling summary
          </h2>
          <p className="text-xs text-parchment/50">
            No summary yet; it&apos;ll appear here after a few interactions.
          </p>
        </Card>
      )}

      <Card>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-parchment">SMS history</h2>
          {/* The thread page 404s when there are no messages, so only offer
              the link when a thread actually exists to land on. */}
          {smsHistory.length > 0 && (
            <Link
              href={`/dashboard/messages/${encodeURIComponent(customerE164)}`}
              className="text-xs text-claw-green hover:underline"
            >
              Full thread →
            </Link>
          )}
        </div>
        {smsHistory.length === 0 ? (
          <p className="text-xs text-parchment/50">No SMS history.</p>
        ) : (
          <ul className="space-y-3">
            {smsHistory.slice(-10).map((entry) => (
              <li key={entry.jobId} className="border-l-2 border-parchment/10 pl-3">
                <p className="text-[10px] uppercase tracking-wide text-parchment/40">
                  <LocalDateTime iso={entry.receivedAt} />
                </p>
                {entry.inboundText && (
                  <p className="text-sm text-parchment/90 mt-0.5">
                    <span className="text-parchment/40 mr-1">Customer:</span>
                    {entry.inboundText}
                  </p>
                )}
                {entry.assistantReply && (
                  <p className="text-sm text-parchment/70 mt-1">
                    <span className="text-parchment/40 mr-1">
                      {entry.source ? "AiFlow:" : "Coworker:"}
                    </span>
                    {entry.assistantReply}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      {memory.email && (
        <Card>
          <div className="flex items-center justify-between mb-3">
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-parchment">Email history</h2>
              <p className="text-xs text-parchment/50 font-mono truncate">{memory.email}</p>
            </div>
            <Link
              href="/dashboard/emails"
              className="text-xs text-claw-green hover:underline shrink-0"
            >
              All emails →
            </Link>
          </div>
          {emailHistory.length === 0 ? (
            <p className="text-xs text-parchment/50">
              No email to or from this address yet.
            </p>
          ) : (
            <ul className="space-y-3">
              {emailHistory.map((e) => (
                <li key={e.id} className="border-l-2 border-parchment/10 pl-3">
                  <p className="text-[10px] uppercase tracking-wide text-parchment/40">
                    {e.direction === "inbound" ? "Received" : "Sent"}
                    {" • "}
                    <LocalDateTime iso={e.created_at} />
                  </p>
                  {e.subject && (
                    <p className="text-sm text-parchment/90 mt-0.5 font-semibold">
                      {e.subject}
                    </p>
                  )}
                  {e.body_preview && (
                    <p className="text-sm text-parchment/70 mt-0.5 line-clamp-2">
                      {e.body_preview}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
          <div className="mt-4">
            <CustomerEmailComposer
              businessId={business.id}
              customerE164={memory.customer_e164}
              email={memory.email}
            />
          </div>
        </Card>
      )}

      <Card>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-parchment">Voice calls</h2>
          <Link
            href="/dashboard/calls"
            className="text-xs text-claw-green hover:underline"
          >
            All calls →
          </Link>
        </div>
        {voiceTranscripts.length === 0 ? (
          <p className="text-xs text-parchment/50">
            No voice calls from this number yet.
          </p>
        ) : (
          <ul className="space-y-2">
            {voiceTranscripts.map((t) => {
              // Note: deep-link uses the transcript row UUID, not the
              // Telnyx call_control_id (which contains a `:` that gets
              // path-decoded inconsistently between Cloudflare/Vercel
              // and Next.js — see getTranscriptById docstring).
              const durationLabel =
                t.started_at && t.ended_at
                  ? formatDurationShort(t.started_at, t.ended_at)
                  : t.status === "in_progress"
                    ? "in progress"
                    : null;
              return (
                <li key={t.id} className="border-l-2 border-parchment/10 pl-3">
                  <Link
                    href={`/dashboard/calls/${t.id}`}
                    className="text-sm text-parchment/90 hover:text-parchment transition-colors"
                  >
                    <span className="text-[10px] uppercase tracking-wide text-parchment/40 mr-2">
                      {t.started_at ? <LocalDateTime iso={t.started_at} /> : "–"}
                    </span>
                    {durationLabel && (
                      <span className="text-xs text-parchment/60 mr-2">
                        ({durationLabel})
                      </span>
                    )}
                    <span className="text-claw-green">view transcript →</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}

/**
 * Renewal/expiry badge state for a linked record document. Module-level
 * (not inline in JSX) so the wall-clock read stays out of the component
 * render path, matching the DocumentsManager badge helpers.
 */
function contactDocBadges(doc: { renewal_date: string | null; expires_at: string | null }): {
  renewal: { text: string; urgent: boolean } | null;
  expired: boolean;
} {
  const nowMs = Date.now();
  let renewal: { text: string; urgent: boolean } | null = null;
  if (doc.renewal_date) {
    const ms = Date.parse(doc.renewal_date);
    if (Number.isFinite(ms)) {
      const days = Math.ceil((ms - nowMs) / 86_400_000);
      renewal =
        days <= 0
          ? { text: "Renewal overdue", urgent: true }
          : { text: `Renews ${doc.renewal_date.slice(0, 10)}`, urgent: days <= 30 };
    }
  }
  const expired = Boolean(doc.expires_at && Date.parse(doc.expires_at) <= nowMs);
  return { renewal, expired };
}

/**
 * Compact "1m 22s" / "47s" / "1h 3m" formatter for the voice-calls
 * cross-link list. Lives inline because it's tiny and only consumed
 * by this view; promote to a util if a second caller appears.
 */
function formatDurationShort(startedAt: string, endedAt: string): string {
  const ms = Math.max(0, Date.parse(endedAt) - Date.parse(startedAt));
  if (!Number.isFinite(ms) || ms === 0) return "–";
  const totalSec = Math.round(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}
