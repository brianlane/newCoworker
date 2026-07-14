"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/Badge";
import { StatusDot } from "@/components/ui/StatusDot";
import { Button } from "@/components/ui/Button";
import { ViewAsButton } from "@/components/admin/ViewAsButton";
import { LocalDateTime } from "@/components/dashboard/LocalDateTime";
import {
  clientsCsv,
  filterClientRows,
  sortClientRows,
  EMPTY_CLIENTS_FILTERS,
  PAYMENT_NONE,
  type AdminClientRow,
  type ClientsFilters,
  type ClientsSortDir,
  type ClientsSortKey
} from "@/lib/admin/clients-table";

export type ClientRow = AdminClientRow;

type BatchAction = "pause" | "resume" | "redeploy";

const TIER_OPTIONS = ["starter", "standard", "enterprise"];

function SortHeader({
  label,
  sortKey,
  sort,
  onSort
}: {
  label: string;
  sortKey: ClientsSortKey;
  sort: { key: ClientsSortKey; dir: ClientsSortDir } | null;
  onSort: (key: ClientsSortKey) => void;
}) {
  const active = sort?.key === sortKey;
  return (
    <th className="text-left py-3 px-4 text-parchment/40 font-medium">
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={`inline-flex items-center gap-1 hover:text-parchment/70 ${
          active ? "text-parchment/80" : ""
        }`}
      >
        {label}
        <span className="text-[10px]">{active ? (sort.dir === "asc" ? "▲" : "▼") : ""}</span>
      </button>
    </th>
  );
}

/**
 * Admin clients table with BizBlasts-style index affordances: text search,
 * tier / VPS-status / payment filters, sortable columns, one-click CSV
 * export of the visible rows, and batch actions (select rows, then
 * pause/resume or redeploy them in one pass). Batch actions run sequentially
 * per business (each is an existing single-tenant endpoint) and report
 * per-row failures instead of aborting the whole batch.
 */
