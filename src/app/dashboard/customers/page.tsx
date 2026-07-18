/**
 * Cross-channel customers index (Phase 4 of the customer memory plan).
 *
 * Server-rendered listing of every customer the business has
 * interacted with across SMS + voice. Source of truth is the
 * customer_memories table (one row per business+E.164). Each row
 * links to its detail page for the unified history view + per-row
 * controls (edit display name, edit pinned notes, delete).
 *
 * Kept deliberately simple at first paint: no per-row JS, no
 * pagination beyond the page-size cap. A search box and pagination
 * are obvious follow-ups but neither is needed for the v1 surface.
 */

import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { resolveActiveBusinessContext } from "@/lib/dashboard/active-business";
import { getAuthUser } from "@/lib/auth";
import { resolveDashboardOwnerEmail } from "@/lib/admin/view-as";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { Card } from "@/components/ui/Card";
import { listCustomerMemories, MAX_LIST_LIMIT } from "@/lib/customer-memory/db";
import { findDuplicateContactPairs } from "@/lib/customer-memory/dedup";
import { listTeamMembers } from "@/lib/db/employees";
import { resolveContactNames, type ContactName } from "@/lib/db/contact-names";
import { listContactSegments } from "@/lib/segments/db";
import { AddCustomerForm } from "@/components/dashboard/AddCustomerForm";
import { DuplicateContactsCard } from "@/components/dashboard/DuplicateContactsCard";
import {
  CustomersList,
  type CustomerListRow
} from "@/components/dashboard/CustomersList";

export const dynamic = "force-dynamic";

export default async function DashboardCustomersPage() {
  const t = await getTranslations("dashboard.pages");
  const user = await getAuthUser();
  if (!user) redirect("/login?redirectTo=/dashboard/customers");
  if (!user.email) redirect("/login?redirectTo=/dashboard/customers");

  // Admin view-as swaps in the impersonated tenant's owner email.
  const ownerEmail = (await resolveDashboardOwnerEmail(user)) ?? user.email;

  const db = await createSupabaseServiceClient();
  const ctx = await resolveActiveBusinessContext(user);
  const activeBusinessId = ctx.businessId;
  const { data: businesses } = await db
    .from("businesses")
    .select("id, name")
    .in("id", activeBusinessId ? [activeBusinessId] : [])
    .order("created_at", { ascending: false });

  const business = businesses?.[0] ?? null;

  if (!business) {
    return (
      <div className="space-y-6 max-w-4xl">
        <div>
          <h1 className="text-2xl font-bold text-parchment">{t("customersTitle")}</h1>
          <p className="text-sm text-parchment/50 mt-1">
            {t("customersEmptySubtitle")}
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

  // Four independent reads, one round-trip wall-clock (previously
  // sequential):
  // - contacts: one unified list — every contact (customers + manual
  //   contacts) lives on the contacts table now, so a single query is the
  //   whole directory. The full directory (up to the cap) so Smart List
  //   chip counts evaluate over every contact, not just the recently
  //   active — an overdue/never-contacted list is exactly the rows a
  //   recency-ordered page would drop.
  // - duplicatePairs: same-email duplicate suggestions (owner-confirmed
  //   merges). Best-effort: a detection failure must never take down the
  //   directory page.
  // - segments: saved Smart Lists (one-click segments). Best-effort: the
  //   directory page must render even if the segments read fails.
  // - teamMembers: owner badges + the "owned by" filter show the roster
  //   member's NAME; one roster read covers every row (id → name).
  const [contacts, duplicatePairs, segments, teamMembers] = await Promise.all([
    listCustomerMemories(business.id, { limit: MAX_LIST_LIMIT }),
    findDuplicateContactPairs(business.id).catch(() => []),
    listContactSegments(business.id, db).catch(() => []),
    listTeamMembers(business.id, db).catch(() => [])
  ]);
  const directoryClipped = contacts.length >= MAX_LIST_LIMIT;
  // Smart List administration is manager+, same bar as the pipeline boards.
  const canManageSegments = ctx.role === "owner" || ctx.role === "manager";
  const memberNameById = new Map(teamMembers.map((m) => [m.id, m.name]));
  // Owner/employee/manual-label names win over the stored display_name, so the
  // owner's own number reads "Brian Lane (owner)" instead of a bare number, and
  // roster members get their names + badges here too.
  const contactNames = await resolveContactNames(
    business.id,
    contacts.map((c) => c.customer_e164),
    db
  ).catch(() => new Map<string, ContactName>());

  // Resolve the display name + type badge per row on the server. The overlaid
  // kind (owner/employee) wins for the badge; otherwise the stored type
  // (customer/tester/company/other) is shown.
  const customerRows: CustomerListRow[] = contacts.map((c) => {
    const contact = contactNames.get(c.customer_e164);
    const type =
      contact?.kind === "owner" || contact?.kind === "employee" ? contact.kind : c.type;
    return {
      e164: c.customer_e164,
      name: contact?.name ?? c.display_name ?? c.customer_e164,
      type,
      lastChannel: c.last_channel,
      pinned: Boolean(c.pinned_md?.trim()),
      summary: c.summary_md,
      totalInteractions: c.total_interaction_count,
      lastInteractionAt: c.last_interaction_at,
      tags: c.tags ?? [],
      ownerEmployeeId: c.owner_employee_id ?? null,
      ownerName: (c.owner_employee_id && memberNameById.get(c.owner_employee_id)) || null,
      createdAt: c.created_at,
      updatedAt: c.updated_at
    };
  });

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h1 className="text-2xl font-bold text-parchment">{t("contactsTitle")}</h1>
        <p className="text-sm text-parchment/50 mt-1">
          {t("contactsSubtitle")}
        </p>
      </div>

      <AddCustomerForm businessId={business.id} />

      {duplicatePairs.length > 0 ? (
        <DuplicateContactsCard businessId={business.id} pairs={duplicatePairs} />
      ) : null}

      <CustomersList
        rows={customerRows}
        businessId={business.id}
        segments={segments}
        owners={teamMembers.map((m) => ({ id: m.id, name: m.name }))}
        canManageSegments={canManageSegments}
        clipped={directoryClipped}
      />
    </div>
  );
}
