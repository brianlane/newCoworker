"use client";

import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/Badge";
import { LocalDateTime } from "@/components/dashboard/LocalDateTime";
import type { EngagementSegment, UserEngagementRow } from "@/lib/admin/user-engagement";

const SEGMENTS: EngagementSegment[] = ["active", "new", "cooling", "quiet"];

function segmentBadgeVariant(segment: EngagementSegment): "success" | "pending" | "neutral" | "error" {
  if (segment === "active") return "success";
  if (segment === "new") return "pending";
  if (segment === "cooling") return "neutral";
  return "error";
}

/**
 * Sortable / filterable per-user engagement table (all owners + team
 * members). Rows are precomputed server-side by
 * src/lib/admin/user-engagement.ts; this component is display state only.
 */
export function UserEngagementTable({ rows }: { rows: UserEngagementRow[] }) {
  const [segment, setSegment] = useState<EngagementSegment | null>(null);
  const [search, setSearch] = useState("");
  const [sortDir, setSortDir] = useState<"desc" | "asc">("desc");

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const filtered = rows.filter((row) => {
      if (segment && row.segment !== segment) return false;
      if (
        needle &&
        !row.email.includes(needle) &&
        !(row.businessName ?? "").toLowerCase().includes(needle)
      ) {
        return false;
      }
      return true;
    });
    const sign = sortDir === "desc" ? 1 : -1;
    return [...filtered].sort((a, b) => {
      const am = a.lastSignInAt ? Date.parse(a.lastSignInAt) : Number.NEGATIVE_INFINITY;
      const bm = b.lastSignInAt ? Date.parse(b.lastSignInAt) : Number.NEGATIVE_INFINITY;
      return (bm - am) * sign;
    });
  }, [rows, segment, search, sortDir]);

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-b border-parchment/10">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search email or business…"
          aria-label="Search users"
          className="w-56 rounded-md border border-parchment/20 bg-deep-ink px-2.5 py-1.5 text-xs text-parchment placeholder:text-parchment/30 focus:outline-none focus:ring-1 focus:ring-signal-teal"
        />
        <div className="flex items-center gap-1.5">
          {SEGMENTS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setSegment((prev) => (prev === s ? null : s))}
              className={`rounded-full border px-2.5 py-0.5 text-xs transition-colors ${
                segment === s
                  ? "border-signal-teal bg-signal-teal/20 text-signal-teal"
                  : "border-parchment/20 text-parchment/50 hover:text-parchment/80"
              }`}
            >
              {s}
            </button>
          ))}
        </div>
        <span className="text-xs text-parchment/40 ml-auto">
          {visible.length} of {rows.length}
        </span>
      </div>
      <div className="mobile-scroll-x">
        <table className="w-full min-w-[640px] text-sm">
          <thead>
            <tr className="border-b border-parchment/10">
              <th className="text-left py-3 px-4 text-parchment/40 font-medium">User</th>
              <th className="text-left py-3 px-4 text-parchment/40 font-medium">Business</th>
              <th className="text-left py-3 px-4 text-parchment/40 font-medium">Role</th>
              <th className="text-left py-3 px-4 text-parchment/40 font-medium">Joined</th>
              <th className="text-left py-3 px-4 text-parchment/40 font-medium">
                <button
                  type="button"
                  onClick={() => setSortDir((d) => (d === "desc" ? "asc" : "desc"))}
                  className="inline-flex items-center gap-1 hover:text-parchment/70"
                >
                  Last sign-in
                  <span className="text-[10px]">{sortDir === "desc" ? "▼" : "▲"}</span>
                </button>
              </th>
              <th className="text-left py-3 px-4 text-parchment/40 font-medium">Segment</th>
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 && (
              <tr>
                <td colSpan={6} className="py-8 px-4 text-center text-sm text-parchment/40">
                  No users match the current filters.
                </td>
              </tr>
            )}
            {visible.map((row, i) => (
              <tr
                key={`${row.email}-${row.businessId ?? "none"}-${i}`}
                className="border-b border-parchment/5 hover:bg-parchment/3"
              >
                <td className="py-3 px-4 text-parchment">{row.email}</td>
                <td className="py-3 px-4">
                  {row.businessId ? (
                    <a
                      href={`/admin/${row.businessId}`}
                      className="text-parchment/70 hover:text-signal-teal"
                    >
                      {row.businessName ?? `${row.businessId.slice(0, 8)}…`}
                    </a>
                  ) : (
                    <span className="text-parchment/30">–</span>
                  )}
                </td>
                <td className="py-3 px-4">
                  <Badge variant={row.role === "owner" ? "success" : "neutral"}>{row.role}</Badge>
                </td>
                <td className="py-3 px-4 text-parchment/50 text-xs">
                  <LocalDateTime iso={row.createdAt} style="date" />
                </td>
                <td className="py-3 px-4 text-parchment/50 text-xs">
                  {row.lastSignInAt ? (
                    <LocalDateTime iso={row.lastSignInAt} style="date" />
                  ) : (
                    <span className="text-parchment/30">never</span>
                  )}
                </td>
                <td className="py-3 px-4">
                  <Badge variant={segmentBadgeVariant(row.segment)}>{row.segment}</Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
