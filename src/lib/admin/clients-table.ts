/**
 * Pure filter / sort / CSV logic behind the admin clients table
 * (src/components/admin/ClientsBatchTable.tsx) — the BizBlasts ActiveAdmin
 * index-page affordances (filter sidebar, sortable columns, one-click CSV
 * export) ported as client-side state over the already-fully-loaded rows.
 */

import { serializeCsv } from "@/lib/csv/csv";

export type AdminClientRow = {
  id: string;
  name: string;
  ownerEmail: string;
  tier: string;
  createdAt: string;
  status: string;
  isPaused: boolean;
  subscriptionStatus: string | null;
  /**
   * Owner hasn't signed in for 90+ days (the "quiet" band from
   * src/lib/admin/user-engagement.ts) — surfaced as a churn-risk badge.
   */
  ownerQuiet: boolean;
  /**
   * This month's margin from the engine (src/lib/admin/margin.ts); null
   * when the margin load failed (column renders as —).
   */
  marginCents: number | null;
  /**
   * Admin pin (businesses.admin_pinned): pinned rows always render at the
   * top of the table, surviving column sorts — see {@link pinRowsFirst}.
   */
  pinned: boolean;
};

/** Sentinel for "no subscription row" in the payment filter. */
export const PAYMENT_NONE = "none";

export type ClientsFilters = {
  /** Case-insensitive substring match against name + owner email. */
  search: string;
  tier: string | null;
  status: string | null;
  /** Subscription status, or {@link PAYMENT_NONE} for row-less businesses. */
  payment: string | null;
};

export const EMPTY_CLIENTS_FILTERS: ClientsFilters = {
  search: "",
  tier: null,
  status: null,
  payment: null
};

export function filterClientRows(
  rows: AdminClientRow[],
  filters: ClientsFilters
): AdminClientRow[] {
  const needle = filters.search.trim().toLowerCase();
  return rows.filter((row) => {
    if (
      needle &&
      !row.name.toLowerCase().includes(needle) &&
      !row.ownerEmail.toLowerCase().includes(needle)
    ) {
      return false;
    }
    if (filters.tier && row.tier !== filters.tier) return false;
    if (filters.status && row.status !== filters.status) return false;
    if (filters.payment) {
      const payment = row.subscriptionStatus ?? PAYMENT_NONE;
      if (payment !== filters.payment) return false;
    }
    return true;
  });
}

export type ClientsSortKey = "name" | "created" | "tier" | "payment" | "status" | "margin";
export type ClientsSortDir = "asc" | "desc";

function sortValue(row: AdminClientRow, key: ClientsSortKey): string | number {
  switch (key) {
    case "name":
      return row.name.toLowerCase();
    case "created": {
      const ms = Date.parse(row.createdAt);
      return Number.isFinite(ms) ? ms : 0;
    }
    case "tier":
      return row.tier;
    case "payment":
      return row.subscriptionStatus ?? "";
    case "status":
      return row.status;
    case "margin":
      // Unknown margins sort below every real number in ascending order.
      return row.marginCents ?? Number.MIN_SAFE_INTEGER;
  }
}

/** Stable, non-mutating sort of the (already filtered) rows. */
export function sortClientRows(
  rows: AdminClientRow[],
  key: ClientsSortKey,
  dir: ClientsSortDir
): AdminClientRow[] {
  const sign = dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av = sortValue(a, key);
    const bv = sortValue(b, key);
    if (av < bv) return -sign;
    if (av > bv) return sign;
    return 0;
  });
}

/**
 * Stable partition: pinned rows first, both groups keeping their relative
 * order. Applied AFTER filter + sort so pinned rows stay on top under any
 * column sort (filters can still hide them, which is intended).
 */
export function pinRowsFirst(rows: AdminClientRow[]): AdminClientRow[] {
  return [...rows.filter((r) => r.pinned), ...rows.filter((r) => !r.pinned)];
}

/** The visible rows as spreadsheet-ready CSV (header first). */
export function clientsCsv(rows: AdminClientRow[]): string {
  return serializeCsv([
    [
      "name",
      "owner_email",
      "tier",
      "payment",
      "status",
      "paused",
      "churn_risk",
      "margin_usd_per_month",
      "created_at",
      "id"
    ],
    ...rows.map((row) => [
      row.name,
      row.ownerEmail,
      row.tier,
      row.subscriptionStatus ?? PAYMENT_NONE,
      row.status,
      row.isPaused,
      row.ownerQuiet,
      row.marginCents !== null ? (row.marginCents / 100).toFixed(2) : "",
      row.createdAt,
      row.id
    ])
  ]);
}
