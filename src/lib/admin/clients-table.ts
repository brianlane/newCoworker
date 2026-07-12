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

export type ClientsSortKey = "name" | "created" | "tier" | "payment" | "status";
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

/** The visible rows as spreadsheet-ready CSV (header first). */
export function clientsCsv(rows: AdminClientRow[]): string {
  return serializeCsv([
    ["name", "owner_email", "tier", "payment", "status", "paused", "churn_risk", "created_at", "id"],
    ...rows.map((row) => [
      row.name,
      row.ownerEmail,
      row.tier,
      row.subscriptionStatus ?? PAYMENT_NONE,
      row.status,
      row.isPaused,
      row.ownerQuiet,
      row.createdAt,
      row.id
    ])
  ]);
}
