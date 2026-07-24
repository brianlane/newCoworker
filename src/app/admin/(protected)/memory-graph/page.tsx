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
  effectiveMemoryGraphMode
} from "@/lib/memory/graph-db";
import {
  KG_KEEP_BORDERLINE_PCT,
  KG_KEEP_EARNING_PCT,
  KG_KEEP_LABELS,
  KG_KEEP_MIN_LOOKUPS,
  KG_VERDICT_LABELS,
  aggregateKgStats,
  classifyKgVerdict,
  countKgRetrievalEvents,
  countUnverifiedClaims,
  groupKgStatsByBusiness,
  isUnverifiedClaimLine,
  kgKeepVerdict,
  kgVerdictHeadline,
  listKgExtractionSpend,
  listKgRetrievalEvents,
  listKgRetrievalStatsRows,
  type KgKeepVerdict,
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

const KEEP_CHIP_CLASSES: Record<KgKeepVerdict, string> = {
  insufficient_data: "bg-parchment/10 text-parchment/60",
  earning: "bg-claw-green/20 text-claw-green",
  earning_on_claims: "bg-amber-400/15 text-amber-200",
  borderline: "bg-amber-400/15 text-amber-200",
  not_earning: "bg-rose-500/15 text-rose-300"
};

function windowFrom(param: string | undefined): WindowKey {
  return param === "24h" || param === "30d" ? param : "7d";
}

function sinceIso(window: WindowKey): string {
  return new Date(Date.now() - WINDOWS[window] * 24 * 60 * 60 * 1000).toISOString();
}

/** YYYY-MM-DD (UTC) for the spend roll-up, matching the events window. */
function sinceDay(window: WindowKey): string {
  return sinceIso(window).slice(0, 10);
}

function microsToMoney(micros: number): string {
  return `$${(micros / 1_000_000).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: micros > 0 && micros < 10_000 ? 4 : 2
  })}`;
}

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-parchment/10 bg-ink/40 px-4 py-3">
      <p className="text-xs text-parchment/40">{label}</p>
      <p className="text-lg font-semibold text-parchment">{value}</p>
    </div>
  );
}

function KeepChip({ verdict }: { verdict: KgKeepVerdict }) {
  return (
    <span className={`rounded px-1.5 py-0.5 text-xs whitespace-nowrap ${KEEP_CHIP_CLASSES[verdict]}`}>
      {KG_KEEP_LABELS[verdict]}
    </span>
  );
}

/**
 * "Earning its keep" banner: colored status chip + a 0-20% threshold bar
 * (amber band starts at 3%, green at 10%) with the tenant's graph-won
 * marker on it, the claim-reliance qualifier, and the standing reminder
 * that CORRECTNESS is only verifiable in the side-by-sides below.
 */
