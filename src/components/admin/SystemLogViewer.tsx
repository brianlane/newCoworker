"use client";

import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/Badge";
import type { SystemLogLevel, SystemLogRow } from "@/lib/db/system-logs";

const LEVEL_ORDER: SystemLogLevel[] = ["debug", "info", "warn", "error"];

const LEVEL_BADGE: Record<SystemLogLevel, "neutral" | "pending" | "high_load" | "error"> = {
  debug: "neutral",
  info: "pending",
  warn: "high_load",
  error: "error"
};

const MIN_LEVEL_OPTIONS: { value: SystemLogLevel; label: string }[] = [
  { value: "debug", label: "All levels" },
  { value: "info", label: "Info +" },
  { value: "warn", label: "Warnings +" },
  { value: "error", label: "Errors only" }
];

const selectClasses =
  "rounded-lg border border-parchment/20 bg-deep-ink/50 px-2 py-1.5 text-xs text-parchment " +
  "focus:outline-none focus:ring-2 focus:ring-signal-teal focus:border-transparent";

/**
 * Admin-only filterable view over a business's `system_logs` rows. The server
 * page loads the latest batch; level/source/text filtering happens client-side
 * so flipping filters is instant (a page refresh re-fetches the batch).
 */
export function SystemLogViewer({ logs }: { logs: SystemLogRow[] }) {
  const [minLevel, setMinLevel] = useState<SystemLogLevel>("info");
  const [source, setSource] = useState<string>("all");
  const [search, setSearch] = useState("");

  const sources = useMemo(
    () => Array.from(new Set(logs.map((l) => l.source))).sort(),
    [logs]
  );

  const filtered = useMemo(() => {
    const minIdx = LEVEL_ORDER.indexOf(minLevel);
    const needle = search.trim().toLowerCase();
    return logs.filter((l) => {
      if (LEVEL_ORDER.indexOf(l.level) < minIdx) return false;
      if (source !== "all" && l.source !== source) return false;
      if (
        needle &&
        !l.event.toLowerCase().includes(needle) &&
        !l.message.toLowerCase().includes(needle)
      ) {
        return false;
      }
      return true;
    });
  }, [logs, minLevel, source, search]);

  const errorCount = logs.filter((l) => l.level === "error").length;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label="Minimum level"
          className={selectClasses}
          value={minLevel}
          onChange={(e) => setMinLevel(e.target.value as SystemLogLevel)}
        >
          {MIN_LEVEL_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <select
          aria-label="Source"
          className={selectClasses}
          value={source}
          onChange={(e) => setSource(e.target.value)}
        >
          <option value="all">All sources</option>
          {sources.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <input
          aria-label="Search logs"
          className={`${selectClasses} flex-1 min-w-[140px]`}
          placeholder="Search event / message…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <span className="text-xs text-parchment/40 ml-auto">
          {filtered.length} of {logs.length}
          {errorCount > 0 && (
            <span className="text-spark-orange"> · {errorCount} errors</span>
          )}
        </span>
      </div>

      {filtered.length === 0 ? (
        <p className="text-sm text-parchment/40 py-4 text-center">
          No log entries match the current filters.
        </p>
      ) : (
        <ul className="divide-y divide-parchment/10 max-h-[480px] overflow-y-auto pr-1">
          {filtered.map((log) => (
            <li key={log.id} className="py-2.5 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[11px] text-parchment/45 font-mono">
                  {new Date(log.created_at).toLocaleString()}
                </span>
                <Badge variant={LEVEL_BADGE[log.level]} className="text-[10px] uppercase">
                  {log.level}
                </Badge>
                <Badge variant="neutral" className="text-[10px]">
                  {log.source}
                </Badge>
                <span className="text-xs text-parchment/70 font-mono">{log.event}</span>
              </div>
              {log.message && log.message !== log.event && (
                <p className="text-xs text-parchment/85 whitespace-pre-wrap break-words">
                  {log.message}
                </p>
              )}
              {Object.keys(log.payload ?? {}).length > 0 && (
                <details className="text-xs">
                  <summary className="cursor-pointer text-parchment/35 hover:text-parchment/50">
                    Payload
                  </summary>
                  <pre className="mt-1 max-h-40 overflow-auto rounded-md bg-deep-ink/80 p-2 text-parchment/70 font-mono text-[10px]">
                    {JSON.stringify(log.payload, null, 2)}
                  </pre>
                </details>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
