"use client";

/**
 * "Recent changes" for one AiFlow: what each past edit did, and a Restore
 * button that puts an earlier version back.
 *
 * The history has been recorded since PR #1446 but was reachable only by the
 * AI (the inline undo tool and MCP `restore_flow_version`). An owner editing
 * a flow in the builder had no visible way back, which makes every edit feel
 * like a one-way door: this panel is what makes trying a change safe.
 *
 * Collapsed by default and loaded on expand: the flow page already runs
 * several queries, and most visits are not looking for history.
 */
import { useState } from "react";
import { History, RotateCcw } from "lucide-react";
import type { FlowHistoryEntry } from "@/lib/ai-flows/version-history";

type Props = {
  businessId: string;
  flowId: string;
};

/** "Aug 18, 2026, 3:04 PM" in the reader's own locale and timezone. */
function formatWhen(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return at.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
}

export function AiFlowHistory({ businessId, flowId }: Props) {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<FlowHistoryEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyVersion, setBusyVersion] = useState<number | null>(null);
  const [confirming, setConfirming] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/aiflows/${flowId}/versions?businessId=${encodeURIComponent(businessId)}`,
        { cache: "no-store" }
      );
      const json = (await res.json()) as {
        ok: boolean;
        data?: { entries: FlowHistoryEntry[] };
        error?: { message: string };
      };
      if (json.ok && json.data) setEntries(json.data.entries);
      else setError(json.error?.message ?? "Could not load this automation's history.");
    } catch {
      setError("Could not load this automation's history.");
    } finally {
      setLoading(false);
    }
  };

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (next && entries === null) await load();
  };

  const restore = async (versionId: number) => {
    setBusyVersion(versionId);
    setError(null);
    try {
      const res = await fetch(`/api/aiflows/${flowId}/versions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId, versionId })
      });
      const json = (await res.json()) as { ok: boolean; error?: { message: string } };
      if (!json.ok) {
        setError(json.error?.message ?? "Could not restore that version.");
        return;
      }
      // The restore is itself an edit, so it adds a history row of its own.
      // Reload the whole page rather than the panel: the canvas above is now
      // showing a definition that is no longer live.
      window.location.reload();
    } catch {
      setError("Could not restore that version.");
    } finally {
      setBusyVersion(null);
      setConfirming(null);
    }
  };

  return (
    <div className="space-y-3">
      <button
        onClick={toggle}
        className="flex items-center gap-2 text-sm font-semibold text-parchment/80 hover:text-parchment"
        aria-expanded={open}
      >
        <History className="h-4 w-4" />
        Recent changes
        <span className="text-xs font-normal text-parchment/40">
          {open ? "hide" : "see what changed, and undo it"}
        </span>
      </button>

      {open && (
        <div className="space-y-3">
          {loading && <p className="text-xs text-parchment/50">Loading...</p>}
          {error && <p className="text-xs text-spark-orange">{error}</p>}
          {!loading && entries !== null && entries.length === 0 && (
            <p className="text-xs text-parchment/50">
              No changes recorded yet. From the next edit on, every version is kept here and can
              be put back.
            </p>
          )}
          {entries?.map((entry) => (
            <div
              key={entry.versionId}
              className="rounded-lg border border-parchment/10 bg-deep-ink/40 p-3"
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-parchment/80">
                    {entry.by}
                    {entry.actor ? (
                      <span className="font-normal text-parchment/50"> by {entry.actor}</span>
                    ) : null}
                  </p>
                  <p className="text-[11px] text-parchment/40">{formatWhen(entry.replacedAt)}</p>
                </div>
                {confirming === entry.versionId ? (
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => restore(entry.versionId)}
                      disabled={busyVersion !== null}
                      className="rounded-md bg-spark-orange/90 px-2 py-1 text-[11px] font-semibold text-deep-ink disabled:opacity-50"
                    >
                      {busyVersion === entry.versionId ? "Restoring..." : "Yes, put it back"}
                    </button>
                    <button
                      onClick={() => setConfirming(null)}
                      disabled={busyVersion !== null}
                      className="text-[11px] text-parchment/50 hover:text-parchment disabled:opacity-50"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => setConfirming(entry.versionId)}
                    className="flex shrink-0 items-center gap-1 text-[11px] text-signal-teal hover:underline"
                  >
                    <RotateCcw className="h-3 w-3" />
                    {entry.isMostRecent ? "Undo this change" : "Restore this version"}
                  </button>
                )}
              </div>

              {/* What the edit that replaced this snapshot did, so the owner
                  picks a version by what changed rather than by timestamp. */}
              {entry.changeSummary.length > 0 ? (
                <ul className="mt-2 space-y-1 border-t border-parchment/10 pt-2">
                  {entry.changeSummary.map((line, i) => (
                    <li key={i} className="text-[11px] leading-snug text-parchment/60">
                      {line}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-2 border-t border-parchment/10 pt-2 text-[11px] text-parchment/40">
                  The steps were not changed by this edit.
                </p>
              )}

              {confirming === entry.versionId && (
                <p className="mt-2 text-[11px] text-parchment/60">
                  This puts the steps back to how they were before that change. The on/off switch
                  stays as it is now, and this restore is itself recorded here, so it can be undone
                  too.
                </p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
