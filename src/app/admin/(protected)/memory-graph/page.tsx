/**
 * /admin/memory-graph — the knowledge-graph rollout console.
 *
 * Two levels:
 *   Fleet: the default-mode toggle (what every 'inherit' tenant runs) and
 *     one row per tenant with its effective mode + window stats, linking
 *     into the per-tenant comparison.
 *   Per-tenant (?business=<id>): the at-a-glance graph-vs-memory verdict —
 *     a headline split over four buckets, stat tiles, and an event table
 *     whose rows expand to the full side-by-side (graph context vs ranked
 *     memory context vs the answer actually given).
 *
 * All reads are service-role behind the admin layout's requireAdmin gate.
 */

import Link from "next/link";
import { listBusinesses } from "@/lib/db/businesses";
import { getBusinessConfig } from "@/lib/db/configs";
import { getAdminPlatformSetting } from "@/lib/admin/platform-settings";
import {
  MEMORY_GRAPH_DEFAULT_MODE_KEY,
  MEMORY_GRAPH_FALLBACK_DEFAULT,
  resolveMemoryGraphMode
} from "@/lib/memory/graph-db";
import {
  KG_VERDICT_LABELS,
  aggregateKgStats,
  classifyKgVerdict,
  groupKgStatsByBusiness,
  kgVerdictHeadline,
  listKgRetrievalEvents,
  listKgRetrievalStatsRows,
  type KgStats,
  type KgVerdict
} from "@/lib/memory/kg-events";
import { Card } from "@/components/ui/Card";
import { MemoryGraphDefaultToggle } from "@/components/admin/MemoryGraphDefaultToggle";
import { LocalDateTime } from "@/components/dashboard/LocalDateTime";

export const dynamic = "force-dynamic";

const WINDOWS = { "24h": 1, "7d": 7, "30d": 30 } as const;
type WindowKey = keyof typeof WINDOWS;

const VERDICT_CHIP_CLASSES: Record<KgVerdict, string> = {
  graph_won: "bg-claw-green/20 text-claw-green",
  both: "bg-signal-teal/20 text-signal-teal",
  memory_only: "bg-parchment/10 text-parchment/70",
  neither: "bg-rose-500/15 text-rose-300"
};

function windowFrom(param: string | undefined): WindowKey {
  return param === "24h" || param === "30d" ? param : "7d";
}

function sinceIso(window: WindowKey): string {
  return new Date(Date.now() - WINDOWS[window] * 24 * 60 * 60 * 1000).toISOString();
}

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-parchment/10 bg-ink/40 px-4 py-3">
      <p className="text-xs text-parchment/40">{label}</p>
      <p className="text-lg font-semibold text-parchment">{value}</p>
    </div>
  );
}

