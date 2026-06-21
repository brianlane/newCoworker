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
import { getAuthUser } from "@/lib/auth";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { Card } from "@/components/ui/Card";
import { listCustomerMemories, DEFAULT_LIST_LIMIT } from "@/lib/customer-memory/db";
import { resolveContactNames, type ContactName } from "@/lib/db/contact-names";
import { listContactOverrides } from "@/lib/db/contact-overrides";
import { AddCustomerForm } from "@/components/dashboard/AddCustomerForm";
import { OtherContactsManager } from "@/components/dashboard/OtherContactsManager";
import {
  CustomersList,
  type CustomerListRow
} from "@/components/dashboard/CustomersList";

export const dynamic = "force-dynamic";

export default async function DashboardCustomersPage() {
  const user = await getAuthUser();
  if (!user) redirect("/login?redirectTo=/dashboard/customers");
  if (!user.email) redirect("/login?redirectTo=/dashboard/customers");

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
          <h1 className="text-2xl font-bold text-parchment">Customers</h1>
          <p className="text-sm text-parchment/50 mt-1">
            Everyone your AI coworker has talked to across SMS and voice
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

  const [customers, otherContacts] = await Promise.all([
    listCustomerMemories(business.id, { limit: DEFAULT_LIST_LIMIT }),
    listContactOverrides(business.id).catch(() => [])
  ]);
  // Owner/employee/manual-override names win over the stored customer
  // display_name, so the owner's own number reads "Brian Lane (owner)" instead
  // of a bare number, and roster members get their names here too.
  const contactNames = await resolveContactNames(
    business.id,
    customers.map((c) => c.customer_e164),
    db
  ).catch(() => new Map<string, ContactName>());

  // Resolve the display name/badge per row on the server (owner/employee/
  // contact overrides win over the stored display_name), so the client list
  // can sort by the same name the user sees.
  const customerRows: CustomerListRow[] = customers.map((c) => {
    const contact = contactNames.get(c.customer_e164);
    return {
      e164: c.customer_e164,
      name: contact?.name ?? c.display_name ?? c.customer_e164,
      badge:
        contact?.kind === "employee" ? "employee" : contact?.kind === "owner" ? "owner" : null,
      lastChannel: c.last_channel,
      pinned: Boolean(c.pinned_md?.trim()),
      summary: c.summary_md,
      totalInteractions: c.total_interaction_count,
      lastInteractionAt: c.last_interaction_at,
      createdAt: c.created_at,
      updatedAt: c.updated_at
    };
  });

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h1 className="text-2xl font-bold text-parchment">Customers</h1>
        <p className="text-sm text-parchment/50 mt-1">
          Everyone your AI coworker has talked to across SMS and voice
        </p>
      </div>

      <Card padding="sm" className="border-signal-teal/30 bg-signal-teal/5">
        <p className="text-xs text-parchment/70 leading-relaxed">
          Your coworker uses these profiles to maintain continuity across
          channels. Pin notes about a customer to make them stick across
          every future SMS or call. Removing a customer here just clears
          the rollup — the underlying SMS and voice history stays in the
          per-channel dashboards.
        </p>
      </Card>

      <AddCustomerForm businessId={business.id} />

      <CustomersList rows={customerRows} />

      <div className="border-t border-parchment/10 pt-6">
        <OtherContactsManager
          businessId={business.id}
          initialContacts={otherContacts}
        />
      </div>
    </div>
  );
}
