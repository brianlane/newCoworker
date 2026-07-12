/**
 * Owner-only employee performance metrics — BizBlasts'
 * StaffPerformanceService leaderboard translated to the data newCoworker
 * actually has (no bookings/revenue): lead-routing outcomes from AiFlow
 * `context.routing` and forwarded calls from voice transcripts.
 *
 * Per roster member over the trailing window:
 *   - offered      — runs where an offer verifiably reached them. Derived
 *     from the union of `routing.offered_log` (who was actually texted an
 *     offer), the current live `routing.offered`, AND `routing.claimed_by`.
 *     The claimed_by leg matters: the engine only finalizes a claim for a
 *     member who WAS offered the lead ("1" claims live/late/yank offers;
 *     see late_claim.ts), but the claim finalization does not append to
 *     offered_log, and runs predating the offered_log bookkeeping
 *     (2026-07-06, #387) never carry it at all — counting offered_log alone
 *     made Offered undercount and read LOWER than Claimed. This union keeps
 *     the invariant offered ≥ claimed for every member on every run.
 *   - claimed      — runs they hold (claimed_by)
 *   - claimRate    — claimed / offered (≤ 100% by the invariant above)
 *   - medianClaimMs — median run-start → last-update time across their
 *     claimed runs. APPROXIMATE by design: the routing context stamps no
 *     claim timestamp, and updated_at moves again if steps run after the
 *     claim — label it "typical turnaround" in the UI, not a stopwatch.
 *   - forwardedCalls — answered calls the voice line handed to them
 *     (voice_call_transcripts.forwarded_to_e164, missed excluded at the
 *     shared scan layer).
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import {
  ANALYTICS_CALL_SCAN_LIMIT,
  fetchTranscriptRows
} from "@/lib/analytics/dashboard-analytics";
import { listTeamMembers } from "@/lib/db/employees";
import { routingOfContext } from "../../../supabase/functions/_shared/ai_flows/routing";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export type EmployeePerformanceRow = {
  memberId: string;
  name: string;
  e164: string;
  active: boolean;
  offered: number;
  claimed: number;
  /** claimed / offered; null when never offered. */
  claimRate: number | null;
  /** Median ms from run start to its last update across claimed runs; null when unclaimed. */
  medianClaimMs: number | null;
  forwardedCalls: number;
};

export const EMPLOYEE_PERFORMANCE_WINDOW_DAYS = 30;

/** Run rows scanned per window — far above current per-tenant volumes. */
export const EMPLOYEE_RUN_SCAN_LIMIT = 2000;

/** Middle value (mean of the middle pair for even counts); null for []. */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Leaderboard rows for every roster member (active first, then by claims).
 * Members with zero activity still appear — an owner scanning the card
 * should see who ISN'T taking leads, not just who is.
 */
export async function getEmployeePerformance(
  businessId: string,
  opts: { client?: SupabaseClient; now?: Date; days?: number } = {}
): Promise<EmployeePerformanceRow[]> {
  const db = opts.client ?? (await createSupabaseServiceClient());
  const now = opts.now ?? new Date();
  const days = opts.days ?? EMPLOYEE_PERFORMANCE_WINDOW_DAYS;
  const cutoffIso = new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();

  const members = await listTeamMembers(businessId, db);
  if (members.length === 0) return [];

  type RunRow = {
    context: Record<string, unknown> | null;
    created_at: string;
    updated_at: string | null;
  };
  type CallRow = { forwarded_to_e164: string | null };
  const [runsRes, callRows] = await Promise.all([
    db
      .from("ai_flow_runs")
      .select("context, created_at, updated_at")
      .eq("business_id", businessId)
      .gte("created_at", cutoffIso)
      .order("created_at", { ascending: false })
      .limit(EMPLOYEE_RUN_SCAN_LIMIT),
    fetchTranscriptRows<CallRow>(businessId, db, {
      columns: ["forwarded_to_e164"],
      filter: { startIso: cutoffIso },
      limit: ANALYTICS_CALL_SCAN_LIMIT,
      label: "getEmployeePerformance calls"
    })
  ]);
  if (runsRes.error) {
    throw new Error(`getEmployeePerformance runs: ${runsRes.error.message}`);
  }

  const offered = new Map<string, number>();
  const claimed = new Map<string, number>();
  const claimDurations = new Map<string, number[]>();
  for (const run of ((runsRes.data as RunRow[] | null) ?? [])) {
    const routing = routingOfContext(run.context);
    if (!routing) continue;
    // Everyone this run's offer verifiably reached (see module doc): the
    // offer log, plus a live un-answered offer, plus the claimer — a claim
    // is itself proof an offer reached them, including on runs that predate
    // the offered_log bookkeeping.
    const offeredSet = new Set(routing.offered_log ?? []);
    if (routing.offered) offeredSet.add(routing.offered);
    if (routing.claimed_by) offeredSet.add(routing.claimed_by);
    for (const e164 of offeredSet) {
      offered.set(e164, (offered.get(e164) ?? 0) + 1);
    }
    if (routing.claimed_by) {
      claimed.set(routing.claimed_by, (claimed.get(routing.claimed_by) ?? 0) + 1);
      const start = Date.parse(run.created_at);
      const end = run.updated_at ? Date.parse(run.updated_at) : NaN;
      if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
        const list = claimDurations.get(routing.claimed_by) ?? [];
        list.push(end - start);
        claimDurations.set(routing.claimed_by, list);
      }
    }
  }

  const forwarded = new Map<string, number>();
  for (const call of callRows) {
    if (!call.forwarded_to_e164) continue;
    forwarded.set(call.forwarded_to_e164, (forwarded.get(call.forwarded_to_e164) ?? 0) + 1);
  }

  const rows: EmployeePerformanceRow[] = members.map((m) => {
    const offers = offered.get(m.phone_e164) ?? 0;
    const claims = claimed.get(m.phone_e164) ?? 0;
    return {
      memberId: m.id,
      name: m.name,
      e164: m.phone_e164,
      active: m.active,
      offered: offers,
      claimed: claims,
      // offered ⊇ claimed per run (the claimer always counts as offered),
      // so this can never exceed 100%.
      claimRate: offers === 0 ? null : claims / offers,
      medianClaimMs: median(claimDurations.get(m.phone_e164) ?? []),
      forwardedCalls: forwarded.get(m.phone_e164) ?? 0
    };
  });
  rows.sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1;
    return b.claimed - a.claimed;
  });
  return rows;
}
