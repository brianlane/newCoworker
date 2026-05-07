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

import Link from "next/link";
import { redirect } from "next/navigation";
import { getAuthUser } from "@/lib/auth";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { Card } from "@/components/ui/Card";
import { LocalDateTime } from "@/components/dashboard/LocalDateTime";
import { listCustomerMemories, DEFAULT_LIST_LIMIT } from "@/lib/customer-memory/db";

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

  const customers = await listCustomerMemories(business.id, {
    limit: DEFAULT_LIST_LIMIT
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

      {customers.length === 0 ? (
        <Card>
          <div className="text-center py-8">
            <p className="text-parchment/60">No customer interactions yet.</p>
            <p className="text-xs text-parchment/40 mt-2">
              Once a customer texts or calls, their profile will appear here.
            </p>
          </div>
        </Card>
      ) : (
        <Card padding="sm">
          <ul className="divide-y divide-parchment/10">
            {customers.map((c) => (
              <li key={c.customer_e164}>
                <Link
                  href={`/dashboard/customers/${encodeURIComponent(c.customer_e164)}`}
                  className="flex items-center justify-between gap-4 px-3 py-3 rounded-lg hover:bg-parchment/5 transition-colors"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-semibold text-parchment truncate">
                        {c.display_name ?? c.customer_e164}
                      </span>
                      {c.display_name && (
                        <span className="text-xs text-parchment/50 font-mono">
                          {c.customer_e164}
                        </span>
                      )}
                      {c.last_channel && (
                        <span className="text-[10px] uppercase tracking-wide text-parchment/60 bg-parchment/10 rounded px-1.5 py-0.5">
                          {c.last_channel}
                        </span>
                      )}
                      {c.pinned_md?.trim() && (
                        <span
                          className="text-[10px] uppercase tracking-wide text-claw-green/90 bg-claw-green/10 rounded px-1.5 py-0.5"
                          title="Has pinned notes"
                        >
                          pinned
                        </span>
                      )}
                    </div>
                    {c.summary_md?.trim() && (
                      <p className="text-xs text-parchment/60 mt-0.5 line-clamp-2">
                        {c.summary_md.trim()}
                      </p>
                    )}
                    <p className="text-[10px] text-parchment/40 mt-0.5">
                      {c.total_interaction_count} interaction
                      {c.total_interaction_count === 1 ? "" : "s"}
                      {c.last_interaction_at && (
                        <>
                          {" • last "}
                          <LocalDateTime iso={c.last_interaction_at} />
                        </>
                      )}
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
