/**
 * Single-call transcript viewer. Server-rendered; mirrors the dashboard-chat
 * owner-scoped lookup (resolve business by caller email, then read transcripts
 * scoped by that business_id so a forged URL can't surface another owner's
 * call).
 */

import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { resolveActiveBusinessId } from "@/lib/dashboard/active-business";
import { notFound, redirect } from "next/navigation";
import { getAuthUser } from "@/lib/auth";
import { phiAccessRequestContext, recordPhiAccess } from "@/lib/hipaa/access-log";
import { resolveDashboardOwnerEmail } from "@/lib/admin/view-as";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { Card } from "@/components/ui/Card";
import { ChatMarkdown } from "@/components/ui/ChatMarkdown";
import {
  getTranscriptById,
  listTurns
} from "@/lib/db/voice-transcripts";
import {
  AnsweringMachineBadge,
  CallDirectionBadge,
  ForwardedBadge,
  SentimentBadge,
  StatusBadge,
  VerbatimScoreBadge,
  callerLabel,
  formatDuration
} from "@/components/dashboard/voice-transcript-helpers";
import { LocalDateTime } from "@/components/dashboard/LocalDateTime";
import { ContactNameEditor } from "@/components/dashboard/ContactNameEditor";
import { DeleteItemButton } from "@/components/dashboard/DeleteItemButton";
import { resolveContactNames, type ContactName } from "@/lib/db/contact-names";
import { getCustomerMemory } from "@/lib/customer-memory/db";
import { forwardedCallNotice, turnSpeaker } from "@/lib/voice/transcript-badges";

export const dynamic = "force-dynamic";

/**
 * Literal catalog keys, not template strings: the i18n key-usage guard greps
 * for the keys a surface actually uses, and a built key is invisible to it.
 */
const FORWARDED_NOTICE_KEYS = {
  missed: "callForwardedNoticeMissed",
  noTranscript: "callForwardedNoticeNoTranscript",
  transferred: "callForwardedNoticeTransferred",
  interpreted: "callForwardedNoticeInterpreted"
} as const;

const TURN_SPEAKER_KEYS = {
  assistant: "callTurnSpeakerAssistant",
  caller: "callTurnSpeakerCaller",
  callerOrTeammate: "callTurnSpeakerCallerOrTeammate"
} as const;

