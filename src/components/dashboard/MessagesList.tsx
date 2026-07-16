"use client";

import { useState } from "react";
import Link from "next/link";
import { Card } from "@/components/ui/Card";
import { LocalDateTime } from "@/components/dashboard/LocalDateTime";
import { SortControl, type SortOption } from "@/components/dashboard/SortControl";
import { SearchControl } from "@/components/dashboard/SearchControl";
import { ConversationScroll } from "@/components/dashboard/ConversationScroll";
import { sortRows } from "@/lib/dashboard/sort";
import { usePersistentSort } from "@/components/dashboard/usePersistentSort";
import { matchesQuery } from "@/lib/dashboard/search";

/**
 * One conversation row, pre-resolved on the server: `name` already accounts for
 * owner/employee/contact-name overrides so the client can sort/search by the
 * display name without re-resolving anything.
 */
export type MessageListRow = {
  customerE164: string;
  name: string;
  badgeKind: "owner" | "employee" | null;
  lastMessage: string;
  lastMessageAt: string;
  messageCount: number;
};

const MESSAGE_SORT_OPTIONS: SortOption[] = [
  { key: "lastMessageAt", label: "Date" },
  { key: "name", label: "Name" },
  { key: "messageCount", label: "Messages" }
];

function sortValue(row: MessageListRow, field: string): string | number | null | undefined {
  if (field === "name") return row.name;
  if (field === "messageCount") return row.messageCount;
  return row.lastMessageAt;
}

export function MessagesList({ rows }: { rows: MessageListRow[] }) {
  const [sort, setSort] = usePersistentSort(
    "dashboard.messages.sort",
    { field: "lastMessageAt", dir: "desc" },
    MESSAGE_SORT_OPTIONS.map((o) => o.key)
  );
  const [query, setQuery] = useState("");

  const filtered = rows.filter((r) =>
    matchesQuery(query, [r.name, r.customerE164, r.lastMessage])
  );
  const sorted = sortRows(filtered, (r) => sortValue(r, sort.field), sort.dir);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <SearchControl
          value={query}
          onChange={setQuery}
          placeholder="Search by name or number…"
          idPrefix="messages-search"
        />
        <SortControl
          options={MESSAGE_SORT_OPTIONS}
          field={sort.field}
          dir={sort.dir}
          onChange={setSort}
          idPrefix="messages-sort"
        />
      </div>
      <Card padding="sm">
        {sorted.length === 0 ? (
          <div className="py-6 text-center text-sm text-parchment/50">
            No conversations match “{query}”.
          </div>
        ) : (
          // Same bounded scroll window as the Emails page inbox list: the
          // page stops growing with the thread count and everything below
          // the list stays reachable. Newest-first, so no bottom anchoring.
          <ConversationScroll maxHeightClass="max-h-[70vh]" className="pr-1">
          <ul className="divide-y divide-parchment/10">
            {sorted.map((c) => (
              <li key={c.customerE164}>
                <Link
                  href={`/dashboard/messages/${encodeURIComponent(c.customerE164)}`}
                  className="flex items-center justify-between gap-4 px-3 py-3 rounded-lg hover:bg-parchment/5 transition-colors"
                >
                  <div className="min-w-0 flex-1">
                    {/* flex-wrap (as in CustomersList): the name is the only
                        shrinkable item, so without wrapping it absorbed all the
                        squeeze on phones — "Brian" rendered as "Bri…" while the
                        E.164 and badges kept full width. */}
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                      <span className="text-sm font-semibold text-parchment truncate" title={c.name}>
                        {c.name}
                      </span>
                      {c.badgeKind && (
                        <span className="shrink-0 text-[10px] uppercase tracking-wide text-parchment/40">
                          {c.badgeKind}
                        </span>
                      )}
                      {c.name !== c.customerE164 && (
                        <span className="shrink-0 text-[10px] text-parchment/40 font-mono">
                          {c.customerE164}
                        </span>
                      )}
                      <span className="shrink-0 text-[10px] uppercase tracking-wide text-parchment/40 font-mono">
                        {c.messageCount} msg{c.messageCount === 1 ? "" : "s"}
                      </span>
                    </div>
                    <p className="text-xs text-parchment/60 mt-0.5 truncate">
                      {c.lastMessage}
                    </p>
                    <p className="text-[10px] text-parchment/40 mt-0.5">
                      <LocalDateTime iso={c.lastMessageAt} />
                    </p>
                  </div>
                  <span className="text-parchment/40 text-sm shrink-0">View →</span>
                </Link>
              </li>
            ))}
          </ul>
          </ConversationScroll>
        )}
      </Card>
    </div>
  );
}
