"use client";

import { useState } from "react";
import Link from "next/link";
import { Card } from "@/components/ui/Card";
import { LocalDateTime } from "@/components/dashboard/LocalDateTime";
import { SortControl, type SortOption } from "@/components/dashboard/SortControl";
import { sortRows, type SortDir } from "@/lib/dashboard/sort";

/**
 * One customer row, pre-resolved on the server: `name`/`badge` already account
 * for owner/employee/contact overrides so the client can sort by display name
 * without re-resolving anything.
 */
export type CustomerListRow = {
  e164: string;
  name: string;
  badge: "employee" | "owner" | null;
  lastChannel: string | null;
  pinned: boolean;
  summary: string | null;
  totalInteractions: number;
  lastInteractionAt: string | null;
  createdAt: string;
  updatedAt: string;
};

const CUSTOMER_SORT_OPTIONS: SortOption[] = [
  { key: "lastInteractionAt", label: "Last interaction" },
  { key: "name", label: "Name" },
  { key: "createdAt", label: "Created" },
  { key: "updatedAt", label: "Updated" }
];

function sortValue(row: CustomerListRow, field: string): string | number | null | undefined {
  if (field === "name") return row.name;
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
  const [sort, setSort] = useState<{ field: string; dir: SortDir }>({
    field: "lastInteractionAt",
    dir: "desc"
  });

  if (rows.length === 0) {
    return (
      <Card>
        <div className="text-center py-8">
          <p className="text-parchment/60">No customer interactions yet.</p>
          <p className="text-xs text-parchment/40 mt-2">
            Once a customer texts or calls, their profile will appear here.
          </p>
        </div>
      </Card>
    );
  }

  const sorted = sortRows(rows, (r) => sortValue(r, sort.field), sort.dir);

  return (
    <div className="space-y-2">
      <div className="flex justify-end">
        <SortControl
          options={CUSTOMER_SORT_OPTIONS}
          field={sort.field}
          dir={sort.dir}
          onChange={(field, dir) => setSort({ field, dir })}
          idPrefix="customer-sort"
        />
      </div>
      <Card padding="sm">
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
                    {c.badge && (
                      <span className="text-[10px] uppercase tracking-wide text-parchment/40">
                        {c.badge}
                      </span>
                    )}
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
      </Card>
    </div>
  );
}