export default async function CallTranscriptPage({
  params
}: {
  params: Promise<{ callControlId: string }>;
}) {
  const t = await getTranslations("dashboard.pages");
  // The route segment is named `callControlId` for backward compatibility,
  // but the URL value is now the transcript row's UUID (see the list page
  // for the rationale, Telnyx call_control_id contains a literal `:` that
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
  const activeBusinessId = await resolveActiveBusinessId(user);
  const { data: businesses } = await db
    .from("businesses")
    .select("id, name, hipaa_mode")
    .in("id", activeBusinessId ? [activeBusinessId] : [])
    .order("created_at", { ascending: false });

  const business = businesses?.[0] ?? null;
  if (!business) notFound();

  const transcript = await getTranscriptById(business.id, transcriptId);
  if (!transcript) notFound();

  // HIPAA 164.312(b): this workforce member opened this call transcript.
  const phiCtx = await phiAccessRequestContext();
  await recordPhiAccess((business as { hipaa_mode?: boolean }).hipaa_mode, {
    businessId: business.id,
    userId: user.userId,
    userEmail: user.email,
    resource: "voice_transcript",
    resourceId: transcriptId,
    action: "view",
    ...phiCtx
  });

  // Everything below depends only on the transcript, one parallel group
  // instead of three serial awaits (for residency tenants each is a tunnel
  // round-trip to their box).
  const callerE164 = transcript.caller_e164?.trim() || null;
  const [turns, contactMap, memory] = await Promise.all([
    listTurns(transcript.id, { businessId: business.id }),
    // Name the caller (owner / roster member / manual override) and let the
    // owner set or edit that name inline, mirroring the SMS thread header.
    // Only a real caller number is editable.
    callerE164
      ? resolveContactNames(business.id, [callerE164], db).catch(
          () => new Map<string, ContactName>()
        )
      : Promise.resolve(new Map<string, ContactName>()),
    // Link the caller through to their contact profile when one exists
    // (alias-aware; the profile page 404s on numbers without a contacts row,
    // so only link when there is somewhere to land).
    callerE164
      ? getCustomerMemory(business.id, callerE164, db).catch(() => null)
      : Promise.resolve(null)
  ]);
  const contact = callerE164 ? contactMap.get(callerE164) : undefined;
  // What the transferred-call notice is allowed to claim. An interpreted call
  // keeps transcribing PAST the transfer, so the old single sentence ("only the
  // conversation before the transfer is below") was false for it.
  const forwardedNotice = forwardedCallNotice({
    callKind: transcript.call_kind,
    status: transcript.status,
    turnCount: turns.length,
    interpretedFromTurnIndex: transcript.interpreted_from_turn_index
  });

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <Link
          href="/dashboard/calls"
          className="text-xs text-parchment/60 hover:text-parchment transition-colors"
        >
          ← Back to call history
        </Link>
        <div className="mt-2 flex items-center justify-between gap-4">
          <h1 className="text-2xl font-bold text-parchment">{t("callTranscriptTitle")}</h1>
          <DeleteItemButton
            url={`/api/dashboard/calls/${transcript.id}?businessId=${encodeURIComponent(business.id)}`}
            confirmMessage="Delete this call and its transcript from your history?"
            redirectTo="/dashboard/calls"
            label="Delete call"
          />
        </div>
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
          <span>
            {/* Missed forwarded calls never ended normally (ended_at NULL),
                don't read that as a live call. */}
            {transcript.status === "missed"
              ? "no answer"
              : formatDuration(transcript.started_at, transcript.ended_at)}
          </span>
          {transcript.call_kind === "forwarded" && <ForwardedBadge />}
          <StatusBadge status={transcript.status} />
          {/* Only ever renders for a machine answer, so an ordinary call keeps
              the header it has today. */}
          <AnsweringMachineBadge
            result={transcript.answering_machine_result}
            voicemailLeft={transcript.voicemail_left}
          />
          <VerbatimScoreBadge score={transcript.voicemail_verbatim_score} />
        </div>
      </div>

      {forwardedNotice && (
        <Card padding="md">
          <p className="text-sm text-parchment/70 leading-relaxed">
            {t(FORWARDED_NOTICE_KEYS[forwardedNotice])}
            {transcript.forwarded_to_e164 && (
              <>
                {" "}
                {t("callForwardedTo")}{" "}
                <span className="font-mono">{transcript.forwarded_to_e164}</span>.
              </>
            )}
          </p>
        </Card>
      )}

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

      {/* Forwarded calls CAN have transcript turns: when the AI answers and
          then invokes transfer_to_owner, the pre-transfer exchange (greeting,
          caller request, handoff line) is transcribed. Hide the turns card
          only when there is genuinely nothing to show (ring-time forwards). */}
      {transcript.call_kind === "forwarded" && turns.length === 0 ? null : turns.length === 0 ? (
        <Card>
          <p className="text-sm text-parchment/60 text-center py-6">
            No transcript turns recorded for this call yet.
          </p>
        </Card>
      ) : (
        <Card padding="md">
          <ul className="space-y-4">
            {turns.map((turn) => {
              const isCaller = turn.role === "caller";
              const speaker = turnSpeaker({
                role: turn.role,
                turnIndex: turn.turn_index,
                interpretedFromTurnIndex: transcript.interpreted_from_turn_index
              });
              return (
                <li
                  key={turn.id}
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
                      {t(TURN_SPEAKER_KEYS[speaker])}
                    </div>
                    <ChatMarkdown text={turn.content} />
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
