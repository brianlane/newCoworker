"use client";

import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { LocalDateTime } from "@/components/dashboard/LocalDateTime";
import { SearchControl } from "@/components/dashboard/SearchControl";
import { ACTIVITY_BADGE } from "@/components/dashboard/activity-badge";
import { matchesQuery } from "@/lib/dashboard/search";
import type { ActivityItem } from "@/lib/db/activity";

/** Rows shown per page. Keeps each page scannable without endless scrolling. */
const PAGE_SIZE = 25;

/**
 * Full "See all activity" list. The parent server page loads ONE gap-free
 * chunk of activity items (newest-first, already ranked by recency); this
 * component filters them with the shared free-text search and paginates the
 * chunk in the browser, matching the calls/texts/emails list views. When the
 * tier window holds more history than one chunk, the server page passes
 * `olderHref`/`newestHref` cursor links so the ENTIRE window is reachable —
 * the search box only covers the currently loaded chunk.
 */
export function ActivityList({
  items,
  olderHref = null,
  newestHref = null
}: {
  items: ActivityItem[];
  /** Server link to the next-older chunk; null when the window is exhausted. */
  olderHref?: string | null;
  /** Server link back to the newest chunk; null when already on it. */
  newestHref?: string | null;
}) {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);

  const filtered = useMemo(
    () => items.filter((item) => matchesQuery(query, [item.label, ACTIVITY_BADGE[item.kind].label])),
    [items, query]
  );

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  // Clamp the page if a new query shrank the result set below the current page.
  const currentPage = Math.min(page, pageCount - 1);
  const start = currentPage * PAGE_SIZE;
  const visible = filtered.slice(start, start + PAGE_SIZE);

  const onQueryChange = (next: string) => {
    setQuery(next);
    setPage(0);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-parchment/40">
          {filtered.length === 0
            ? "No activity"
            : `Showing ${start + 1}–${Math.min(start + PAGE_SIZE, filtered.length)} of ${filtered.length}`}
        </p>
        <SearchControl
          value={query}
          onChange={onQueryChange}
          placeholder="Search activity…"
          idPrefix="activity-search"
        />
      </div>

      <Card>
        {visible.length === 0 ? (
          <p className="py-6 text-center text-sm text-parchment/40">
            {query ? "No activity matches your search." : "No activity yet."}
          </p>
        ) : (
          <ul className="divide-y divide-parchment/10">
            {visible.map((item) => (
              <li key={item.id}>
                <a
                  href={item.href}
                  className="flex items-center justify-between gap-3 py-3 group"
                >
                  <div className="min-w-0">
                    <p className="text-sm text-parchment truncate group-hover:text-signal-teal transition-colors">
                      {item.label}
                    </p>
                    <p className="text-xs text-parchment/40">
                      <LocalDateTime iso={item.at} />
                    </p>
                  </div>
                  <Badge variant={ACTIVITY_BADGE[item.kind].variant}>
                    {ACTIVITY_BADGE[item.kind].label}
                  </Badge>
                </a>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {pageCount > 1 && (
        <div className="flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={() => setPage(currentPage - 1)}
            disabled={currentPage === 0}
            className="rounded-md border border-parchment/15 px-3 py-1.5 text-xs text-parchment/80 hover:border-signal-teal/60 disabled:cursor-not-allowed disabled:opacity-40"
          >
            ← Previous
          </button>
          <span className="text-xs text-parchment/40">
            Page {currentPage + 1} of {pageCount}
          </span>
          <button
            type="button"
            onClick={() => setPage(currentPage + 1)}
            disabled={currentPage >= pageCount - 1}
            className="rounded-md border border-parchment/15 px-3 py-1.5 text-xs text-parchment/80 hover:border-signal-teal/60 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Next →
          </button>
        </div>
      )}

      {(olderHref || newestHref) && (
        <div className="flex items-center justify-center gap-4 border-t border-parchment/10 pt-3">
          {newestHref && (
            <a href={newestHref} className="text-xs text-signal-teal hover:underline">
              ← Back to newest
            </a>
          )}
          {olderHref && (
            <a href={olderHref} className="text-xs text-signal-teal hover:underline">
              Older activity →
            </a>
          )}
        </div>
      )}
    </div>
  );
}
