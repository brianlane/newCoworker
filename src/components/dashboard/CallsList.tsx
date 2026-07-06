"use client";

import { useState } from "react";
import Link from "next/link";
import { Card } from "@/components/ui/Card";
import { LocalDateTime } from "@/components/dashboard/LocalDateTime";
import {
  CallDirectionBadge,
  ForwardedBadge,
  SentimentBadge,
  StatusBadge,
  formatDuration
} from "@/components/dashboard/voice-transcript-helpers";
import type {
  VoiceCallKind,
  VoiceCallSentiment,
  VoiceTranscriptDirection,
  VoiceTranscriptStatus
} from "@/lib/db/voice-transcripts";
import { SortControl, type SortOption } from "@/components/dashboard/SortControl";
import { SearchControl } from "@/components/dashboard/SearchControl";
import { sortRows } from "@/lib/dashboard/sort";
import { usePersistentSort } from "@/components/dashboard/usePersistentSort";
import { matchesQuery } from "@/lib/dashboard/search";

/**
 * One call row, pre-resolved on the server: `label` already accounts for
 * owner/employee/contact-name overrides so the client can sort/search by the
 * display name without re-resolving anything.
 */
export type CallListRow = {
  id: string;
  label: string;
  e164: string | null;
  /** owner/employee badge, or null for a plain caller. */
  badgeKind: "owner" | "employee" | null;
  status: VoiceTranscriptStatus;
  direction: VoiceTranscriptDirection;
  /** ai = bridge transcript; forwarded = call transferred to a human. */
  callKind: VoiceCallKind;
  /** For forwarded calls: the human number it was sent to (display only). */
  forwardedTo: string | null;
  startedAt: string;
  endedAt: string | null;
  /** AI digest + caller mood (Standard+ perk); null while unsummarized. */
  summary: string | null;
  sentiment: VoiceCallSentiment | null;
};

const CALL_SORT_OPTIONS: SortOption[] = [
  { key: "startedAt", label: "Date" },
  { key: "label", label: "Name" },
  { key: "direction", label: "Direction" },
  { key: "status", label: "Status" }
];

function sortValue(row: CallListRow, field: string): string | number | null | undefined {
  if (field === "label") return row.label;
  if (field === "status") return row.status;
  if (field === "direction") return row.direction;
  return row.startedAt;
}

export function CallsList({ rows }: { rows: CallListRow[] }) {
  const [sort, setSort] = usePersistentSort(
    "dashboard.calls.sort",
    { field: "startedAt", dir: "desc" },
    CALL_SORT_OPTIONS.map((o) => o.key)
  );
  const [query, setQuery] = useState("");

  const filtered = rows.filter((r) => matchesQuery(query, [r.label, r.e164, r.summary]));
  const sorted = sortRows(filtered, (r) => sortValue(r, sort.field), sort.dir);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <SearchControl
          value={query}
          onChange={setQuery}
          placeholder="Search by name or number…"
          idPrefix="calls-search"
        />
        <SortControl
          options={CALL_SORT_OPTIONS}
          field={sort.field}
          dir={sort.dir}
          onChange={setSort}
          idPrefix="calls-sort"
        />
      </div>
      <Card padding="sm">
        {sorted.length === 0 ? (
          <div className="py-6 text-center text-sm text-parchment/50">
            No calls match “{query}”.
          </div>
        ) : (
          <ul className="divide-y divide-parchment/10">
            {sorted.map((row) => (
              <li key={row.id}>
                <Link
                  // Link by transcript row UUID rather than the Telnyx
                  // call_control_id (which starts with `v3:` — the `:` is a URL
                  // sub-delim some edges pre-decode, 404ing on rows that exist).
                  href={`/dashboard/calls/${row.id}`}
                  className="flex items-center justify-between gap-4 px-3 py-3 rounded-lg hover:bg-parchment/5 transition-colors"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <CallDirectionBadge direction={row.direction} />
                      <span className="text-sm font-semibold text-parchment truncate">
                        {row.label}
                      </span>
                      {row.badgeKind && (
                        <span className="text-[10px] uppercase tracking-wide text-parchment/40">
                          {row.badgeKind}
                        </span>
                      )}
                      {row.e164 && row.label !== row.e164 && (
                        <span className="text-[10px] text-parchment/40 font-mono">
                          {row.e164}
                        </span>
                      )}
                      {row.callKind === "forwarded" && <ForwardedBadge />}
                      <StatusBadge status={row.status} />
                    </div>
                    <p className="text-xs text-parchment/50 mt-0.5">
                      <LocalDateTime iso={row.startedAt} /> ·{" "}
                      {/* A missed forwarded call never ended normally — its
                          ended_at is NULL, which formatDuration would read as
                          a live call. */}
                      {row.status === "missed"
                        ? "no answer"
                        : formatDuration(row.startedAt, row.endedAt)}
                      {row.callKind === "forwarded" && row.forwardedTo && (
                        <span className="font-mono"> · to {row.forwardedTo}</span>
                      )}
                      {row.sentiment && (
                        <>
                          {" "}
                          <SentimentBadge sentiment={row.sentiment} />
                        </>
                      )}
                    </p>
                    {row.summary && (
                      <p className="text-xs text-parchment/60 mt-1 line-clamp-2">
                        {row.summary}
                      </p>
                    )}
                  </div>
                  <span className="text-parchment/40 text-sm shrink-0">View →</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
