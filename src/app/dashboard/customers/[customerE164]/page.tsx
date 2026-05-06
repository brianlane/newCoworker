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
import Link from "next/link";
import { getAuthUser, requireOwner } from "@/lib/auth";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { Card } from "@/components/ui/Card";
import { LocalDateTime } from "@/components/dashboard/LocalDateTime";
import {
  getCustomerMemory,
  listSmsHistoryForCustomer
} from "@/lib/customer-memory/db";
import { CustomerProfileEditor } from "@/components/dashboard/CustomerProfileEditor";

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
  if (!/^\+[1-9]\d{6,15}$/.test(customerE164)) {
    notFound();
  }

  const db = await createSupabaseServiceClient();
  const { data: businesses } = await db
    .from("businesses")
    .select("id, name")
    .eq("owner_email", user.email)
    .order("created_at", { ascending: false });

  const business = businesses?.[0];
  if (!business) redirect("/onboard");

  if (!user.isAdmin) await requireOwner(business.id);

  const memory = await getCustomerMemory(business.id, customerE164);
  if (!memory) notFound();

  const smsHistory = await listSmsHistoryForCustomer(business.id, customerE164, {
    limit: 50
  });

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <Link
          href="/dashboard/customers"
          className="text-xs text-parchment/50 hover:text-parchment/80 transition-colors"
        >
          ← Customers
        </Link>
        <h1 className="text-2xl font-bold text-parchment mt-2">
          {memory.display_name?.trim() || memory.customer_e164}
        </h1>
        {memory.display_name && (
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
        </div>
      </div>

      <CustomerProfileEditor
        businessId={business.id}
        customerE164={memory.customer_e164}
        initialDisplayName={memory.display_name}
        initialPinnedMd={memory.pinned_md}
      />

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
            No summary yet — it&apos;ll appear here after a few interactions.
          </p>
        </Card>
      )}

      <Card>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-parchment">SMS history</h2>
          <Link
            href={`/dashboard/messages/${encodeURIComponent(customerE164)}`}
            className="text-xs text-claw-green hover:underline"
          >
            Full thread →
          </Link>
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
                <p className="text-sm text-parchment/90 mt-0.5">
                  <span className="text-parchment/40 mr-1">Customer:</span>
                  {entry.inboundText}
                </p>
                {entry.assistantReply && (
                  <p className="text-sm text-parchment/70 mt-1">
                    <span className="text-parchment/40 mr-1">Coworker:</span>
                    {entry.assistantReply}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

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
        <p className="text-xs text-parchment/50">
          Recent voice calls for this customer appear in the Calls dashboard.
          Cross-linking individual transcripts here is coming with Phase 4
          follow-up.
        </p>
      </Card>
    </div>
  );
}
