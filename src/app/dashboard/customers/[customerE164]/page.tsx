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
  listCustomerMemories,
  listSmsHistoryForCustomer
} from "@/lib/customer-memory/db";
import { listTranscriptsForCaller } from "@/lib/db/voice-transcripts";
import { CustomerProfileEditor } from "@/components/dashboard/CustomerProfileEditor";
import { CustomerMergeAction } from "@/components/dashboard/CustomerMergeAction";

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

  // Phase 4 + 4b: pull SMS + voice in parallel so the page hydrates in
  // one round-trip group rather than serial. Voice list is capped at
  // 10 — the per-call transcript page is one click away for full detail.
  // Both lists key off the PROFILE's primary number + its merged aliases —
  // not the URL value, which after a merge may itself be an alias (the
  // alias-aware getCustomerMemory above already resolved it). Keying off
  // the raw URL number dropped everything stored under the primary.
  const [smsHistory, voiceTranscripts, allCustomers] = await Promise.all([
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
    listCustomerMemories(business.id, { limit: 200 }).catch(() => [])
  ]);
  const mergeCandidates = allCustomers
    .filter((c) => c.customer_e164 !== memory.customer_e164)
    .map((c) => ({ customerE164: c.customer_e164, displayName: c.display_name }));

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
          {(memory.alias_e164s ?? []).map((alias) => (
            <span
              key={alias}
              className="text-parchment/70 bg-parchment/10 rounded px-2 py-0.5 font-mono"
              title="Merged-in number — texts and calls from it land on this profile"
            >
              also {alias}
            </span>
          ))}
        </div>
      </div>

      <CustomerProfileEditor
        businessId={business.id}
        customerE164={memory.customer_e164}
        initialDisplayName={memory.display_name}
        initialPinnedMd={memory.pinned_md}
      />

      <CustomerMergeAction
        businessId={business.id}
        customerE164={memory.customer_e164}
        candidates={mergeCandidates}
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
                      {t.started_at ? <LocalDateTime iso={t.started_at} /> : "—"}
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
 * Compact "1m 22s" / "47s" / "1h 3m" formatter for the voice-calls
 * cross-link list. Lives inline because it's tiny and only consumed
 * by this view; promote to a util if a second caller appears.
 */
function formatDurationShort(startedAt: string, endedAt: string): string {
  const ms = Math.max(0, Date.parse(endedAt) - Date.parse(startedAt));
  if (!Number.isFinite(ms) || ms === 0) return "—";
  const totalSec = Math.round(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}
