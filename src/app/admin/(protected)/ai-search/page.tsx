/**
 * /admin/ai-search — is the AI search work landing?
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
import { AI_CRAWLERS } from "@/lib/marketing/ai-crawlers";
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
 * Daily columns. Crawler and referral are stacked because they answer
 * different questions and their magnitudes differ by orders of magnitude:
 * a shared scale would flatten referrals into nothing.
 */
function TrendChart({ days }: { days: AiTrafficDay[] }) {
  const peak = Math.max(1, ...days.map((d) => Math.max(d.crawler, d.referral)));
  return (
    <div>
      <div className="mobile-scroll-x overflow-x-auto">
        <div className="flex min-w-full items-end gap-1" style={{ height: "120px" }}>
          {days.map((day) => (
            <div key={day.day} className="flex min-w-[8px] flex-1 flex-col justify-end gap-0.5">
              <div
                className="w-full rounded-t bg-signal-teal/70"
                style={{ height: `${(day.referral / peak) * 50}%` }}
                title={`${day.day}: ${day.referral} referral(s)`}
              />
              <div
                className="w-full rounded-t bg-claw-green/60"
                style={{ height: `${(day.crawler / peak) * 50}%` }}
                title={`${day.day}: ${day.crawler} crawler hit(s)`}
              />
            </div>
          ))}
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-xs text-parchment/50">
        <span>
          <span className="mr-1 inline-block h-2 w-2 rounded-sm bg-claw-green/60" />
          Crawler hits
          <span className="ml-4 mr-1 inline-block h-2 w-2 rounded-sm bg-signal-teal/70" />
          AI referrals
        </span>
        <span className="text-parchment/30">
          {days[0]?.day} to {days[days.length - 1]?.day} (peak {peak}/day)
        </span>
      </div>
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
  const summary = summarizeAiTraffic(rows, since, now);
  const truncated = rows.length >= ROW_LIMIT;

  // The useful reading is the absence: a registry entry with zero hits is
  // either uninterested or blocked at the edge.
  const seen = new Set(summary.crawlerOperators);
  const missing = [...new Set(AI_CRAWLERS.map((c) => c.operator))].filter((op) => !seen.has(op));

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
        {truncated && (
          <p className="mt-3 text-xs text-amber-200">
            Showing the most recent {ROW_LIMIT.toLocaleString("en-US")} events; earlier events in
            this window are not counted.
          </p>
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
