"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/Badge";
import { StatusDot } from "@/components/ui/StatusDot";
import { Button } from "@/components/ui/Button";
import { DeployButton } from "@/components/dashboard/DeployButton";
import { LocalDateTime } from "@/components/dashboard/LocalDateTime";

export type ClientRow = {
  id: string;
  name: string;
  ownerEmail: string;
  tier: string;
  createdAt: string;
  status: string;
  isPaused: boolean;
  subscriptionStatus: string | null;
};

type BatchAction = "pause" | "resume" | "redeploy";

/**
 * Admin clients table with BizBlasts-style batch actions: select rows, then
 * pause/resume (kill switch) or redeploy them in one pass. Actions run
 * sequentially per business (each is an existing single-tenant endpoint) and
 * report per-row failures instead of aborting the whole batch.
 */
export function ClientsBatchTable({ rows }: { rows: ClientRow[] }) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [running, setRunning] = useState<BatchAction | null>(null);
  const [report, setReport] = useState<string | null>(null);

  const allSelected = selected.size === rows.length && rows.length > 0;

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.id)));
  }

  const selectedRows = useMemo(() => rows.filter((r) => selected.has(r.id)), [rows, selected]);

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
          // Match the single-row DeployButton semantics: provisioning is
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
    if (skipped > 0) parts.push(`${skipped} skipped (already in that state)`);
    if (failures.length > 0) parts.push(`failed: ${failures.join("; ")}`);
    setReport(parts.join(" · "));
    setRunning(null);
    setSelected(new Set());
    router.refresh();
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 px-4 py-2 border-b border-parchment/10">
        <span className="text-xs text-parchment/40">
          {selected.size} selected
        </span>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={selected.size === 0 || running !== null}
          loading={running === "pause"}
          onClick={() => void runBatch("pause")}
        >
          Pause selected
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={selected.size === 0 || running !== null}
          loading={running === "resume"}
          onClick={() => void runBatch("resume")}
        >
          Resume selected
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={selected.size === 0 || running !== null}
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
                  aria-label="Select all businesses"
                  className="accent-signal-teal"
                />
              </th>
              <th className="text-left py-3 px-4 text-parchment/40 font-medium">Business</th>
              <th className="text-left py-3 px-4 text-parchment/40 font-medium">Owner</th>
              <th className="text-left py-3 px-4 text-parchment/40 font-medium">Plan</th>
              <th className="text-left py-3 px-4 text-parchment/40 font-medium">Payment</th>
              <th className="text-left py-3 px-4 text-parchment/40 font-medium">Status</th>
              <th className="text-left py-3 px-4 text-parchment/40 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((b) => (
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
                <td className="py-3 px-4 text-parchment/70">{b.ownerEmail}</td>
                <td className="py-3 px-4">
                  <Badge variant={b.tier === "standard" ? "online" : "neutral"}>{b.tier}</Badge>
                </td>
                <td className="py-3 px-4">
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
                <td className="py-3 px-4">
                  <div className="flex items-center gap-2">
                    <StatusDot
                      status={b.status as "online" | "offline" | "high_load"}
                      showLabel
                    />
                    {b.isPaused && <Badge variant="error">paused</Badge>}
                  </div>
                </td>
                <td className="py-3 px-4">
                  <div className="flex items-center gap-2">
                    <a href={`/admin/${b.id}`} className="text-xs text-signal-teal hover:underline">
                      Details
                    </a>
                    {b.status === "offline" && <DeployButton businessId={b.id} />}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