function VerdictBar({ stats }: { stats: KgStats }) {
  const total = Math.max(stats.lookups, 1);
  const segments: Array<{ verdict: KgVerdict; className: string }> = [
    { verdict: "graph_won", className: "bg-claw-green/70" },
    { verdict: "both", className: "bg-signal-teal/70" },
    { verdict: "memory_only", className: "bg-parchment/30" },
    { verdict: "neither", className: "bg-rose-500/40" }
  ];
  return (
    <div>
      <div className="flex h-3 w-full overflow-hidden rounded-full border border-parchment/10">
        {segments.map(({ verdict, className }) => (
          <div
            key={verdict}
            className={className}
            style={{ width: `${(stats.verdicts[verdict] / total) * 100}%` }}
          />
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-parchment/60">
        {segments.map(({ verdict }) => (
          <span key={verdict}>
            <span className={`inline-block rounded px-1.5 py-0.5 ${VERDICT_CHIP_CLASSES[verdict]}`}>
              {KG_VERDICT_LABELS[verdict]}
            </span>{" "}
            {stats.verdicts[verdict]}
          </span>
        ))}
      </div>
    </div>
  );
}

export default async function MemoryGraphAdminPage({
  searchParams
}: {
  searchParams: Promise<{ business?: string; window?: string }>;
}) {
  const params = await searchParams;
  const window = windowFrom(params.window);
  const since = sinceIso(window);
  const selectedBusinessId = params.business ?? null;

  const [businesses, defaultSettingRaw, statsRows] = await Promise.all([
    listBusinesses(),
    getAdminPlatformSetting(MEMORY_GRAPH_DEFAULT_MODE_KEY).catch(() => null),
    listKgRetrievalStatsRows(since).catch(() => [])
  ]);
  const fleetDefault =
    defaultSettingRaw === "off" || defaultSettingRaw === "shadow" || defaultSettingRaw === "active"
      ? defaultSettingRaw
      : MEMORY_GRAPH_FALLBACK_DEFAULT;
  const statsByBusiness = groupKgStatsByBusiness(statsRows);
  const businessNames = new Map(businesses.map((b) => [b.id, b.name]));

  // Effective mode per tenant (config reads are cheap; the fleet is small).
  const modeRows = await Promise.all(
    businesses.map(async (b) => {
      const config = await getBusinessConfig(b.id).catch(() => null);
      const setting = config?.memory_graph_mode ?? "inherit";
      const effective = await resolveMemoryGraphMode(setting);
      return { id: b.id, name: b.name, setting, effective };
    })
  );

  // Per-tenant drill-down.
  const selected = selectedBusinessId
    ? await listKgRetrievalEvents(selectedBusinessId, since, 100).catch(() => [])
    : [];
  const selectedStats = aggregateKgStats(selected);

  const windowLink = (w: WindowKey) =>
    `/admin/memory-graph?window=${w}${selectedBusinessId ? `&business=${selectedBusinessId}` : ""}`;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-parchment">Memory graph</h1>
          <p className="text-sm text-parchment/50 mt-1">
            Rollout console: fleet default, per-tenant modes, and the graph-vs-memory comparison.
          </p>
        </div>
        <div className="flex gap-2 text-sm">
          {(Object.keys(WINDOWS) as WindowKey[]).map((w) => (
            <Link
              key={w}
              href={windowLink(w)}
              className={`rounded-lg border px-3 py-1.5 ${
                w === window
                  ? "border-claw-green text-claw-green"
                  : "border-parchment/20 text-parchment/60 hover:text-parchment"
              }`}
            >
              {w}
            </Link>
          ))}
        </div>
      </div>

      <Card>
        <h2 className="text-xs font-semibold text-parchment/40 uppercase tracking-wider mb-4">
          Fleet default
        </h2>
        <MemoryGraphDefaultToggle key={fleetDefault} initialDefault={fleetDefault} />
      </Card>

      <Card>
        <h2 className="text-xs font-semibold text-parchment/40 uppercase tracking-wider mb-4">
          Tenants ({window})
        </h2>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-parchment/40">
              <th className="pb-2 pr-4">Business</th>
              <th className="pb-2 pr-4">Mode</th>
              <th className="pb-2 pr-4">Lookups</th>
              <th className="pb-2 pr-4">Graph contributed</th>
              <th className="pb-2 pr-4">Graph only</th>
              <th className="pb-2" />
            </tr>
          </thead>
          <tbody>
            {modeRows.map((row) => {
              const stats = statsByBusiness.get(row.id);
              return (
                <tr key={row.id} className="border-t border-parchment/10 text-parchment/80">
                  <td className="py-2 pr-4">{row.name}</td>
                  <td className="py-2 pr-4">
                    {row.setting === "inherit" ? `inherit → ${row.effective}` : row.setting}
                  </td>
                  <td className="py-2 pr-4">{stats?.lookups ?? 0}</td>
                  <td className="py-2 pr-4">
                    {stats ? `${stats.graphContributionRate}%` : "—"}
                  </td>
                  <td className="py-2 pr-4">{stats ? `${stats.graphOnlyRate}%` : "—"}</td>
                  <td className="py-2 text-right">
                    <Link
                      href={`/admin/memory-graph?window=${window}&business=${row.id}`}
                      className="text-claw-green underline underline-offset-2"
                    >
                      Compare
                    </Link>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>

      {selectedBusinessId && (
        <Card>
          <h2 className="text-xs font-semibold text-parchment/40 uppercase tracking-wider mb-1">
            Comparison — {businessNames.get(selectedBusinessId) ?? selectedBusinessId} ({window})
          </h2>
          <p className="text-sm text-parchment mb-4">{kgVerdictHeadline(selectedStats)}</p>

          <VerdictBar stats={selectedStats} />

          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <StatTile label="Lookups" value={String(selectedStats.lookups)} />
            <StatTile label="Graph contributed" value={`${selectedStats.graphContributionRate}%`} />
            <StatTile label="Graph only" value={`${selectedStats.graphOnlyRate}%`} />
            <StatTile label="Avg graph chars" value={String(selectedStats.avgGraphChars)} />
            <StatTile label="Avg memory chars" value={String(selectedStats.avgMemoryChars)} />
            <StatTile label="Memory fallback" value={`${selectedStats.memoryFallbackRate}%`} />
          </div>

          <div className="mt-6 space-y-2">
            {selected.length === 0 && (
              <p className="text-sm text-parchment/50">
                No lookup events in this window. Events record on every knowledge lookup while the
                tenant is in shadow or active mode.
              </p>
            )}
            {selected.map((event) => {
              const verdict = classifyKgVerdict(event);
              return (
                <details
                  key={event.id}
                  className="rounded-lg border border-parchment/10 bg-ink/40 px-4 py-3"
                >
                  <summary className="flex cursor-pointer select-none flex-wrap items-center gap-3 text-sm">
                    <span
                      className={`rounded px-1.5 py-0.5 text-xs ${VERDICT_CHIP_CLASSES[verdict]}`}
                    >
                      {KG_VERDICT_LABELS[verdict]}
                    </span>
                    <span className="flex-1 truncate text-parchment/80">{event.question}</span>
                    <span className="text-xs text-parchment/40">
                      {event.mode} · {event.graph_facts} facts · {event.graph_context_chars}/
                      {event.memory_context_chars}ch ·{" "}
                      <LocalDateTime iso={event.created_at} />
                    </span>
                  </summary>
                  <div className="mt-3 grid gap-3 lg:grid-cols-2">
                    <div>
                      <p className="text-xs font-semibold text-parchment/40 uppercase mb-1">
                        Graph context ({event.graph_matched_entities} entities,{" "}
                        {event.graph_facts} facts)
                      </p>
                      <pre className="whitespace-pre-wrap rounded border border-parchment/10 bg-ink/60 p-2 text-xs text-parchment/70">
                        {event.graph_context || "(empty — no entity matched this question)"}
                      </pre>
                    </div>
                    <div>
                      <p className="text-xs font-semibold text-parchment/40 uppercase mb-1">
                        Ranked memory ({event.memory_selected} blocks
                        {event.memory_fallback ? ", fallback" : ""})
                      </p>
                      <pre className="whitespace-pre-wrap rounded border border-parchment/10 bg-ink/60 p-2 text-xs text-parchment/70">
                        {event.memory_context || "(empty)"}
                      </pre>
                    </div>
                  </div>
                  <p className="mt-3 text-xs font-semibold text-parchment/40 uppercase mb-1">
                    Answer given
                  </p>
                  <p className="text-sm text-parchment/80">{event.answer}</p>
                </details>
              );
            })}
          </div>
        </Card>
      )}
    </div>
  );
}
