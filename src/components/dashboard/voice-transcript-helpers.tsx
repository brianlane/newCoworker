/**
 * Shared presentation helpers for the owner-facing voice transcript pages
 * (`/dashboard/calls` list + `/dashboard/calls/[callControlId]` detail).
 *
 * Colocated with the other dashboard components rather than under `src/lib`
 * so the JSX-returning `statusBadge` can live in the same file as the plain
 * string helpers without forcing the callers into a second import.
 */

import { Badge } from "@/components/ui/Badge";
import type {
  VoiceCallSentiment,
  VoiceTranscriptDirection,
  VoiceTranscriptStatus
} from "@/lib/db/voice-transcripts";

export type FormatDateTimeStyle = "list" | "detail" | "date";

/**
 * List rows prefer compact "Apr 23, 4:15 PM"; detail header wants the weekday
 * prefix for scannability ("Thu, Apr 23, 4:15 PM"); "date" drops the time for
 * day-granular fields like billing dates ("Apr 23, 2026"). Keep them in one
 * place so the pages can never drift.
 */
export function formatDateTime(
  iso: string,
  style: FormatDateTimeStyle = "list",
  timeZone?: string
): string {
  try {
    const d = new Date(iso);
    const base: Intl.DateTimeFormatOptions =
      style === "detail"
        ? {
            weekday: "short",
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit"
          }
        : style === "date"
          ? {
              year: "numeric",
              month: "short",
              day: "numeric"
            }
          : {
              month: "short",
              day: "numeric",
              hour: "numeric",
              minute: "2-digit"
            };
    // `timeZone` lets callers force a deterministic zone (e.g. "UTC") so the
    // server and pre-hydration client markup match exactly; omit it to use the
    // viewer's local zone.
    const options = timeZone ? { ...base, timeZone } : base;
    return d.toLocaleString(undefined, options);
  } catch {
    return iso;
  }
}

export function formatDuration(startIso: string, endIso: string | null): string {
  if (!endIso) return "in progress";
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return "–";
  const seconds = Math.round((end - start) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder === 0 ? `${minutes}m` : `${minutes}m ${remainder}s`;
}

export function StatusBadge({ status }: { status: VoiceTranscriptStatus }) {
  switch (status) {
    case "in_progress":
      return <Badge variant="pending">In progress</Badge>;
    case "errored":
      return <Badge variant="error">Errored</Badge>;
    case "missed":
      return <Badge variant="error">Missed</Badge>;
    case "completed":
    default:
      return <Badge variant="success">Completed</Badge>;
  }
}

/**
 * Pill marking a routing-written forwarded call (transferred to a human, no
 * AI transcript) so it reads differently from AI-handled rows in the list.
 */
export function ForwardedBadge() {
  return (
    <span className="text-[10px] uppercase tracking-wide font-semibold rounded px-1.5 py-0.5 bg-parchment/10 text-parchment/60">
      Forwarded
    </span>
  );
}

/**
 * Caller-mood pill for AI call summaries (Standard+ perk). Neutral stays
 * muted so the list doesn't turn into a wall of pills; only the moods worth
 * a second look (negative/mixed → attention, positive → win) get color.
 */
export function SentimentBadge({ sentiment }: { sentiment: VoiceCallSentiment }) {
  const styles: Record<VoiceCallSentiment, string> = {
    positive: "bg-claw-green/15 text-claw-green",
    negative: "bg-red-400/15 text-red-300",
    mixed: "bg-amber-300/15 text-amber-300",
    neutral: "bg-parchment/10 text-parchment/50"
  };
  return (
    <span
      className={[
        "text-[10px] uppercase tracking-wide font-semibold rounded px-1.5 py-0.5",
        styles[sentiment]
      ].join(" ")}
    >
      {sentiment}
    </span>
  );
}

export function callerLabel(callerE164: string | null): string {
  return callerE164?.trim() ? callerE164 : "Unknown caller";
}

/**
 * Incoming / Outgoing pill for a call row + the transcript header. Outbound
 * (the coworker placed the call) reads as the assistant's accent (claw-green),
 * inbound (the business received it) as signal-teal — mirroring the email
 * list's Received/Sent direction badge.
 */
export function CallDirectionBadge({ direction }: { direction: VoiceTranscriptDirection }) {
  const outbound = direction === "outbound";
  return (
    <span
      className={[
        "text-[10px] uppercase tracking-wide font-semibold rounded px-1.5 py-0.5",
        outbound ? "bg-claw-green/15 text-claw-green" : "bg-signal-teal/15 text-signal-teal"
      ].join(" ")}
    >
      {outbound ? "Outgoing" : "Incoming"}
    </span>
  );
}
