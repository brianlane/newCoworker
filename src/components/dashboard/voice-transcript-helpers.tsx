/**
 * Shared presentation helpers for the owner-facing voice transcript pages
 * (`/dashboard/calls` list + `/dashboard/calls/[callControlId]` detail).
 *
 * Colocated with the other dashboard components rather than under `src/lib`
 * so the JSX-returning `statusBadge` can live in the same file as the plain
 * string helpers without forcing the callers into a second import.
 */

import { Badge } from "@/components/ui/Badge";
import type { VoiceTranscriptStatus } from "@/lib/db/voice-transcripts";

export type FormatDateTimeStyle = "list" | "detail";

/**
 * List rows prefer compact "Apr 23, 4:15 PM"; detail header wants the weekday
 * prefix for scannability ("Thu, Apr 23, 4:15 PM"). Keep both in one place so
 * the two pages can never drift.
 */
export function formatDateTime(
  iso: string,
  style: FormatDateTimeStyle = "list"
): string {
  try {
    const d = new Date(iso);
    const options: Intl.DateTimeFormatOptions =
      style === "detail"
        ? {
            weekday: "short",
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit"
          }
        : {
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit"
          };
    return d.toLocaleString(undefined, options);
  } catch {
    return iso;
  }
}

export function formatDuration(startIso: string, endIso: string | null): string {
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

export function StatusBadge({ status }: { status: VoiceTranscriptStatus }) {
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

export function callerLabel(callerE164: string | null): string {
  return callerE164?.trim() ? callerE164 : "Unknown caller";
}
