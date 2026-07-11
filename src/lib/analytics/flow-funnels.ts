/**
 * Per-flow conversion funnels — BizBlasts' MarketingPerformanceService /
 * ConversionAttributionService mapped onto AiFlows (a flow IS the campaign):
 *
 *   runs started → texts sent → tracked-link clicks → goals reached
 *
 * Sources, all already written by the engine:
 *   - `ai_flow_runs`      — runs per flow (central engine table); a context
 *     var starting `__goal_` marks a run an external milestone
 *     fast-forwarded to a goal step (goal_events.ts), i.e. a CONVERSION.
 *   - `sms_outbound_log`  — flow-attributed sends (source 'ai_flow').
 *   - `sms_links`         — tracked short links minted for flow sends
 *     (central by design — see residency/tables.ts); click_count > 0 = the
 *     lead actually tapped through.
 *
 * Residency: `ai_flows` and `sms_outbound_log` are MOVED tables — vps-mode
 * tenants read them from their box (same routing as the analytics cards).
 *
 * No ROI column on purpose: flows carry no cost, and newCoworker holds no
 * tenant revenue — rates between funnel stages are the honest signal.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { analyticsWindowStart } from "@/lib/analytics/dashboard-analytics";
import { isVpsReadMode, readMovedRows } from "@/lib/residency/read";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export type FlowFunnelRow = {
  flowId: string;
  flowName: string;
  enabled: boolean;
  runs: number;
  textsSent: number;
  /** Distinct tracked links that got at least one click. */
  linksClicked: number;
  /** Total clicks across the flow's tracked links. */
  linkClicks: number;
  /** Runs an external milestone jumped to a goal step. */
  goalsReached: number;
};

export type FlowFunnels = {
  /** Busiest first, capped at FLOW_FUNNEL_FLOW_LIMIT. */
  rows: FlowFunnelRow[];
  /** True when any source scan hit its cap — counts may be low. */
  clipped: boolean;
};

export const FLOW_FUNNEL_WINDOW_DAYS = 30;
/** Flows listed on the card (busiest first — NOT newest first). */
export const FLOW_FUNNEL_FLOW_LIMIT = 25;
/** Flows considered for ranking; far above any tenant's flow count. */
export const FLOW_FUNNEL_CANDIDATE_LIMIT = 200;
/** Row caps per source scan — far above current per-tenant volumes. */
export const FLOW_FUNNEL_SCAN_LIMIT = 5000;

/** True when the run's context carries a reached-goal marker. */
export function runReachedGoal(context: Record<string, unknown> | null): boolean {
  const vars = context?.vars;
  if (!vars || typeof vars !== "object" || Array.isArray(vars)) return false;
  return Object.keys(vars as Record<string, unknown>).some((k) => k.startsWith("__goal_"));
}

type FlowRow = { id: string; name: string; enabled: boolean };
type SendRow = { flow_id: string | null };

/**
 * Funnel rows for the business's flows over the trailing window, ranked by
 * run count so the BUSIEST flows surface (an old workhorse flow must not
 * lose its slot to newer idle ones). Idle flows still appear while slots
 * remain, so the owner sees which automations do nothing.
 */
