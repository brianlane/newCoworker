"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
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
 * chunk in the browser, matching the calls/texts/emails list views.
 *
 * There is ONE Previous/Next control: within the loaded chunk it flips client
 * pages, and at either edge it becomes the server cursor link to the adjacent
 * chunk (`olderHref`/`newerHref`), so walking the entire tier window feels
 * like one continuous list. Cross-chunk steps are real navigations, so they're
 * suppressed while a search query is active — the search box only covers the
 * currently loaded chunk.
 */
export function ActivityList({
  items,
  olderHref = null,
  newerHref = null,
  startAtEnd = false
}: {
  items: ActivityItem[];
  /** Server link to the next-older chunk; null when the window is exhausted. */
  olderHref?: string | null;
  /** Server link to the next-newer chunk; null when already on the newest. */
  newerHref?: string | null;
  /** Open on the LAST client page (arriving here by stepping back from an older chunk). */
  startAtEnd?: boolean;
}) {
  const tBadge = useTranslations("dashboard.activityBadge");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(() =>
    startAtEnd ? Math.max(1, Math.ceil(items.length / PAGE_SIZE)) - 1 : 0
  );

  const filtered = useMemo(
    () =>
      items.filter((item) =>
        matchesQuery(query, [item.label, tBadge(ACTIVITY_BADGE[item.kind].labelKey)])
      ),
    [items, query, tBadge]
  );

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  // Clamp the page if a new query shrank the result set below the current page.
  const currentPage = Math.min(page, pageCount - 1);
  const start = currentPage * PAGE_SIZE;
  const visible = filtered.slice(start, start + PAGE_SIZE);

  // Cross-chunk steps reload the page (losing the query), so only offer them
  // when no search is active.
  const olderChunkHref = query === "" ? olderHref : null;
  const newerChunkHref = query === "" ? newerHref : null;
  const onFirstPage = currentPage === 0;
  const onLastPage = currentPage >= pageCount - 1;

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
                <div className="flex items-center justify-between gap-3 py-3 group">
                  <a href={item.href} className="min-w-0 flex-1">
                    <p className="text-sm text-parchment truncate group-hover:text-signal-teal transition-colors">
                      {item.label}
                    </p>
                    <p className="text-xs text-parchment/40">
                      <LocalDateTime iso={item.at} />
                    </p>
                  </a>
                  <div className="flex shrink-0 items-center gap-2">
                    {/* Person-keyed events cross-link both directions: the
                        contact profile and their card on the task board. */}
                    {item.contactE164 && (
                      <>
                        <a
                          href={`/dashboard/customers/${encodeURIComponent(item.contactE164)}`}
                          className="text-[11px] text-parchment/50 hover:text-signal-teal hover:underline"
                          title="Open this person's contact profile"
                        >
                          Contact
                        </a>
                        <a
                          href={`/dashboard/tasks?lead=${encodeURIComponent(item.contactE164)}`}
                          className="text-[11px] text-parchment/50 hover:text-signal-teal hover:underline"
                          title="Find this person on the task board"
                        >
                          Board
                        </a>
                      </>
                    )}
                    <Badge variant={ACTIVITY_BADGE[item.kind].variant}>
                      {tBadge(ACTIVITY_BADGE[item.kind].labelKey)}
                    </Badge>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {(pageCount > 1 || olderChunkHref || newerChunkHref) && (
        <div className="flex items-center justify-between gap-3">
          {onFirstPage && newerChunkHref ? (
            <a href={newerChunkHref} className={NAV_BUTTON}>
              ← Previous
            </a>
          ) : (
            <button
              type="button"
              onClick={() => setPage(currentPage - 1)}
              disabled={onFirstPage}
              className={NAV_BUTTON}
            >
              ← Previous
            </button>
          )}
          <span className="text-xs text-parchment/40">
            Page {currentPage + 1} of {pageCount}
            {olderChunkHref ? "+" : ""}
          </span>
          {onLastPage && olderChunkHref ? (
            <a href={olderChunkHref} className={NAV_BUTTON}>
              Next →
            </a>
          ) : (
            <button
              type="button"
              onClick={() => setPage(currentPage + 1)}
              disabled={onLastPage}
              className={NAV_BUTTON}
            >
              Next →
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** Shared look for the pager controls, whether rendered as <button> or <a>. */
const NAV_BUTTON =
  "rounded-md border border-parchment/15 px-3 py-1.5 text-xs text-parchment/80 hover:border-signal-teal/60 disabled:cursor-not-allowed disabled:opacity-40";
