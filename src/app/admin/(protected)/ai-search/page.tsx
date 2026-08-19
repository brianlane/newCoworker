/**
 * /admin/ai-search, is the AI search work landing?
 *
 * Two questions, one page. Are the assistants READING us (crawler hits, and
 * which operators are missing)? Are they CITING us (humans arriving from
 * chatgpt.com, perplexity.ai, and friends)? Everything else in the AEO work
 * is unfalsifiable without this.
 *
 * Service-role reads behind the admin layout's requireAdmin gate.
 */

import { AlertTriangle } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { OBSERVABLE_AI_OPERATORS } from "@/lib/marketing/ai-crawlers";
import {
  AI_TRAFFIC_RETENTION_DAYS,
  listAiTrafficRows,
  summarizeAiTraffic,
  type AiTrafficDay
} from "@/lib/marketing/ai-traffic";

export const dynamic = "force-dynamic";

const WINDOWS = { "7d": 7, "30d": 30, "90d": 90 } as const;
type WindowKey = keyof typeof WINDOWS;

const ROW_LIMIT = 5000;

function windowFrom(param: string | undefined): WindowKey {
  return param === "7d" || param === "90d" ? param : "30d";
}

function StatTile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-parchment/10 bg-ink/40 px-4 py-3">
      <p className="text-xs text-parchment/40">{label}</p>
      <p className="text-lg font-semibold text-parchment">{value}</p>
      {hint && <p className="mt-1 text-xs text-parchment/40">{hint}</p>}
    </div>
  );
}

/**
 * One row of daily columns for a single series.
 *
 * The two series get their OWN charts and their own peak. Crawler hits and
 * referrals answer different questions and their magnitudes differ by orders
 * of magnitude, so a shared scale would flatten referrals to invisible on
 * days that actually mattered. The cost is that bar heights are not
 * comparable BETWEEN charts, which the per-chart peak label makes explicit.
 */
