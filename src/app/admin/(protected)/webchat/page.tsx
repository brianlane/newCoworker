/**
 * Admin sidebar Web chat view: visitor transcripts + spend/usage stats for
 * the PLATFORM'S OWN newcoworker.com chat widget.
 *
 * That widget runs on the direct-Gemini reply engine with no tenant
 * dashboard behind it, so this page is the only place its conversations
 * are reviewed. The backing business is resolved the same way the
 * marketing page embeds the widget — NEXT_PUBLIC_WEBCHAT_SITE_KEY →
 * chat_widget_settings by key hash — so rotating the key or re-pointing
 * it at another business keeps this view honest with zero config drift.
 *
 * Spend numbers come from two places, shown side by side:
 *   * per-turn stats persisted on webchat_jobs by the Gemini engine
 *     (cost_micros — the meter's own math), aggregated per session and in
 *     total here;
 *   * the business's shared AI-budget pool for the current period
 *     (owner_chat_model_spend), which also absorbs error-path turns the
 *     job table can't attribute.
 */

import Link from "next/link";
import { Card } from "@/components/ui/Card";
import { LocalDateTime } from "@/components/dashboard/LocalDateTime";
import { hashWebchatToken, parseWidgetKey } from "@/lib/webchat/keys";
import {
  getWidgetSettingsByKeyHash,
  listWebchatJobStatsForSessions,
  listWebchatSessionsForBusiness,
  type WebchatJobStatRow
} from "@/lib/webchat/db";
import { getBusiness } from "@/lib/db/businesses";
import { getChatSpendSnapshotForBusiness } from "@/lib/db/chat-usage";
import type { PlanTier } from "@/lib/plans/tier";
import {
  formatVisitorDevice,
  formatVisitorLocation,
  formatVisitorSource,
  parseVisitorMeta
} from "@/lib/webchat/visitor-meta";

export const dynamic = "force-dynamic";

/** Micro-USD → dollars, with enough precision for sub-cent turns. */
function usd(micros: number): string {
  const dollars = micros / 1_000_000;
  if (dollars === 0) return "$0";
  if (dollars < 0.01) return `$${dollars.toFixed(4)}`;
  return `$${dollars.toFixed(2)}`;
}

type SessionSpend = {
  costMicros: number;
  turns: number;
  errors: number;
  refused: number;
};

function aggregateJobStats(jobs: WebchatJobStatRow[]) {
  const bySession = new Map<string, SessionSpend>();
  let totalCostMicros = 0;
  let promptTokens = 0;
  let outputTokens = 0;
  let toolRounds = 0;
  let doneTurns = 0;
  let errorTurns = 0;
  let refusedTurns = 0;

  for (const j of jobs) {
    const s = bySession.get(j.session_id) ?? {
      costMicros: 0,
      turns: 0,
      errors: 0,
      refused: 0
    };
    s.turns += 1;
    if (j.status === "error") {
      s.errors += 1;
      errorTurns += 1;
    }
    if (j.status === "done") doneTurns += 1;
    if (j.refused_over_cap) {
      s.refused += 1;
      refusedTurns += 1;
    }
    const cost = Number(j.cost_micros ?? 0);
    if (Number.isFinite(cost) && cost > 0) {
      s.costMicros += cost;
      totalCostMicros += cost;
    }
    promptTokens += Number(j.prompt_tokens ?? 0) || 0;
    outputTokens += Number(j.output_tokens ?? 0) || 0;
    toolRounds += Number(j.tool_rounds ?? 0) || 0;
    bySession.set(j.session_id, s);
  }

  return {
    bySession,
    totalCostMicros,
    promptTokens,
    outputTokens,
    toolRounds,
    doneTurns,
    errorTurns,
    refusedTurns
  };
}

