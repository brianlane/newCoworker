/**
 * Single-call transcript viewer. Server-rendered; mirrors the dashboard-chat
 * owner-scoped lookup (resolve business by caller email, then read transcripts
 * scoped by that business_id so a forged URL can't surface another owner's
 * call).
 */

import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getAuthUser } from "@/lib/auth";
import { resolveDashboardOwnerEmail } from "@/lib/admin/view-as";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { Card } from "@/components/ui/Card";
import { ChatMarkdown } from "@/components/ui/ChatMarkdown";
import {
  getTranscriptById,
  listTurns
} from "@/lib/db/voice-transcripts";
import {
  CallDirectionBadge,
  SentimentBadge,
  StatusBadge,
  callerLabel,
  formatDuration
} from "@/components/dashboard/voice-transcript-helpers";
import { LocalDateTime } from "@/components/dashboard/LocalDateTime";
import { ContactNameEditor } from "@/components/dashboard/ContactNameEditor";
import { resolveContactNames, type ContactName } from "@/lib/db/contact-names";
import { getCustomerMemory } from "@/lib/customer-memory/db";

export const dynamic = "force-dynamic";

export default async function CallTranscriptPage({
  params
}: {
  params: Promise<{ callControlId: string }>;
}) {
  // The route segment is named `callControlId` for backward compatibility,
  // but the URL value is now the transcript row's UUID (see the list page
  // for the rationale — Telnyx call_control_id contains a literal `:` that
  // the Cloudflare/Vercel routing layer occasionally mangles, producing
  // 404s on rows that exist in the DB). UUIDs are URL-safe everywhere.
  const { callControlId: rawId } = await params;
  const transcriptId = rawId;

  const user = await getAuthUser();
  if (!user) {
    redirect(`/login?redirectTo=/dashboard/calls/${transcriptId}`);
  }
  if (!user.email) {
    redirect(`/login?redirectTo=/dashboard/calls/${transcriptId}`);
  }

  // Admin view-as swaps in the impersonated tenant's owner email.
  const ownerEmail = (await resolveDashboardOwnerEmail(user)) ?? user.email;

  const db = await createSupabaseServiceClient();
  const { data: businesses } = await db
    .from("businesses")
    .select("id, name")
    .eq("owner_email", ownerEmail)
    .order("created_at", { ascending: false });

  const business = businesses?.[0] ?? null;
  if (!business) notFound();

  const transcript = await getTranscriptById(business.id, transcriptId);
  if (!transcript) notFound();

  const turns = await listTurns(transcript.id);

  // Name the caller (owner / roster member / manual override) and let the owner
  // set or edit that name inline, mirroring the SMS thread header. Only a real
  // caller number is editable — a missing/anonymous caller has nothing to key on.
  const callerE164 = transcript.caller_e164?.trim() || null;
  const contact = callerE164
    ? (
        await resolveContactNames(business.id, [callerE164], db).catch(
          () => new Map<string, ContactName>()
        )
      ).get(callerE164)
    : undefined;
  // Link the caller through to their contact profile when one exists
  // (alias-aware; the profile page 404s on numbers without a contacts row,
  // so only link when there is somewhere to land).
  const memory = callerE164
    ? await getCustomerMemory(business.id, callerE164, db).catch(() => null)
    : null;

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <Link
          href="/dashboard/calls"
          className="text-xs text-parchment/60 hover:text-parchment transition-colors"
        >
          ← Back to call history
        </Link>
        <h1 className="text-2xl font-bold text-parchment mt-2">Call transcript</h1>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-parchment/60">
          <CallDirectionBadge direction={transcript.direction} />
          {memory ? (
            <Link
              href={`/dashboard/customers/${encodeURIComponent(memory.customer_e164)}`}
              className="font-semibold text-parchment underline decoration-parchment/30 underline-offset-2 hover:text-claw-green transition-colors"
            >
              {contact?.name ?? callerLabel(transcript.caller_e164)}
            </Link>
          ) : (
            <span className="font-semibold text-parchment">
              {contact?.name ?? callerLabel(transcript.caller_e164)}
            </span>
          )}
          {contact?.kind === "employee" && (
            <span className="text-[10px] uppercase tracking-wide text-amber-300/80 bg-amber-300/10 rounded px-1.5 py-0.5">
              employee
            </span>
          )}
          {contact?.kind === "owner" && (
            <span className="text-[10px] uppercase tracking-wide text-signal-teal/90 bg-signal-teal/10 rounded px-1.5 py-0.5">
              owner
            </span>
          )}
          {contact && callerE164 && (
            <span className="font-mono text-xs">{callerE164}</span>
          )}
          {callerE164 && (
            <ContactNameEditor
              key={callerE164}
              businessId={business.id}
              e164={callerE164}
              currentName={contact?.name ?? null}
              hasOverride={Boolean(contact?.override)}
            />
          )}
          <span>·</span>
          <LocalDateTime iso={transcript.started_at} style="detail" />
          <span>·</span>
          <span>{formatDuration(transcript.started_at, transcript.ended_at)}</span>
          <StatusBadge status={transcript.status} />
        </div>
      </div>

      {transcript.summary && (
        <Card padding="md">
          <div className="flex items-center gap-2 mb-2">
            <h2 className="text-xs uppercase tracking-wide font-semibold text-parchment/60">
              AI summary
            </h2>
            {transcript.sentiment && <SentimentBadge sentiment={transcript.sentiment} />}
          </div>
          <p className="text-sm text-parchment/80 leading-relaxed">{transcript.summary}</p>
        </Card>
      )}

      {turns.length === 0 ? (
        <Card>
          <p className="text-sm text-parchment/60 text-center py-6">
            No transcript turns recorded for this call yet.
          </p>
        </Card>
      ) : (
        <Card padding="md">
          <ul className="space-y-4">
            {turns.map((t) => {
              const isCaller = t.role === "caller";
              return (
                <li
                  key={t.id}
                  className={[
                    "flex",
                    isCaller ? "justify-start" : "justify-end"
                  ].join(" ")}
                >
                  <div
                    className={[
                      "max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed",
                      isCaller
                        ? "bg-parchment/10 text-parchment"
                        : "bg-claw-green/20 text-parchment"
                    ].join(" ")}
                  >
                    <div className="text-[10px] uppercase tracking-wide text-parchment/50 mb-1">
                      {isCaller ? "Caller" : "Assistant"}
                    </div>
                    <ChatMarkdown text={t.content} />
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>
      )}
    </div>
  );
}