function TrendRow({
  days,
  values,
  barClass,
  label,
  noun
}: {
  days: AiTrafficDay[];
  values: (day: AiTrafficDay) => number;
  barClass: string;
  label: string;
  noun: string;
}) {
  const peak = Math.max(1, ...days.map(values));
  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 text-xs">
        <span className="text-parchment/60">
          <span className={`mr-1.5 inline-block h-2 w-2 rounded-sm ${barClass}`} />
          {label}
        </span>
        <span className="text-parchment/30">peak {peak}/day</span>
      </div>
      <div className="mobile-scroll-x mt-1 overflow-x-auto">
        <div className="flex min-w-full items-end gap-1" style={{ height: "72px" }}>
          {days.map((day) => {
            const value = values(day);
            return (
              <div
                key={day.day}
                className={`min-w-[6px] flex-1 rounded-t ${barClass}`}
                // A non-zero day always shows at least a sliver, so "some"
                // never renders identically to "none".
                style={{ height: value === 0 ? "1px" : `${Math.max(4, (value / peak) * 100)}%` }}
                title={`${day.day}: ${value} ${noun}`}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}

function TrendChart({ days }: { days: AiTrafficDay[] }) {
  return (
    <div className="space-y-5">
      <TrendRow
        days={days}
        values={(d) => d.crawler}
        barClass="bg-claw-green/60"
        label="Crawler hits"
        noun="crawler hit(s)"
      />
      <TrendRow
        days={days}
        values={(d) => d.referral}
        barClass="bg-signal-teal/70"
        label="AI referrals"
        noun="referral(s)"
      />
      <p className="text-xs text-parchment/30">
        {days[0]?.day} to {days[days.length - 1]?.day}. Each chart is scaled to its own peak, so
        heights compare within a chart, not between the two.
      </p>
    </div>
  );
}

export default async function AiSearchPage({
  searchParams
}: {
  searchParams: Promise<{ window?: string }>;
}) {
  const params = await searchParams;
  const window = windowFrom(params.window);
  const now = new Date();
  const since = new Date(now.getTime() - WINDOWS[window] * 24 * 60 * 60 * 1000).toISOString();

  const rows = await listAiTrafficRows(since, ROW_LIMIT);
  const truncated = rows.length >= ROW_LIMIT;
  const summary = summarizeAiTraffic(rows, since, now);

  // The useful reading is the absence: an operator with zero hits is either
  // uninterested or blocked at the edge. Only operators we could actually
  // observe count, so a robots-only control token (Google-Extended) is never
  // reported as a crawler that failed to show up.
  //
  // A truncated sample cannot support the claim at all: `summary` sees only
  // the newest ROW_LIMIT rows, so an operator that crawled earlier in the
  // window would read as missing and raise an edge-block alarm that is not
  // happening. Say the check is unavailable instead of guessing.
  const seen = new Set(summary.crawlerOperators);
  const missing = truncated ? [] : OBSERVABLE_AI_OPERATORS.filter((op) => !seen.has(op));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-parchment">AI search visibility</h1>
          <p className="mt-1 text-sm text-parchment/50">
            Whether the assistants are reading newcoworker.com, and whether they are sending
            anyone. Events are kept {AI_TRAFFIC_RETENTION_DAYS} days.
          </p>
        </div>
        <div className="flex gap-2">
          {(Object.keys(WINDOWS) as WindowKey[]).map((key) => (
            <a
              key={key}
              href={`/admin/ai-search?window=${key}`}
              className={`rounded px-3 py-1.5 text-sm ${
                key === window
                  ? "bg-claw-green/20 text-claw-green"
                  : "bg-parchment/5 text-parchment/60 hover:bg-parchment/10"
              }`}
            >
              {key}
            </a>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile
          label="Crawler hits"
          value={summary.crawlerHits.toLocaleString("en-US")}
          hint="AI agents fetching pages"
        />
        <StatTile
          label="AI referrals"
          value={summary.referrals.toLocaleString("en-US")}
          hint="People arriving from an AI answer"
        />
        <StatTile
          label="Operators seen"
          value={`${summary.crawlerOperators.length}`}
          hint={summary.crawlerOperators.join(", ") || "none yet"}
        />
        <StatTile label="Window" value={window} hint={`since ${since.slice(0, 10)}`} />
      </div>

      {truncated && (
        <Card>
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
            <div>
              <p className="text-sm font-semibold text-parchment">
                Window truncated at {ROW_LIMIT.toLocaleString("en-US")} events
              </p>
              <p className="mt-1 text-xs text-parchment/50">
                Counts and rankings cover the most recent events only, and the
                missing-operator check is suppressed: an operator that crawled earlier in this
                window would look absent and raise a false edge-block alarm. Pick a shorter
                window for an exact read.
              </p>
            </div>
          </div>
        </Card>
      )}

      {missing.length > 0 && (
        <Card>
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
            <div>
              <p className="text-sm font-semibold text-parchment">
                No hits from: {missing.join(", ")}
              </p>
              <p className="mt-1 text-xs text-parchment/50">
                Either they have not found a reason to read us, or the edge is turning them away.
                Rule out the second with{" "}
                <code className="rounded bg-parchment/10 px-1">tsx debug/aeo-crawler-probe.ts</code>
                , then check Cloudflare Security &rarr; Events for the zone. Silence here is the
                only symptom a blocked crawler produces.
              </p>
            </div>
          </div>
        </Card>
      )}

      <Card>
        <h2 className="mb-4 text-sm font-semibold text-parchment/70 uppercase tracking-wider">
          By day
        </h2>
        {summary.crawlerHits + summary.referrals === 0 ? (
          <p className="text-sm text-parchment/50">
            Nothing recorded in this window yet. Crawler hits normally appear first; referrals
            follow once an assistant starts citing us in answers.
          </p>
        ) : (
          <TrendChart days={summary.byDay} />
        )}
      </Card>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card>
          <h2 className="mb-4 text-sm font-semibold text-parchment/70 uppercase tracking-wider">
            Top sources
          </h2>
          {summary.topSources.length === 0 ? (
            <p className="text-sm text-parchment/50">No sources yet.</p>
          ) : (
            <ul className="space-y-2">
              {summary.topSources.map((source) => (
                <li key={source.source} className="flex items-center justify-between text-sm">
                  <span className="text-parchment/70">
                    {source.source}
                    <span
                      className={`ml-2 rounded px-1.5 py-0.5 text-xs ${
                        source.kind === "crawler"
                          ? "bg-claw-green/20 text-claw-green"
                          : "bg-signal-teal/20 text-signal-teal"
                      }`}
                    >
                      {source.kind}
                    </span>
                  </span>
                  <span className="font-semibold text-parchment">
                    {source.count.toLocaleString("en-US")}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <h2 className="mb-4 text-sm font-semibold text-parchment/70 uppercase tracking-wider">
            Most read pages
          </h2>
          {summary.topPaths.length === 0 ? (
            <p className="text-sm text-parchment/50">No pages yet.</p>
          ) : (
            <ul className="space-y-2">
              {summary.topPaths.map((entry) => (
                <li key={entry.path} className="flex items-center justify-between gap-3 text-sm">
                  <span className="truncate text-parchment/70">{entry.path}</span>
                  <span className="shrink-0 font-semibold text-parchment">
                    {entry.count.toLocaleString("en-US")}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