export default async function AdminSiteWebchatPage() {
  const header = (
    <div>
      <h1 className="text-2xl font-bold text-parchment">Web chat</h1>
      <p className="text-sm text-parchment/50 mt-1">
        Visitor conversations from the chat widget on newcoworker.com
      </p>
    </div>
  );

  const siteKey = parseWidgetKey(process.env.NEXT_PUBLIC_WEBCHAT_SITE_KEY);
  const settings = siteKey
    ? await getWidgetSettingsByKeyHash(hashWebchatToken(siteKey))
    : null;

  if (!settings) {
    return (
      <div className="space-y-6 max-w-5xl">
        {header}
        <Card>
          <p className="text-parchment/60 text-center py-8">
            {siteKey
              ? "The configured site key doesn't resolve to a widget — was it rotated without updating NEXT_PUBLIC_WEBCHAT_SITE_KEY?"
              : "NEXT_PUBLIC_WEBCHAT_SITE_KEY is not set, so no widget is running on newcoworker.com."}
          </p>
        </Card>
      </div>
    );
  }

  const [sessions, business] = await Promise.all([
    listWebchatSessionsForBusiness(settings.business_id, { limit: 100 }),
    getBusiness(settings.business_id)
  ]);
  // Job stats scoped to EXACTLY the sessions shown, so per-row spend and
  // the cards above always describe the same conversations.
  const jobs = await listWebchatJobStatsForSessions(sessions.map((s) => s.id));
  // Pool snapshot is display-only; a read failure must not blank the page.
  const spendSnapshot = await getChatSpendSnapshotForBusiness(
    settings.business_id,
    undefined,
    (business?.tier as PlanTier | null) ?? null
  ).catch(() => null);

  const agg = aggregateJobStats(jobs);
  const totalMessages = sessions.reduce((n, s) => n + s.message_count, 0);
  const leadsCaptured = sessions.filter(
    (s) => s.visitor_name || s.visitor_email || s.visitor_phone
  ).length;
  // Divide by every LISTED conversation (zero-spend ones included) so the
  // "avg · listed conversations" label is literally true.
  const avgPerConversation =
    sessions.length > 0 ? agg.totalCostMicros / sessions.length : 0;

  return (
    <div className="space-y-6 max-w-5xl">
      <div className="flex items-start justify-between gap-4">
        {header}
        {/* Replies come straight from Gemini — this config container is
            where the engine toggle, knowledge vault, and AI budget live. */}
        <Link
          href={`/admin/${settings.business_id}`}
          className="text-sm text-claw-green hover:underline shrink-0 mt-1"
        >
          Engine &amp; knowledge settings →
        </Link>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
        <Card>
          <p className="text-xs text-parchment/40 uppercase tracking-wider mb-1">
            Conversations
          </p>
          <p className="text-2xl font-bold text-parchment">{sessions.length}</p>
          <p className="text-xs text-parchment/40 mt-1">
            {leadsCaptured} with contact details captured
          </p>
        </Card>
        <Card>
          <p className="text-xs text-parchment/40 uppercase tracking-wider mb-1">Messages</p>
          <p className="text-2xl font-bold text-parchment">{totalMessages}</p>
          <p className="text-xs text-parchment/40 mt-1">
            {agg.doneTurns} AI replies · {agg.errorTurns} errored turn
            {agg.errorTurns === 1 ? "" : "s"}
          </p>
        </Card>
        <Card>
          <p className="text-xs text-parchment/40 uppercase tracking-wider mb-1">
            Total spent
          </p>
          <p className="text-2xl font-bold text-claw-green">{usd(agg.totalCostMicros)}</p>
          <p className="text-xs text-parchment/40 mt-1">
            {usd(Math.round(avgPerConversation))} avg · listed conversations
          </p>
        </Card>
        <Card>
          <p className="text-xs text-parchment/40 uppercase tracking-wider mb-1">Tokens</p>
          <p className="text-2xl font-bold text-parchment">
            {(agg.promptTokens + agg.outputTokens).toLocaleString()}
          </p>
          <p className="text-xs text-parchment/40 mt-1">
            {agg.promptTokens.toLocaleString()} in · {agg.outputTokens.toLocaleString()} out ·{" "}
            {agg.toolRounds} tool round{agg.toolRounds === 1 ? "" : "s"}
          </p>
        </Card>
        <Card>
          <p className="text-xs text-parchment/40 uppercase tracking-wider mb-1">
            AI budget (period)
          </p>
          <p className="text-2xl font-bold text-parchment">
            {spendSnapshot ? usd(spendSnapshot.spendMicros) : "—"}
          </p>
          <p className="text-xs text-parchment/40 mt-1">
            {spendSnapshot
              ? `of ${usd(spendSnapshot.effectiveCapMicros)} cap${
                  agg.refusedTurns > 0 ? ` · ${agg.refusedTurns} refused over cap` : ""
                }`
              : "pool snapshot unavailable"}
          </p>
        </Card>
      </div>

      {sessions.length === 0 ? (
        <Card>
          <p className="text-parchment/60 text-center py-8">No web chat sessions yet.</p>
        </Card>
      ) : (
        <Card>
          <ul className="divide-y divide-parchment/10">
            {sessions.map((s) => {
              const who =
                s.visitor_name || s.visitor_email || s.visitor_phone || "Anonymous visitor";
              const meta = parseVisitorMeta(s.visitor_meta ?? null);
              const contextBits = [
                [s.visitor_email, s.visitor_phone].filter((v) => v && v !== who).join(" · "),
                formatVisitorLocation(meta),
                formatVisitorDevice(meta),
                formatVisitorSource(meta)
              ]
                .filter(Boolean)
                .join(" · ");
              const spend = agg.bySession.get(s.id);
              const spendBits = [
                spend ? usd(spend.costMicros) : "$0",
                `${s.message_count} message${s.message_count === 1 ? "" : "s"}`
              ];
              if (spend && spend.errors > 0) spendBits.push(`${spend.errors} errored`);
              if (spend && spend.refused > 0) spendBits.push(`${spend.refused} refused`);
              return (
                <li key={s.id}>
                  <Link
                    href={`/admin/${s.business_id}/webchat/${s.id}`}
                    className="flex items-center justify-between gap-4 py-3 px-1 hover:bg-parchment/5 rounded-lg transition-colors"
                  >
                    <div className="min-w-0">
                      <p className="text-sm text-parchment truncate">{who}</p>
                      <p className="text-xs text-parchment/40 truncate">
                        {contextBits || "No contact details captured"}
                      </p>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-xs text-parchment/60">{spendBits.join(" · ")}</p>
                      <p className="text-xs text-parchment/40">
                        <LocalDateTime iso={s.last_seen_at} style="list" />
                      </p>
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        </Card>
      )}
    </div>
  );
}
