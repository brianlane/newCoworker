/**
 * Per-flow conversion funnels — BizBlasts' MarketingPerformanceService /
 * ConversionAttributionService mapped onto AiFlows (a flow IS the campaign):
 *
 *   runs started → texts sent → tracked-link clicks → goals reached
 *
 * Sources, all already written by the engine:
 *   - `ai_flow_runs`      — runs per flow; a context var starting `__goal_`
 *     marks a run an external milestone fast-forwarded to a goal step
 *     (goal_events.ts), i.e. a CONVERSION.
 *   - `sms_outbound_log`  — flow-attributed sends (source 'ai_flow').
 *   - `sms_links`         — tracked short links minted for flow sends;
 *     click_count > 0 = the lead actually tapped through.
 *
 * No ROI column on purpose: flows carry no cost, and newCoworker holds no
 * tenant revenue — rates between funnel stages are the honest signal.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";

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

export const FLOW_FUNNEL_WINDOW_DAYS = 30;
/** Flows listed on the card. */
export const FLOW_FUNNEL_FLOW_LIMIT = 25;
/** Row caps per source scan — far above current per-tenant volumes. */
export const FLOW_FUNNEL_SCAN_LIMIT = 5000;

/** True when the run's context carries a reached-goal marker. */
export function runReachedGoal(context: Record<string, unknown> | null): boolean {
  const vars = context?.vars;
  if (!vars || typeof vars !== "object" || Array.isArray(vars)) return false;
  return Object.keys(vars as Record<string, unknown>).some((k) => k.startsWith("__goal_"));
}

/**
 * Funnel rows for the business's flows over the trailing window, most-run
 * first. Flows with zero window activity still appear (up to the flow
 * limit) so the owner sees which automations are idle.
 */
export async function getFlowFunnels(
  businessId: string,
  opts: { client?: SupabaseClient; now?: Date; days?: number } = {}
): Promise<FlowFunnelRow[]> {
  const db = opts.client ?? (await createSupabaseServiceClient());
  const now = opts.now ?? new Date();
  const days = opts.days ?? FLOW_FUNNEL_WINDOW_DAYS;
  const cutoffIso = new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();

  const [flowsRes, runsRes, sendsRes, linksRes] = await Promise.all([
    db
      .from("ai_flows")
      .select("id, name, enabled")
      .eq("business_id", businessId)
      .order("created_at", { ascending: false })
      .limit(FLOW_FUNNEL_FLOW_LIMIT),
    db
      .from("ai_flow_runs")
      .select("flow_id, context")
      .eq("business_id", businessId)
      .gte("created_at", cutoffIso)
      .order("created_at", { ascending: false })
      .limit(FLOW_FUNNEL_SCAN_LIMIT),
    db
      .from("sms_outbound_log")
      .select("flow_id")
      .eq("business_id", businessId)
      .eq("source", "ai_flow")
      .not("flow_id", "is", null)
      .gte("created_at", cutoffIso)
      .limit(FLOW_FUNNEL_SCAN_LIMIT),
    db
      .from("sms_links")
      .select("flow_id, click_count")
      .eq("business_id", businessId)
      .not("flow_id", "is", null)
      .gte("created_at", cutoffIso)
      .limit(FLOW_FUNNEL_SCAN_LIMIT)
  ]);
  if (flowsRes.error) throw new Error(`getFlowFunnels flows: ${flowsRes.error.message}`);
  if (runsRes.error) throw new Error(`getFlowFunnels runs: ${runsRes.error.message}`);
  if (sendsRes.error) throw new Error(`getFlowFunnels sends: ${sendsRes.error.message}`);
  if (linksRes.error) throw new Error(`getFlowFunnels links: ${linksRes.error.message}`);

  const runs = new Map<string, number>();
  const goals = new Map<string, number>();
  type RunRow = { flow_id: string; context: Record<string, unknown> | null };
  for (const run of ((runsRes.data as RunRow[] | null) ?? [])) {
    runs.set(run.flow_id, (runs.get(run.flow_id) ?? 0) + 1);
    if (runReachedGoal(run.context)) {
      goals.set(run.flow_id, (goals.get(run.flow_id) ?? 0) + 1);
    }
  }

  const texts = new Map<string, number>();
  for (const send of ((sendsRes.data as Array<{ flow_id: string }> | null) ?? [])) {
    texts.set(send.flow_id, (texts.get(send.flow_id) ?? 0) + 1);
  }

  const linksClicked = new Map<string, number>();
  const linkClicks = new Map<string, number>();
  type LinkRow = { flow_id: string; click_count: number };
  for (const link of ((linksRes.data as LinkRow[] | null) ?? [])) {
    if (link.click_count > 0) {
      linksClicked.set(link.flow_id, (linksClicked.get(link.flow_id) ?? 0) + 1);
      linkClicks.set(link.flow_id, (linkClicks.get(link.flow_id) ?? 0) + link.click_count);
    }
  }

  type FlowRow = { id: string; name: string; enabled: boolean };
  const rows: FlowFunnelRow[] = (((flowsRes.data as FlowRow[] | null) ?? [])).map((flow) => ({
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
  return rows;
}
