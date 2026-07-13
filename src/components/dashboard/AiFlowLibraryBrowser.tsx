"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/Card";
import { TrendingUp, Building2, Download, Clock } from "lucide-react";
import type { AiFlowLibraryRow } from "@/lib/ai-flows/library";

function Stat({ icon, value, label }: { icon: React.ReactNode; value: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1 text-[11px] text-parchment/60" title={label}>
      <span className="text-parchment/40">{icon}</span>
      {value}
    </span>
  );
}

function runsPerDay(row: AiFlowLibraryRow): string {
  const perDay =
    typeof row.stats?.runsPerDay === "number"
      ? (row.stats.runsPerDay as number)
      : Math.round((row.runs_last_7d / 7) * 100) / 100;
  return `${perDay}/day`;
}

export function AiFlowLibraryBrowser({
  businessId,
  entries
}: {
  businessId: string | null;
  entries: AiFlowLibraryRow[];
}) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const categories = useMemo(
    () => [...new Set(entries.map((e) => e.category).filter((c): c is string => Boolean(c)))].sort(),
    [entries]
  );

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return entries.filter((e) => {
      if (category && e.category !== category) return false;
      if (!q) return true;
      return (
        e.title.toLowerCase().includes(q) ||
        e.summary.toLowerCase().includes(q) ||
        (e.category ?? "").toLowerCase().includes(q)
      );
    });
  }, [entries, query, category]);

  const use = async (row: AiFlowLibraryRow) => {
    if (!businessId) {
      setError("Provision your coworker first to use a library flow.");
      return;
    }
    setBusyId(row.id);
    setError(null);
    try {
      const res = await fetch(`/api/aiflows/library/${row.id}/use`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId })
      });
      const json = (await res.json()) as {
        ok: boolean;
        data?: { flowId: string };
        error?: { message: string };
      };
      if (!json.ok || !json.data) {
        setError(json.error?.message ?? "Could not use this flow");
        return;
      }
      router.push(`/dashboard/aiflows?edit=${json.data.flowId}`);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-4">
      {error && (
        <p className="rounded-md border border-spark-orange/40 bg-spark-orange/5 px-3 py-2 text-sm text-spark-orange">
          {error}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <input
          className="flex-1 rounded-md border border-parchment/15 bg-deep-ink/40 px-3 py-2 text-sm text-parchment placeholder:text-parchment/30 focus:border-signal-teal focus:outline-none"
          placeholder="Search the library…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {categories.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            <button
              onClick={() => setCategory(null)}
              className={`rounded-full px-2.5 py-1 text-xs ${
                category === null
                  ? "bg-signal-teal/20 text-signal-teal"
                  : "border border-parchment/15 text-parchment/60 hover:text-parchment"
              }`}
            >
              All
            </button>
            {categories.map((c) => (
              <button
                key={c}
                onClick={() => setCategory(c)}
                className={`rounded-full px-2.5 py-1 text-xs ${
                  category === c
                    ? "bg-signal-teal/20 text-signal-teal"
                    : "border border-parchment/15 text-parchment/60 hover:text-parchment"
                }`}
              >
                {c}
              </button>
            ))}
          </div>
        )}
      </div>

      {visible.length === 0 ? (
        <Card>
          <p className="py-6 text-center text-sm text-parchment/60">No flows match your search.</p>
        </Card>
      ) : (
        visible.map((row) => (
          <Card key={row.id} className="space-y-3">
            {/* Stacks on phones (full-width title, button below); the sm+
                layout is identical to the original single row. */}
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <Link
                    href={`/dashboard/aiflows/library/${row.template_key}`}
                    className="min-w-0 break-words font-semibold text-parchment hover:text-signal-teal hover:underline sm:truncate"
                  >
                    {row.title}
                  </Link>
                  {row.category && (
                    <span className="shrink-0 rounded-full border border-parchment/15 bg-deep-ink/40 px-2 py-0.5 text-[10px] text-parchment/60">
                      {row.category}
                    </span>
                  )}
                </div>
                <p className="mt-1 truncate text-xs text-parchment/50">{row.summary}</p>
              </div>
              <button
                onClick={() => use(row)}
                disabled={busyId === row.id}
                className="self-start rounded-md bg-signal-teal px-3 py-1.5 text-sm font-semibold text-deep-ink hover:bg-signal-teal/90 disabled:opacity-50 sm:shrink-0"
              >
                {busyId === row.id ? "Using…" : "Use this flow"}
              </button>
            </div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-parchment/10 pt-2">
              <Stat
                icon={<TrendingUp className="h-3.5 w-3.5" />}
                value={`${row.total_successful_runs.toLocaleString()} runs`}
                label="Total successful runs across all businesses"
              />
              <Stat
                icon={<Building2 className="h-3.5 w-3.5" />}
                value={`${row.businesses_using.toLocaleString()} businesses`}
                label="Businesses using this flow"
              />
              <Stat
                icon={<Download className="h-3.5 w-3.5" />}
                value={`${row.download_count.toLocaleString()} uses`}
                label="Times duplicated from the library"
              />
              <Stat
                icon={<TrendingUp className="h-3.5 w-3.5" />}
                value={runsPerDay(row)}
                label="Successful runs per day (last 7 days)"
              />
              {row.last_run_at && (
                <Stat
                  icon={<Clock className="h-3.5 w-3.5" />}
                  value={new Date(row.last_run_at).toLocaleDateString()}
                  label="Last successful run"
                />
              )}
            </div>
          </Card>
        ))
      )}
    </div>
  );
}