function KeepIndicator({ stats }: { stats: KgStats }) {
  const verdict = kgKeepVerdict(stats);
  const scaleMax = 20; // percent
  const markerPct = Math.min(stats.graphOnlyRate, scaleMax) / scaleMax;
  const explanation: Record<KgKeepVerdict, string> = {
    insufficient_data: `Verdict pending: ${stats.lookups}/${KG_KEEP_MIN_LOOKUPS} lookups recorded. The graph-won rate needs a real sample before it means anything.`,
    earning: `The graph was the ONLY relevant source on ${stats.graphOnlyRate}% of lookups: answers that would have been materially better with the graph active.`,
    earning_on_claims: `Graph-won rate is ${stats.graphOnlyRate}%, but ${stats.claimReliance}% of graph contributions lean on attributed unverified claims. Spot-check the side-by-sides before trusting the win rate.`,
    borderline: `Graph-won rate is ${stats.graphOnlyRate}%: some lookups only the graph could answer, but not yet a clear case for flipping active.`,
    not_earning: `Graph-won rate is ${stats.graphOnlyRate}% and memory-only dominates: markdown memory already covers this question mix.`
  };
  return (
    <div className="rounded-lg border border-parchment/10 bg-ink/40 px-4 py-3">
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-xs font-semibold text-parchment/40 uppercase tracking-wider">
          Earning its keep?
        </p>
        <KeepChip verdict={verdict} />
        {stats.claimReliance !== null && (
          <span className="text-xs text-parchment/50">
            claim reliance: {stats.claimReliance}% of graph contributions
          </span>
        )}
      </div>
      <div className="mt-3">
        <div className="relative h-3 w-full overflow-hidden rounded-full border border-parchment/10">
          {/* Threshold bands: red < 3% < amber < 10% < green (0-20% scale). */}
          <div
            className="absolute inset-y-0 left-0 bg-rose-500/25"
            style={{ width: `${(KG_KEEP_BORDERLINE_PCT / scaleMax) * 100}%` }}
          />
          <div
            className="absolute inset-y-0 bg-amber-400/20"
            style={{
              left: `${(KG_KEEP_BORDERLINE_PCT / scaleMax) * 100}%`,
              width: `${((KG_KEEP_EARNING_PCT - KG_KEEP_BORDERLINE_PCT) / scaleMax) * 100}%`
            }}
          />
          <div
            className="absolute inset-y-0 right-0 bg-claw-green/25"
            style={{ width: `${((scaleMax - KG_KEEP_EARNING_PCT) / scaleMax) * 100}%` }}
          />
          {/* The tenant's graph-won marker. */}
          <div
            className="absolute inset-y-0 w-1 rounded bg-parchment"
            style={{ left: `calc(${markerPct * 100}% - 2px)` }}
          />
        </div>
        <div className="mt-1 flex justify-between text-[10px] text-parchment/40">
          <span>0%</span>
          <span>{KG_KEEP_BORDERLINE_PCT}%</span>
          <span>{KG_KEEP_EARNING_PCT}%</span>
          <span>{scaleMax}%+ graph-won rate</span>
        </div>
      </div>
      <p className="mt-2 text-xs text-parchment/60">{explanation[verdict]}</p>
      <p className="mt-1 text-xs text-parchment/40">
        The chip automates quantity (win rate) and claim reliance; it cannot see whether a plain
        fact is WRONG. Spot-check the side-by-sides below: amber lines are attributed claims, and a
        customer-provided detail on a plain (un-flagged) line is the failure mode to hunt for.
      </p>
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

  const FLEET_STATS_LIMIT = 5000;
  const EVENTS_LIMIT = 500;

  const [businesses, defaultSettingRaw, statsRows, extractionSpend] = await Promise.all([
    listBusinesses(),
    getAdminPlatformSetting(MEMORY_GRAPH_DEFAULT_MODE_KEY).catch(() => null),
    listKgRetrievalStatsRows(since, FLEET_STATS_LIMIT).catch(() => []),
    listKgExtractionSpend(sinceDay(window)).catch(
      () => new Map<string, { calls: number; costMicros: number }>()
    )
  ]);
  const fleetSpend = [...extractionSpend.values()].reduce(
    (sum, s) => ({ calls: sum.calls + s.calls, costMicros: sum.costMicros + s.costMicros }),
    { calls: 0, costMicros: 0 }
  );
  const fleetDefault =
    defaultSettingRaw === "off" || defaultSettingRaw === "shadow" || defaultSettingRaw === "active"
      ? defaultSettingRaw
      : MEMORY_GRAPH_FALLBACK_DEFAULT;
  const fleetStatsTruncated = statsRows.length >= FLEET_STATS_LIMIT;
  const statsByBusiness = groupKgStatsByBusiness(statsRows);
  const businessNames = new Map(businesses.map((b) => [b.id, b.name]));

  // Effective mode per tenant, resolved against the SAME freshly-read
  // default the toggle shows — never the resolver's ~60s cache, so one page
  // render can't mix values (Bugbot #860).
  const modeRows = await Promise.all(
    businesses.map(async (b) => {
      const config = await getBusinessConfig(b.id).catch(() => null);
      const setting = config?.memory_graph_mode ?? "inherit";
      return { id: b.id, name: b.name, setting, effective: effectiveMemoryGraphMode(setting, fleetDefault) };
    })
  );

  // Per-tenant drill-down: stats over the newest EVENTS_LIMIT events, with
  // the true window count so truncation is labeled, never silent. The two
  // reads degrade TOGETHER: a failed list zeroes the total too, so a read
  // blip can never render "0 lookups" beside a banner claiming thousands.
  let selected: Awaited<ReturnType<typeof listKgRetrievalEvents>> = [];
  let selectedTotal = 0;
  if (selectedBusinessId) {
    try {
      selected = await listKgRetrievalEvents(selectedBusinessId, since, EVENTS_LIMIT);
      selectedTotal = await countKgRetrievalEvents(selectedBusinessId, since).catch(
        () => selected.length
      );
    } catch {
      selected = [];
      selectedTotal = 0;
    }
  }
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
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-xs font-semibold text-parchment/40 uppercase tracking-wider">
            Tenants ({window})
          </h2>
          <p className="text-xs text-parchment/50">
            Extraction spend this window:{" "}
            <span className="text-parchment">{microsToMoney(fleetSpend.costMicros)}</span> across{" "}
            <span className="text-parchment">{fleetSpend.calls}</span> Gemini calls (surface{" "}
            <code>memory_graph</code>, same ledger as /admin/gemini)
          </p>
        </div>
        {fleetStatsTruncated && (
          <p className="mb-3 text-xs text-amber-200/80">
            High volume: stats below cover the newest {statsRows.length.toLocaleString()} events
            fleet-wide in this window, not every lookup — open a tenant&apos;s comparison for its
            true counts.
          </p>
        )}
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-parchment/40">
              <th className="pb-2 pr-4">Business</th>
              <th className="pb-2 pr-4">Mode</th>
              <th className="pb-2 pr-4">Lookups</th>
              <th className="pb-2 pr-4">Graph only</th>
              <th className="pb-2 pr-4">Verdict</th>
              <th className="pb-2 pr-4">Extraction cost</th>
              <th className="pb-2" />
            </tr>
          </thead>
          <tbody>
            {modeRows.map((row) => {
              const stats = statsByBusiness.get(row.id);
              const spend = extractionSpend.get(row.id);
              return (
                <tr key={row.id} className="border-t border-parchment/10 text-parchment/80">
                  <td className="py-2 pr-4">{row.name}</td>
                  <td className="py-2 pr-4">
                    {row.setting === "inherit" ? `inherit → ${row.effective}` : row.setting}
                  </td>
                  <td className="py-2 pr-4">{stats?.lookups ?? 0}</td>
                  <td className="py-2 pr-4">{stats ? `${stats.graphOnlyRate}%` : "—"}</td>
                  <td className="py-2 pr-4">
                    <KeepChip
                      verdict={kgKeepVerdict(
                        stats ?? { lookups: 0, graphOnlyRate: 0, claimReliance: null }
                      )}
                    />
                  </td>
                  <td className="py-2 pr-4">
                    {spend ? `${microsToMoney(spend.costMicros)} (${spend.calls})` : "—"}
                  </td>
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
          <p className="text-sm text-parchment mb-1">{kgVerdictHeadline(selectedStats)}</p>
          {selectedTotal > selected.length && (
            <p className="text-xs text-amber-200/80 mb-3">
              Stats cover the newest {selected.length.toLocaleString()} of{" "}
              {selectedTotal.toLocaleString()} lookups in this window.
            </p>
          )}

          <div className="mb-4">
            <KeepIndicator stats={selectedStats} />
          </div>

          <VerdictBar stats={selectedStats} />

          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            <StatTile label="Lookups" value={String(selectedStats.lookups)} />
            <StatTile label="Graph contributed" value={`${selectedStats.graphContributionRate}%`} />
            <StatTile label="Graph only" value={`${selectedStats.graphOnlyRate}%`} />
            <StatTile label="Avg graph chars" value={String(selectedStats.avgGraphChars)} />
            <StatTile label="Avg memory chars" value={String(selectedStats.avgMemoryChars)} />
            <StatTile label="Memory fallback" value={`${selectedStats.memoryFallbackRate}%`} />
            <StatTile
              label="Avg graph retrieval"
              value={selectedStats.avgGraphMs === null ? "not measured" : `${selectedStats.avgGraphMs}ms`}
            />
            <StatTile
              label="Avg memory retrieval"
              value={
                selectedStats.avgMemoryMs === null ? "not measured" : `${selectedStats.avgMemoryMs}ms`
              }
            />
            <StatTile
              label="Extraction cost (window)"
              value={
                selectedBusinessId && extractionSpend.get(selectedBusinessId)
                  ? microsToMoney(extractionSpend.get(selectedBusinessId)!.costMicros)
                  : "$0.00"
              }
            />
            <StatTile
              label="Extraction calls (window)"
              value={String(
                (selectedBusinessId && extractionSpend.get(selectedBusinessId)?.calls) || 0
              )}
            />
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
              const claims = event.graph_claims ?? countUnverifiedClaims(event.graph_context);
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
                    {claims > 0 && (
                      <span className="rounded bg-amber-400/15 px-1.5 py-0.5 text-xs text-amber-200">
                        {claims} unverified claim{claims === 1 ? "" : "s"}
                      </span>
                    )}
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
                        {event.graph_facts} facts
                        {claims > 0 ? `, ${claims} attributed claims in amber` : ""})
                      </p>
                      {/* Line-by-line so attributed claims read amber at a
                          glance: a customer-provided detail on a NON-amber
                          line is the laundering failure mode to hunt for. */}
                      <pre className="whitespace-pre-wrap rounded border border-parchment/10 bg-ink/60 p-2 text-xs text-parchment/70">
                        {event.graph_context
                          ? event.graph_context.split("\n").map((line, i) => (
                              <span
                                key={i}
                                className={isUnverifiedClaimLine(line) ? "text-amber-200" : undefined}
                              >
                                {line}
                                {"\n"}
                              </span>
                            ))
                          : "(empty — no entity matched this question)"}
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