export async function getFlowFunnels(
  businessId: string,
  opts: { client?: SupabaseClient; now?: Date; days?: number } = {}
): Promise<FlowFunnels> {
  const db = opts.client ?? (await createSupabaseServiceClient());
  const now = opts.now ?? new Date();
  const days = opts.days ?? FLOW_FUNNEL_WINDOW_DAYS;
  // Day-aligned like every other card on /dashboard/analytics
  // (analyticsWindowStart): the funnel must describe the same interval as
  // the volume charts or the page contradicts itself.
  const cutoffIso = analyticsWindowStart(now, days).toISOString();

  // ai_flows and sms_outbound_log are residency-moved tables: vps tenants
  // read their box. The data-api filter grammar has no "is not null", so
  // the vps sends read filters nulls client-side (same rows either way).
  const vpsReadMode = await isVpsReadMode(businessId, db);
  const fetchFlows = async (): Promise<FlowRow[]> => {
    if (vpsReadMode) {
      return await readMovedRows<FlowRow>(businessId, {
        table: "ai_flows",
        columns: ["id", "name", "enabled"],
        filters: [{ column: "business_id", op: "eq", value: businessId }],
        order: [{ column: "created_at", ascending: false }],
        limit: FLOW_FUNNEL_CANDIDATE_LIMIT
      });
    }
    const { data, error } = await db
      .from("ai_flows")
      .select("id, name, enabled")
      .eq("business_id", businessId)
      .order("created_at", { ascending: false })
      .limit(FLOW_FUNNEL_CANDIDATE_LIMIT);
    if (error) throw new Error(`getFlowFunnels flows: ${error.message}`);
    return ((data as FlowRow[] | null) ?? []);
  };
  const fetchSends = async (): Promise<SendRow[]> => {
    if (vpsReadMode) {
      const rows = await readMovedRows<SendRow>(businessId, {
        table: "sms_outbound_log",
        columns: ["flow_id"],
        filters: [
          { column: "business_id", op: "eq", value: businessId },
          { column: "source", op: "eq", value: "ai_flow" },
          { column: "created_at", op: "gte", value: cutoffIso }
        ],
        order: [{ column: "created_at", ascending: false }],
        limit: FLOW_FUNNEL_SCAN_LIMIT
      });
      return rows.filter((r) => r.flow_id !== null);
    }
    const { data, error } = await db
      .from("sms_outbound_log")
      .select("flow_id")
      .eq("business_id", businessId)
      .eq("source", "ai_flow")
      .not("flow_id", "is", null)
      .gte("created_at", cutoffIso)
      // Newest-first so a capped scan keeps the MOST RECENT activity — the
      // exact claim the clipped footnote makes.
      .order("created_at", { ascending: false })
      .limit(FLOW_FUNNEL_SCAN_LIMIT);
    if (error) throw new Error(`getFlowFunnels sends: ${error.message}`);
    return ((data as SendRow[] | null) ?? []);
  };

  const [flows, runsRes, sends, linksRes] = await Promise.all([
    fetchFlows(),
    db
      .from("ai_flow_runs")
      .select("flow_id, context")
      .eq("business_id", businessId)
      .gte("created_at", cutoffIso)
      .order("created_at", { ascending: false })
      .limit(FLOW_FUNNEL_SCAN_LIMIT),
    fetchSends(),
    db
      .from("sms_links")
      .select("flow_id, click_count")
      .eq("business_id", businessId)
      .not("flow_id", "is", null)
      .gte("created_at", cutoffIso)
      // Newest-first for the same capped-scan honesty as the sends read.
      .order("created_at", { ascending: false })
      .limit(FLOW_FUNNEL_SCAN_LIMIT)
  ]);
  if (runsRes.error) throw new Error(`getFlowFunnels runs: ${runsRes.error.message}`);
  if (linksRes.error) throw new Error(`getFlowFunnels links: ${linksRes.error.message}`);

  const runs = new Map<string, number>();
  const goals = new Map<string, number>();
  type RunRow = { flow_id: string; context: Record<string, unknown> | null };
  const runRows = ((runsRes.data as RunRow[] | null) ?? []);
  for (const run of runRows) {
    runs.set(run.flow_id, (runs.get(run.flow_id) ?? 0) + 1);
    if (runReachedGoal(run.context)) {
      goals.set(run.flow_id, (goals.get(run.flow_id) ?? 0) + 1);
    }
  }

  const texts = new Map<string, number>();
  for (const send of sends) {
    texts.set(send.flow_id as string, (texts.get(send.flow_id as string) ?? 0) + 1);
  }

  const linksClicked = new Map<string, number>();
  const linkClicks = new Map<string, number>();
  type LinkRow = { flow_id: string; click_count: number };
  const linkRows = ((linksRes.data as LinkRow[] | null) ?? []);
  for (const link of linkRows) {
    if (link.click_count > 0) {
      linksClicked.set(link.flow_id, (linksClicked.get(link.flow_id) ?? 0) + 1);
      linkClicks.set(link.flow_id, (linkClicks.get(link.flow_id) ?? 0) + link.click_count);
    }
  }

  const rows: FlowFunnelRow[] = flows.map((flow) => ({
    flowId: flow.id,
    flowName: flow.name,
    enabled: flow.enabled,
    runs: runs.get(flow.id) ?? 0,
    textsSent: texts.get(flow.id) ?? 0,
    linksClicked: linksClicked.get(flow.id) ?? 0,
    linkClicks: linkClicks.get(flow.id) ?? 0,
    goalsReached: goals.get(flow.id) ?? 0
  }));
  rows.sort((a, b) => b.runs - a.runs);
  return {
    rows: rows.slice(0, FLOW_FUNNEL_FLOW_LIMIT),
    // Activity-scan caps only: a business with 200+ FLOWS but modest volume
    // has accurate counts for every listed flow — the candidate cap trims
    // which flows are ranked, not their numbers, so it must not trigger the
    // "counts are partial" warning.
    clipped:
      runRows.length >= FLOW_FUNNEL_SCAN_LIMIT ||
      sends.length >= FLOW_FUNNEL_SCAN_LIMIT ||
      linkRows.length >= FLOW_FUNNEL_SCAN_LIMIT
  };
}
