/**
 * Pure view-model helpers for the admin Gemini page (/admin/gemini):
 * calendar-day range windows that match AI Studio's daily bars, the daily
 * stacked series, per-tenant surface/model breakdowns with an
 * estimate-priced share (so pricing confidence is never hidden), and the
 * metered-vs-billed reconciliation against the synced Cloud Billing rows.
 *
 * All inputs are prefetched rows; nothing here touches the network.
 */

import type { GeminiBilledDailyRow, GeminiSpendDailyRow } from "@/lib/db/gemini-spend";

const DAY_MS = 24 * 60 * 60 * 1000;

export type GeminiRangeKey = "today" | "7d" | "month" | "90d";

export const GEMINI_RANGE_KEYS: GeminiRangeKey[] = ["today", "7d", "month", "90d"];

/** The range a `?range=` query param selects; invalid values fall back to 7d. */
export function resolveGeminiRange(raw: string | undefined): GeminiRangeKey {
  return (GEMINI_RANGE_KEYS as string[]).includes(raw ?? "") ? (raw as GeminiRangeKey) : "7d";
}

export type GeminiRangeWindow = {
  range: GeminiRangeKey;
  /** Inclusive UTC start day. */
  startYmd: string;
  /** Exclusive UTC end day (tomorrow for rolling ranges). */
  endYmdExclusive: string;
};

