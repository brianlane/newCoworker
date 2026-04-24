/**
 * Single-call transcript viewer. Server-rendered; mirrors the dashboard-chat
 * owner-scoped lookup (resolve business by caller email, then read transcripts
 * scoped by that business_id so a forged URL can't surface another owner's
 * call).
 */

import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getAuthUser } from "@/lib/auth";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { ChatMarkdown } from "@/components/ui/ChatMarkdown";
import {
  getTranscriptByCallControlId,
  listTurns,
  type VoiceTranscriptStatus
} from "@/lib/db/voice-transcripts";

export const dynamic = "force-dynamic";

function formatDateTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit"
    });
  } catch {
    return iso;
  }
}

function formatDuration(startIso: string, endIso: string | null): string {
  if (!endIso) return "in progress";
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return "—";
  const seconds = Math.round((end - start) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder === 0 ? `${minutes}m` : `${minutes}m ${remainder}s`;
}

function statusBadge(status: VoiceTranscriptStatus) {
  switch (status) {
    case "in_progress":
      return <Badge variant="pending">In progress</Badge>;
    case "errored":
      return <Badge variant="error">Errored</Badge>;
    case "completed":
    default:
      return <Badge variant="success">Completed</Badge>;
  }
}

export default async function CallTranscriptPage({
  params
}: {
  params: Promise<{ callControlId: string }>;
}) {
  const { callControlId: raw } = await params;
  const callControlId = decodeURIComponent(raw);

  const user = await getAuthUser();
  if (!user) {
    redirect(`/login?redirectTo=/dashboard/calls/${encodeURIComponent(callControlId)}`);
  }
  if (!user.email) {
    redirect(`/login?redirectTo=/dashboard/calls/${encodeURIComponent(callControlId)}`);
  }

  const db = await createSupabaseServiceClient();
  const { data: businesses } = await db
    .from("businesses")
    .select("id, name")
    .eq("owner_email", user.email)
    .order("created_at", { ascending: false });

  const business = businesses?.[0] ?? null;
  if (!business) notFound();

  const transcript = await getTranscriptByCallControlId(business.id, callControlId);
  if (!transcript) notFound();

  const turns = await listTurns(transcript.id);

  const callerLabel = transcript.caller_e164?.trim()
    ? transcript.caller_e164
    : "Unknown caller";

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
          <span className="font-semibold text-parchment">{callerLabel}</span>
          <span>·</span>
          <span>{formatDateTime(transcript.started_at)}</span>
          <span>·</span>
          <span>{formatDuration(transcript.started_at, transcript.ended_at)}</span>
          {statusBadge(transcript.status)}
        </div>
      </div>

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
