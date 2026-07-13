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
 * One contact row, pre-resolved on the server: `name`/`type` already account for
 * owner/employee/manual-label overrides so the client can sort by display name
 * or type without re-resolving anything. `type` is the unified classification
 * (owner/employee/customer/tester/company/other).
 */
export type CustomerListRow = {
  e164: string;
  name: string;
  type: string;
  lastChannel: string | null;
  pinned: boolean;
  summary: string | null;
  totalInteractions: number;
  lastInteractionAt: string | null;
  /** Free-form owner-defined labels on this contact. */
  tags: string[];
  /** Owning roster member's name (resolved server-side); null = unowned. */
  ownerName: string | null;
  createdAt: string;
  updatedAt: string;
};

const CUSTOMER_SORT_OPTIONS: SortOption[] = [
  { key: "lastInteractionAt", label: "Last interaction" },
  { key: "name", label: "Name" },
  { key: "type", label: "Type" },
  { key: "createdAt", label: "Created" },
  { key: "updatedAt", label: "Updated" }
];

// Owner/employee read as identity badges; the rest are plain classifications.
const TYPE_BADGE_CLASS: Record<string, string> = {
  owner: "text-signal-teal/90 bg-signal-teal/10",
  employee: "text-amber-300/80 bg-amber-300/10",
  customer: "text-parchment/60 bg-parchment/10",
  tester: "text-fuchsia-300/80 bg-fuchsia-300/10",
  company: "text-sky-300/80 bg-sky-300/10",
  other: "text-parchment/60 bg-parchment/10"
};

function sortValue(row: CustomerListRow, field: string): string | number | null | undefined {
  if (field === "name") return row.name;
  if (field === "type") return row.type;
  if (field === "createdAt") return row.createdAt;
  if (field === "updatedAt") return row.updatedAt;
  return row.lastInteractionAt;
}

/**
 * Client wrapper for the cross-channel customers index. Sorts the already-
 * loaded page of rows in the browser (default: most-recent interaction first,
 * matching the server query) via the shared SortControl.
 */