function ymd(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * UTC calendar-day window for a range key. Rolling ranges end tomorrow
 * (exclusive) so today's partial day is included — same convention as AI
 * Studio's rightmost bar.
 */
export function geminiRangeWindow(range: GeminiRangeKey, now: Date): GeminiRangeWindow {
  const todayMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const endYmdExclusive = ymd(todayMs + DAY_MS);
  if (range === "month") {
    return {
      range,
      startYmd: ymd(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
      endYmdExclusive
    };
  }
  const days = range === "today" ? 1 : range === "7d" ? 7 : 90;
  return { range, startYmd: ymd(todayMs - (days - 1) * DAY_MS), endYmdExclusive };
}

function inWindow(day: string, window: GeminiRangeWindow): boolean {
  return day >= window.startYmd && day < window.endYmdExclusive;
}

export type GeminiDailyPoint = {
  day: string;
  costMicros: number;
  /** Per-tenant stack segments, largest first. */
  segments: Array<{ businessId: string; costMicros: number }>;
};

export type GeminiDailySeries = {
  points: GeminiDailyPoint[];
  maxMicros: number;
  totalMicros: number;
};

/** Every day in the window (zero days included), oldest first. */
export function buildGeminiDailySeries(
  rows: GeminiSpendDailyRow[],
  window: GeminiRangeWindow
): GeminiDailySeries {
  const byDay = new Map<string, Map<string, number>>();
  for (const row of rows) {
    if (!inWindow(row.day, window)) continue;
    let perBusiness = byDay.get(row.day);
    if (!perBusiness) {
      perBusiness = new Map();
      byDay.set(row.day, perBusiness);
    }
    perBusiness.set(row.business_id, (perBusiness.get(row.business_id) ?? 0) + row.cost_micros);
  }

  const points: GeminiDailyPoint[] = [];
  let maxMicros = 0;
  let totalMicros = 0;
  for (
    let ms = Date.parse(window.startYmd);
    ymd(ms) < window.endYmdExclusive;
    ms += DAY_MS
  ) {
    const day = ymd(ms);
    const perBusiness = byDay.get(day) ?? new Map<string, number>();
    const segments = [...perBusiness.entries()]
      .map(([businessId, costMicros]) => ({ businessId, costMicros }))
      .sort((a, b) => b.costMicros - a.costMicros);
    const costMicros = segments.reduce((sum, s) => sum + s.costMicros, 0);
    maxMicros = Math.max(maxMicros, costMicros);
    totalMicros += costMicros;
    points.push({ day, costMicros, segments });
  }
  return { points, maxMicros, totalMicros };
}

export type GeminiBreakdownLine = {
  surface: string;
  model: string;
  callCount: number;
  promptTokens: number;
  outputTokens: number;
  costMicros: number;
  estimateMicros: number;
};

export type GeminiTenantBreakdown = {
  businessId: string;
  costMicros: number;
  callCount: number;
  /** Portion of costMicros priced by the chars/4 estimate fallback. */
  estimateMicros: number;
  lines: GeminiBreakdownLine[];
};

/** Per-tenant totals + surface/model lines within the window, biggest spender first. */
export function buildGeminiTenantBreakdown(
  rows: GeminiSpendDailyRow[],
  window: GeminiRangeWindow
): GeminiTenantBreakdown[] {
  const byBusiness = new Map<string, GeminiTenantBreakdown>();
  for (const row of rows) {
    if (!inWindow(row.day, window)) continue;
    let tenant = byBusiness.get(row.business_id);
    if (!tenant) {
      tenant = {
        businessId: row.business_id,
        costMicros: 0,
        callCount: 0,
        estimateMicros: 0,
        lines: []
      };
      byBusiness.set(row.business_id, tenant);
    }
    const estimate = row.pricing_source === "estimate" ? row.cost_micros : 0;
    tenant.costMicros += row.cost_micros;
    tenant.callCount += row.call_count;
    tenant.estimateMicros += estimate;

    const key = `${row.surface}|${row.model}`;
    let line = tenant.lines.find((l) => `${l.surface}|${l.model}` === key);
    if (!line) {
      line = {
        surface: row.surface,
        model: row.model,
        callCount: 0,
        promptTokens: 0,
        outputTokens: 0,
        costMicros: 0,
        estimateMicros: 0
      };
      tenant.lines.push(line);
    }
    line.callCount += row.call_count;
    line.promptTokens += row.prompt_tokens;
    line.outputTokens += row.output_tokens;
    line.costMicros += row.cost_micros;
    line.estimateMicros += estimate;
  }
  const tenants = [...byBusiness.values()].sort((a, b) => b.costMicros - a.costMicros);
  for (const tenant of tenants) {
    tenant.lines.sort((a, b) => b.costMicros - a.costMicros);
  }
  return tenants;
}

/**
 * businessId → summed metered cost (micro-USD) for rows inside [start, end).
 * `hasRows` distinguishes "the ledger has data for this window and this
 * tenant spent $0" from "no ledger data at all" (pre-ledger months) — same
 * shape as telnyxMicrosByBusinessInWindow, so the Usage page can render
 * "—" instead of a misleading $0.00.
 */
export function geminiMicrosByBusinessInWindow(
  rows: GeminiSpendDailyRow[],
  window: { startYmd: string; endYmdExclusive: string }
): { byBusiness: Map<string, number>; hasRows: boolean } {
  const byBusiness = new Map<string, number>();
  let hasRows = false;
  for (const row of rows) {
    if (row.day < window.startYmd || row.day >= window.endYmdExclusive) continue;
    hasRows = true;
    byBusiness.set(row.business_id, (byBusiness.get(row.business_id) ?? 0) + row.cost_micros);
  }
  return { byBusiness, hasRows };
}

export type GeminiReconciliation = {
  /** Latest day with synced billed data inside the window; null → none. */
  latestBilledDay: string | null;
  /** Metered total over the window days that have billed data (fair compare). */
  meteredComparableMicros: number;
  billedTotalMicros: number;
  byProject: Array<{ projectId: string; costMicros: number }>;
  /** billed − metered over the comparable days; positive = unmetered spend. */
  deltaMicros: number;
  /** delta as % of billed; null when nothing was billed. */
  deltaPct: number | null;
};

/**
 * Compare the metered ledger to Google's synced billed rows over the same
 * window. Billed data lags up to ~24h, so the metered side is clipped to
 * days that billed data actually covers — otherwise today's metered spend
 * would always read as a negative "leak".
 */
export function buildGeminiReconciliation(
  spendRows: GeminiSpendDailyRow[],
  billedRows: GeminiBilledDailyRow[],
  window: GeminiRangeWindow
): GeminiReconciliation {
  let latestBilledDay: string | null = null;
  let billedTotalMicros = 0;
  const byProject = new Map<string, number>();
  for (const row of billedRows) {
    if (!inWindow(row.day, window)) continue;
    if (latestBilledDay === null || row.day > latestBilledDay) latestBilledDay = row.day;
    billedTotalMicros += row.cost_micros;
    byProject.set(row.gcp_project_id, (byProject.get(row.gcp_project_id) ?? 0) + row.cost_micros);
  }

  let meteredComparableMicros = 0;
  if (latestBilledDay !== null) {
    for (const row of spendRows) {
      if (inWindow(row.day, window) && row.day <= latestBilledDay) {
        meteredComparableMicros += row.cost_micros;
      }
    }
  }

  const deltaMicros = billedTotalMicros - meteredComparableMicros;
  return {
    latestBilledDay,
    meteredComparableMicros,
    billedTotalMicros,
    byProject: [...byProject.entries()]
      .map(([projectId, costMicros]) => ({ projectId, costMicros }))
      .sort((a, b) => b.costMicros - a.costMicros),
    deltaMicros,
    deltaPct:
      billedTotalMicros > 0 ? Math.round((deltaMicros / billedTotalMicros) * 1000) / 10 : null
  };
}
