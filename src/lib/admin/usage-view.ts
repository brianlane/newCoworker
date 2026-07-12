/**
 * Pure view-model helpers for the admin Usage page (/admin/usage): month
 * windows for the selector, per-tenant cap utilization (the canvas's
 * "Amy runs at ~10% of caps" number computed live), and Telnyx cost
 * grouping within a selected month.
 */

import { getTierLimits } from "@/lib/plans/limits";
import type { PlanTier } from "@/lib/plans/tier";
import type { TelnyxCostDailyRow } from "@/lib/db/platform-costs";

/** YYYY-MM keys for the current month and the `count - 1` before it, newest first. */
export function listRecentMonths(now: Date, count: number): string[] {
  const months: string[] = [];
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  for (let i = 0; i < count; i += 1) {
    const d = new Date(Date.UTC(year, month - i, 1));
    months.push(d.toISOString().slice(0, 7));
  }
  return months;
}

export type MonthWindow = {
  ym: string;
  startYmd: string;
  endYmdExclusive: string;
};

/** UTC day window [first of month, first of next month) for a YYYY-MM key. */
export function monthWindow(ym: string): MonthWindow {
  const [year, month] = ym.split("-").map(Number);
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 1));
  return {
    ym,
    startYmd: start.toISOString().slice(0, 10),
    endYmdExclusive: end.toISOString().slice(0, 10)
  };
}

/** The month a `?month=` query param selects; invalid/unlisted values fall back to current. */
export function resolveSelectedMonth(raw: string | undefined, validMonths: string[]): string {
  if (raw !== undefined && validMonths.includes(raw)) return raw;
  return validMonths[0];
}

/**
 * Blended cap utilization %, the canvas methodology: mean of the ratios
 * against each metered cap the tier actually has (voice included seconds,
 * monthly SMS, AI budget). Uncapped axes (enterprise unlimited SMS) and
 * axes with no reading (historical AI spend) are excluded from the mean.
 * The voice pool is always a finite positive cap (the enterprise override
 * schema floors it at 60s), so at least one ratio always exists.
 */
export function computeUtilizationPct(params: {
  tier: PlanTier;
  enterpriseLimitsOverride?: unknown;
  voiceMinutes: number;
  smsSent: number;
  /** Current-period Gemini chat spend; null when unknown (historical months). */
  aiSpendMicros: number | null;
  aiCapMicros: number;
}): number {
  const limits = getTierLimits(params.tier, params.enterpriseLimitsOverride);
  const ratios: number[] = [
    params.voiceMinutes / (limits.voiceIncludedSecondsPerStripePeriod / 60)
  ];
  // smsPerMonth is Infinity (uncapped) or a positive finite cap — the
  // override schema rejects zero/negative values.
  if (Number.isFinite(limits.smsPerMonth)) {
    ratios.push(params.smsSent / limits.smsPerMonth);
  }
  if (params.aiSpendMicros !== null && params.aiCapMicros > 0) {
    ratios.push(params.aiSpendMicros / params.aiCapMicros);
  }

  const mean = ratios.reduce((sum, r) => sum + r, 0) / ratios.length;
  return Math.round(mean * 100);
}

/** businessId → summed Telnyx cost (micro-USD) for rows inside [start, end). */
export function telnyxMicrosByBusinessInWindow(
  rows: TelnyxCostDailyRow[],
  window: MonthWindow
): { byBusiness: Map<string, number>; hasRows: boolean } {
  const byBusiness = new Map<string, number>();
  let hasRows = false;
  for (const row of rows) {
    if (row.day < window.startYmd || row.day >= window.endYmdExclusive) continue;
    hasRows = true;
    if (row.business_id === null) continue;
    byBusiness.set(row.business_id, (byBusiness.get(row.business_id) ?? 0) + row.cost_micros);
  }
  return { byBusiness, hasRows };
}