export function CustomersList({ rows }: { rows: CustomerListRow[] }) {
  const [sort, setSort] = usePersistentSort(
    "dashboard.contacts.sort",
    { field: "lastInteractionAt", dir: "desc" },
    CUSTOMER_SORT_OPTIONS.map((o) => o.key)
  );
  const [query, setQuery] = useState("");
  const [tagFilter, setTagFilter] = useState("");
  const [ownerFilter, setOwnerFilter] = useState("");

  // Filter option lists come from the loaded rows themselves, so they always
  // reflect labels/owners that actually exist (case-insensitive tag identity).
  const allTags = Array.from(
    new Map(rows.flatMap((r) => r.tags).map((t) => [t.toLowerCase(), t])).values()
  ).sort((a, b) => a.localeCompare(b));
  const allOwners = Array.from(
    new Set(rows.map((r) => r.ownerName).filter((n): n is string => Boolean(n)))
  ).sort((a, b) => a.localeCompare(b));

  if (rows.length === 0) {
    return (
      <Card>
        <div className="text-center py-8">
          <p className="text-parchment/60">No contacts yet.</p>
          <p className="text-xs text-parchment/40 mt-2">
            Once someone texts or calls (or you add a contact), they&apos;ll appear here.
          </p>
        </div>
      </Card>
    );
  }

  const filtered = rows.filter(
    (r) =>
      matchesQuery(query, [r.name, r.e164, r.type, r.summary, r.tags.join(" ")]) &&
      (!tagFilter || r.tags.some((t) => t.toLowerCase() === tagFilter.toLowerCase())) &&
      (!ownerFilter || r.ownerName === ownerFilter)
  );
  const sorted = sortRows(filtered, (r) => sortValue(r, sort.field), sort.dir);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <SearchControl
          value={query}
          onChange={setQuery}
          placeholder="Search by name or number…"
          idPrefix="customer-search"
        />
        <div className="flex flex-wrap items-center gap-2">
          {allTags.length > 0 && (
            <select
              className="rounded-md border border-parchment/15 bg-deep-ink/40 px-2 py-1.5 text-xs text-parchment"
              value={tagFilter}
              onChange={(ev) => setTagFilter(ev.target.value)}
              aria-label="Filter by tag"
            >
              <option value="">All tags</option>
              {allTags.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          )}
          {allOwners.length > 0 && (
            <select
              className="rounded-md border border-parchment/15 bg-deep-ink/40 px-2 py-1.5 text-xs text-parchment"
              value={ownerFilter}
              onChange={(ev) => setOwnerFilter(ev.target.value)}
              aria-label="Filter by owning employee"
            >
              <option value="">Owned by anyone</option>
              {allOwners.map((n) => (
                <option key={n} value={n}>
                  Owned by {n}
                </option>
              ))}
            </select>
          )}
          <SortControl
            options={CUSTOMER_SORT_OPTIONS}
            field={sort.field}
            dir={sort.dir}
            onChange={setSort}
            idPrefix="customer-sort"
          />
        </div>
      </div>
      <Card padding="sm">
        {sorted.length === 0 && (
          <div className="py-6 text-center text-sm text-parchment/50">
            No contacts match “{query}”.
          </div>
        )}
        {/* Same bounded scroll window as the Emails page inbox list: the
            page stops growing with the contact count and the list scrolls
            in place. Newest-first, so no bottom anchoring. */}
        <ConversationScroll maxHeightClass="max-h-[70vh]" className="pr-1">
        <ul className="divide-y divide-parchment/10">
          {sorted.map((c) => (
            <li key={c.e164}>
              <Link
                href={`/dashboard/customers/${encodeURIComponent(c.e164)}`}
                className="flex items-center justify-between gap-4 px-3 py-3 rounded-lg hover:bg-parchment/5 transition-colors"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-semibold text-parchment truncate">
                      {c.name}
                    </span>
                    <span
                      className={`text-[10px] uppercase tracking-wide rounded px-1.5 py-0.5 ${
                        TYPE_BADGE_CLASS[c.type] ?? "text-parchment/60 bg-parchment/10"
                      }`}
                    >
                      {c.type}
                    </span>
                    {c.name !== c.e164 && (
                      <span className="text-xs text-parchment/50 font-mono">{c.e164}</span>
                    )}
                    {c.lastChannel && (
                      <span className="text-[10px] uppercase tracking-wide text-parchment/60 bg-parchment/10 rounded px-1.5 py-0.5">
                        {c.lastChannel}
                      </span>
                    )}
                    {c.pinned && (
                      <span
                        className="text-[10px] uppercase tracking-wide text-claw-green/90 bg-claw-green/10 rounded px-1.5 py-0.5"
                        title="Has pinned notes"
                      >
                        pinned
                      </span>
                    )}
                    {c.ownerName && (
                      <span
                        className="text-[10px] tracking-wide text-amber-300/80 bg-amber-300/10 rounded px-1.5 py-0.5"
                        title="Owning employee"
                      >
                        {c.ownerName}&apos;s
                      </span>
                    )}
                    {c.tags.map((t) => (
                      <span
                        key={t}
                        className="text-[10px] tracking-wide text-signal-teal/80 bg-signal-teal/10 rounded px-1.5 py-0.5"
                      >
                        {t}
                      </span>
                    ))}
                  </div>
                  {c.summary?.trim() && (
                    <p className="text-xs text-parchment/60 mt-0.5 line-clamp-2">
                      {c.summary.trim()}
                    </p>
                  )}
                  <p className="text-[10px] text-parchment/40 mt-0.5">
                    {c.totalInteractions} interaction
                    {c.totalInteractions === 1 ? "" : "s"}
                    {c.lastInteractionAt && (
                      <>
                        {" • last "}
                        <LocalDateTime iso={c.lastInteractionAt} />
                      </>
                    )}
                  </p>
                </div>
                <span className="text-parchment/40 text-sm shrink-0">View →</span>
              </Link>
            </li>
          ))}
        </ul>
        </ConversationScroll>
      </Card>
    </div>
  );
}