export function ClientsBatchTable({ rows }: { rows: ClientRow[] }) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [running, setRunning] = useState<BatchAction | null>(null);
  const [report, setReport] = useState<string | null>(null);
  const [filters, setFilters] = useState<ClientsFilters>(EMPTY_CLIENTS_FILTERS);
  const [sort, setSort] = useState<{ key: ClientsSortKey; dir: ClientsSortDir } | null>(null);

  const visibleRows = useMemo(() => {
    const filtered = filterClientRows(rows, filters);
    return sort ? sortClientRows(filtered, sort.key, sort.dir) : filtered;
  }, [rows, filters, sort]);

  const statusOptions = useMemo(
    () => [...new Set(rows.map((r) => r.status))].sort(),
    [rows]
  );
  const paymentOptions = useMemo(
    () => [...new Set(rows.map((r) => r.subscriptionStatus ?? PAYMENT_NONE))].sort(),
    [rows]
  );

  const allSelected =
    visibleRows.length > 0 && visibleRows.every((r) => selected.has(r.id));

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(visibleRows.map((r) => r.id)));
  }

  function toggleSort(key: ClientsSortKey) {
    setSort((prev) => {
      if (!prev || prev.key !== key) return { key, dir: "asc" };
      if (prev.dir === "asc") return { key, dir: "desc" };
      return null;
    });
  }

  function exportCsv() {
    const blob = new Blob([clientsCsv(visibleRows)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `clients-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // Batch actions act on the visible selection ONLY: a row selected and then
  // hidden by a filter must never receive a kill-switch / redeploy call the
  // operator can't see happening.
  const selectedRows = useMemo(
    () => visibleRows.filter((r) => selected.has(r.id)),
    [visibleRows, selected]
  );

  async function runBatch(action: BatchAction) {
    if (selectedRows.length === 0) return;
    if (
      action === "redeploy" &&
      !window.confirm(
        `Redeploy ${selectedRows.length} business(es)? This re-runs provisioning per tenant and can take minutes each.`
      )
    ) {
      return;
    }
    setRunning(action);
    setReport(null);
    let ok = 0;
    let skipped = 0;
    const failures: string[] = [];
    for (const row of selectedRows) {
      try {
        if (action === "redeploy") {
          // Match the detail-page DeployButton semantics: provisioning is
          // only offered for offline boxes; skip the rest instead of
          // re-running a live tenant's provisioning by accident.
          if (row.status !== "offline") {
            skipped++;
            continue;
          }
          const res = await fetch("/api/provisioning", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ businessId: row.id })
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
        } else {
          const paused = action === "pause";
          if (row.isPaused === paused) {
            skipped++;
            continue;
          }
          const res = await fetch("/api/business/kill-switch", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ businessId: row.id, paused })
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
        }
        ok++;
      } catch (err) {
        failures.push(`${row.name}: ${err instanceof Error ? err.message : "failed"}`);
      }
    }
    const parts = [`${ok} ${action === "redeploy" ? "redeployed" : `${action}d`}`];
    if (skipped > 0) {
      parts.push(
        action === "redeploy"
          ? `${skipped} skipped (not offline)`
          : `${skipped} skipped (already in that state)`
      );
    }
    if (failures.length > 0) parts.push(`failed: ${failures.join("; ")}`);
    setReport(parts.join(" · "));
    setRunning(null);
    setSelected(new Set());
    router.refresh();
  }

  return (
    <div>
      {/* Search + filters + export */}
      <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-b border-parchment/10">
        <input
          type="search"
          value={filters.search}
          onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value }))}
          placeholder="Search name or owner email…"
          aria-label="Search clients"
          className="w-56 rounded-md border border-parchment/20 bg-deep-ink px-2.5 py-1.5 text-xs text-parchment placeholder:text-parchment/30 focus:outline-none focus:ring-1 focus:ring-signal-teal"
        />
        <select
          value={filters.tier ?? ""}
          onChange={(e) => setFilters((f) => ({ ...f, tier: e.target.value || null }))}
          aria-label="Filter by plan"
          className="rounded-md border border-parchment/20 bg-deep-ink px-2 py-1.5 text-xs text-parchment/80 focus:outline-none focus:ring-1 focus:ring-signal-teal"
        >
          <option value="">All plans</option>
          {TIER_OPTIONS.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <select
          value={filters.status ?? ""}
          onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value || null }))}
          aria-label="Filter by VPS status"
          className="rounded-md border border-parchment/20 bg-deep-ink px-2 py-1.5 text-xs text-parchment/80 focus:outline-none focus:ring-1 focus:ring-signal-teal"
        >
          <option value="">All statuses</option>
          {statusOptions.map((s) => (
            <option key={s} value={s}>
              {s.replaceAll("_", " ")}
            </option>
          ))}
        </select>
        <select
          value={filters.payment ?? ""}
          onChange={(e) => setFilters((f) => ({ ...f, payment: e.target.value || null }))}
          aria-label="Filter by payment status"
          className="rounded-md border border-parchment/20 bg-deep-ink px-2 py-1.5 text-xs text-parchment/80 focus:outline-none focus:ring-1 focus:ring-signal-teal"
        >
          <option value="">All payments</option>
          {paymentOptions.map((p) => (
            <option key={p} value={p}>
              {p.replaceAll("_", " ")}
            </option>
          ))}
        </select>
        <span className="text-xs text-parchment/40">
          {visibleRows.length} of {rows.length}
        </span>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="ml-auto"
          onClick={exportCsv}
          disabled={visibleRows.length === 0}
        >
          Export CSV
        </Button>
      </div>

      {/* Batch actions */}
      <div className="flex flex-wrap items-center gap-2 px-4 py-2 border-b border-parchment/10">
        <span className="text-xs text-parchment/40">
          {selectedRows.length} selected
        </span>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={selectedRows.length === 0 || running !== null}
          loading={running === "pause"}
          onClick={() => void runBatch("pause")}
        >
          Pause selected
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={selectedRows.length === 0 || running !== null}
          loading={running === "resume"}
          onClick={() => void runBatch("resume")}
        >
          Resume selected
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={selectedRows.length === 0 || running !== null}
          loading={running === "redeploy"}
          onClick={() => void runBatch("redeploy")}
        >
          Redeploy selected (offline only)
        </Button>
        {report && <span className="text-xs text-parchment/60">{report}</span>}
      </div>
      <div className="mobile-scroll-x">
        <table className="w-full min-w-[700px] text-sm">
          <thead>
            <tr className="border-b border-parchment/10">
              <th className="py-3 px-4">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={toggleAll}
                  aria-label="Select all visible businesses"
                  className="accent-signal-teal"
                />
              </th>
              <SortHeader label="Business" sortKey="name" sort={sort} onSort={toggleSort} />
              <th className="text-left py-3 px-4 text-parchment/40 font-medium">Owner</th>
              <SortHeader label="Plan" sortKey="tier" sort={sort} onSort={toggleSort} />
              <SortHeader label="Payment" sortKey="payment" sort={sort} onSort={toggleSort} />
              <SortHeader label="Margin/mo" sortKey="margin" sort={sort} onSort={toggleSort} />
              <SortHeader label="Status" sortKey="status" sort={sort} onSort={toggleSort} />
              <th className="text-left py-3 px-4 text-parchment/40 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {visibleRows.length === 0 && (
              <tr>
                <td colSpan={8} className="py-8 px-4 text-center text-sm text-parchment/40">
                  No clients match the current filters.
                </td>
              </tr>
            )}
            {visibleRows.map((b) => (
              <tr key={b.id} className="border-b border-parchment/5 hover:bg-parchment/3">
                <td className="py-3 px-4">
                  <input
                    type="checkbox"
                    checked={selected.has(b.id)}
                    onChange={() => toggle(b.id)}
                    aria-label={`Select ${b.name}`}
                    className="accent-signal-teal"
                  />
                </td>
                <td className="py-3 px-4">
                  <a href={`/admin/${b.id}`} className="text-parchment font-medium hover:text-signal-teal">
                    {b.name}
                  </a>
                  <p className="text-xs text-parchment/30 mt-0.5">
                    <LocalDateTime iso={b.createdAt} style="date" />
                  </p>
                </td>
                <td className="py-3 px-4 text-parchment/70">
                  <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="break-all">{b.ownerEmail}</span>
                    {b.ownerQuiet && (
                      <span title="Owner hasn't signed in for 90+ days">
                        <Badge variant="error" className="text-[10px]">
                          churn risk
                        </Badge>
                      </span>
                    )}
                  </span>
                </td>
                <td className="py-3 px-4 whitespace-nowrap">
                  <Badge variant={b.tier === "standard" ? "online" : "neutral"}>{b.tier}</Badge>
                </td>
                <td className="py-3 px-4 whitespace-nowrap">
                  {!b.subscriptionStatus ? (
                    <Badge variant="neutral">no subscription</Badge>
                  ) : (
                    <Badge
                      variant={
                        b.subscriptionStatus === "active"
                          ? "success"
                          : b.subscriptionStatus === "past_due"
                            ? "error"
                            : "pending"
                      }
                    >
                      {b.subscriptionStatus}
                    </Badge>
                  )}
                </td>
                <td className="py-3 px-4 whitespace-nowrap">
                  {b.marginCents === null ? (
                    <span className="text-xs text-parchment/30">—</span>
                  ) : (
                    <span
                      className={`text-xs font-semibold ${
                        b.marginCents >= 0 ? "text-claw-green" : "text-spark-orange"
                      }`}
                    >
                      {b.marginCents < 0 ? "−" : ""}$
                      {Math.abs(b.marginCents / 100).toLocaleString("en-US", {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2
                      })}
                    </span>
                  )}
                </td>
                <td className="py-3 px-4 whitespace-nowrap">
                  <div className="flex items-center gap-2">
                    <StatusDot
                      status={b.status as "online" | "offline" | "high_load"}
                      showLabel
                    />
                    {b.isPaused && <Badge variant="error">paused</Badge>}
                  </div>
                </td>
                {/* No "Details" link — the business name is the navigation. */}
                <td className="py-3 px-4 whitespace-nowrap">
                  <ViewAsButton businessId={b.id} variant="link" />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
