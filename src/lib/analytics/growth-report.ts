/**
 * Per-business growth report: what the coworker handled, month by month, and
 * where the line is pointing.
 *
 * This is the data behind the monthly owner email. It answers one question an
 * owner actually has ("is this thing working, and is it getting better?") and
 * deliberately answers it with the same numbers the dashboard analytics page
 * shows, so the email can never contradict the app.
 *
 * THREE RULES THAT SHAPE EVERYTHING HERE:
 *
 * 1. COMPLETE MONTHS ONLY. The report is built for months that have ended. A
 *    month-to-date column next to finished months always reads as a collapse,
 *    and an owner who opens this on the 3rd does not want a two-day sample.
 *    {@link completeMonths} is what enforces it.
 * 2. SNAPSHOTS, NOT LIVE TABLES. `analytics_daily_snapshots` is written by the
 *    nightly sweep and survives retention pruning, so a 6-month lookback still
 *    works for a tenant whose transcripts have aged out. `contacts` is the one
 *    exception: it has no snapshot, so it is counted directly (and
 *    residency-routed for a tenant whose rows live on their own box).
 * 3. NO PROJECTION WITHOUT HISTORY. Two points is a line through anything.
 *    {@link projectNextMonth} returns null below {@link MIN_MONTHS_FOR_TREND}
 *    complete months and the email simply omits that sentence.
 * 4. AN UNMEASURED MONTH IS NOT A ZERO MONTH. The snapshot sweep writes a row
 *    for every business every day, activity or not, so a month with no
 *    snapshot rows means the sweep did not exist yet (it shipped Jul 11 2026)
 *    or the tenant did not. Reported as zeros it reads as "you did nothing",
 *    and it drags any trend line through a period nobody was measuring:
 *    Amy's real June had 38 leads but no snapshots, which rendered as "Texts
 *    sent: 390 (0 last month, new)". Those months are DROPPED, not zeroed.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { countMovedRows, isVpsReadMode } from "@/lib/residency/read";
import { computePeriodChange, type PeriodChange } from "@/lib/analytics/dashboard-analytics";
import { monthStart } from "@/lib/analytics/monthly-summary";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

/** Complete months the report looks back over, newest last. */
export const DEFAULT_GROWTH_MONTHS = 6;

/** Fewest complete months before a forward projection is honest. */
export const MIN_MONTHS_FOR_TREND = 3;

export type GrowthMonth = {
  /** "YYYY-MM". */
  month: string;
  /** New customer contacts created that month. */
  leads: number;
  /** Outbound texts the coworker sent. */
  texts: number;
  /** Answered calls, both directions. */
  calls: number;
  /** Wall-clock minutes on the phone. */
  voiceMinutes: number;
  /** Days of the month with a snapshot row, out of the month's length. */
  coveredDays: number;
  /** Days in the month, so coverage can be stated as a fraction. */
  daysInMonth: number;
};

/** The four metrics the email reports on, in the order it reports them. */
export const GROWTH_METRICS = ["leads", "texts", "calls", "voiceMinutes"] as const;
export type GrowthMetric = (typeof GROWTH_METRICS)[number];

export type GrowthReport = {
  /** Complete months, oldest first. Empty when the tenant is brand new. */
  months: GrowthMonth[];
  /** The month the email is about: the most recent complete one. */
  latest: GrowthMonth | null;
  /** The month before it, for the side-by-side comparison. */
  previous: GrowthMonth | null;
  /** Change of `latest` against `previous`, per metric. */
  changes: Record<GrowthMetric, PeriodChange> | null;
  /** Straight-line projection for the month after `latest`, or null. */
  projection: Record<GrowthMetric, number> | null;
  /**
   * True when at least one snapshot day is missing from the reported month.
   * The email says so rather than presenting a short month as a real dip.
   */
  latestMonthIncomplete: boolean;
};

export function daysInMonth(month: string): number {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y!, m!, 0)).getUTCDate();
}

/**
 * The complete months ending with the one BEFORE `now`'s month, oldest first.
 *
 * Called on Sep 2 2026 with count 3 this gives June, July, August: the month
 * in progress is never in the list.
 */
export function completeMonths(now: Date, count: number): string[] {
  const wanted = Math.max(0, Math.trunc(count));
  const months: string[] = [];
  for (let back = 1; back <= wanted; back += 1) {
    months.push(monthStart(now, -back).toISOString().slice(0, 7));
  }
  return months.reverse();
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

/**
 * Least-squares slope and intercept over `values` at x = 0, 1, 2, ...
 *
 * A straight line, not a growth rate, on purpose: compounding a
 * month-over-month percentage across six months turns one busy September into
 * an absurd forecast, and this number goes in front of a customer.
 */
export function linearFit(values: number[]): { slope: number; intercept: number } {
  const n = values.length;
  const meanX = (n - 1) / 2;
  const meanY = values.reduce((s, v) => s + v, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i += 1) {
    num += (i - meanX) * (values[i]! - meanY);
    den += (i - meanX) ** 2;
  }
  // den is 0 only for a single point, which the caller has already excluded
  // via MIN_MONTHS_FOR_TREND; a flat series still has a non-zero den.
  const slope = num / den;
  return { slope, intercept: meanY - slope * meanX };
}

/**
 * Where the next month lands if the trend holds, rounded and floored at zero.
 *
 * Null below {@link MIN_MONTHS_FOR_TREND} months: an owner in their second
 * month should be told what happened, not given a forecast drawn through two
 * points.
 */
export function projectNextMonth(values: number[]): number | null {
  if (values.length < MIN_MONTHS_FOR_TREND) return null;
  const { slope, intercept } = linearFit(values);
  return Math.max(0, Math.round(intercept + slope * values.length));
}

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

export type SnapshotRow = {
  snapshot_date: string;
  calls: number | null;
  sms_sent: number | null;
  voice_minutes: number | null;
};

export type ComposeGrowthReportInput = {
  months: string[];
  snapshots: SnapshotRow[];
  /** New customer contacts per month, keyed "YYYY-MM". */
  leadsByMonth: Map<string, number>;
};

/** Fold snapshot days and contact counts into one month-by-month report. */
export function composeGrowthReport(input: ComposeGrowthReportInput): GrowthReport {
  const byMonth = new Map<string, GrowthMonth>(
    input.months.map((month) => [
      month,
      {
        month,
        leads: input.leadsByMonth.get(month) ?? 0,
        texts: 0,
        calls: 0,
        voiceMinutes: 0,
        coveredDays: 0,
        daysInMonth: daysInMonth(month)
      }
    ])
  );

  for (const row of input.snapshots) {
    const entry = byMonth.get(row.snapshot_date.slice(0, 7));
    if (!entry) continue;
    entry.calls += Number(row.calls ?? 0);
    entry.texts += Number(row.sms_sent ?? 0);
    entry.voiceMinutes += Number(row.voice_minutes ?? 0);
    entry.coveredDays += 1;
  }

  // Drop months nobody was measuring (rule 4 above). Leads would survive for
  // such a month (they come from `contacts`, not the snapshots), which is
  // exactly what makes the mixed row dangerous: a real lead count beside a
  // fabricated zero for texts and calls reads as a catastrophic month.
  const months = input.months.map((m) => byMonth.get(m)!).filter((m) => m.coveredDays > 0);
  const latest = months[months.length - 1] ?? null;
  const previous = months[months.length - 2] ?? null;

  const changes =
    latest && previous
      ? ({
          leads: computePeriodChange(latest.leads, previous.leads),
          texts: computePeriodChange(latest.texts, previous.texts),
          calls: computePeriodChange(latest.calls, previous.calls),
          voiceMinutes: computePeriodChange(latest.voiceMinutes, previous.voiceMinutes)
        } satisfies Record<GrowthMetric, PeriodChange>)
      : null;

  const projectedLeads = projectNextMonth(months.map((m) => m.leads));
  const projection =
    projectedLeads === null
      ? null
      : ({
          leads: projectedLeads,
          texts: projectNextMonth(months.map((m) => m.texts))!,
          calls: projectNextMonth(months.map((m) => m.calls))!,
          voiceMinutes: projectNextMonth(months.map((m) => m.voiceMinutes))!
        } satisfies Record<GrowthMetric, number>);

  return {
    months,
    latest,
    previous,
    changes,
    projection,
    latestMonthIncomplete: latest !== null && latest.coveredDays < latest.daysInMonth
  };
}

/** True when the reported month has nothing worth emailing about. */
export function hasReportableActivity(report: GrowthReport): boolean {
  const m = report.latest;
  if (!m) return false;
  return m.leads > 0 || m.texts > 0 || m.calls > 0;
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export type LoadGrowthReportOptions = {
  client?: SupabaseClient;
  now?: Date;
  months?: number;
};

/**
 * Count new customer contacts in one month, routed to wherever the tenant's
 * contacts actually live.
 *
 * A head count, never a row fetch: the report needs "how many", and a
 * residency-moved tenant's rows are on their own box where fetching them all
 * would be both slow and pointless.
 */
async function countLeads(
  db: SupabaseClient,
  businessId: string,
  start: Date,
  end: Date,
  vpsReadMode: boolean
): Promise<number> {
  if (vpsReadMode) {
    return await countMovedRows(businessId, {
      table: "contacts",
      filters: [
        { column: "business_id", op: "eq", value: businessId },
        { column: "type", op: "eq", value: "customer" },
        { column: "created_at", op: "gte", value: start.toISOString() },
        { column: "created_at", op: "lt", value: end.toISOString() }
      ]
    });
  }
  const res = await db
    .from("contacts")
    .select("id", { count: "exact", head: true })
    .eq("business_id", businessId)
    .eq("type", "customer")
    .gte("created_at", start.toISOString())
    .lt("created_at", end.toISOString());
  if (res.error) throw new Error(`growth report contacts: ${res.error.message}`);
  return res.count ?? 0;
}

export async function loadGrowthReport(
  businessId: string,
  opts: LoadGrowthReportOptions = {}
): Promise<GrowthReport> {
  // NOT wrapped in `c8 ignore`: an AWAITED default defeats it, and worse, the
  // ignore swallows the statement AFTER it instead. The test mocks the module
  // and calls this with no client, which covers the arm honestly.
  // See .cursor/memory/feedback_c8_ignore_fails_on_awaited_default.md.
  const db = opts.client ?? (await createSupabaseServiceClient());
  const now = opts.now ?? new Date();
  const months = completeMonths(now, opts.months ?? DEFAULT_GROWTH_MONTHS);
  if (months.length === 0) {
    return composeGrowthReport({ months, snapshots: [], leadsByMonth: new Map() });
  }

  const windowStart = `${months[0]}-01`;
  // Exclusive upper bound: the first day of the month currently in progress.
  const windowEnd = monthStart(now).toISOString().slice(0, 10);

  const snapshotRes = await db
    .from("analytics_daily_snapshots")
    .select("snapshot_date, calls, sms_sent, voice_minutes")
    .eq("business_id", businessId)
    .gte("snapshot_date", windowStart)
    .lt("snapshot_date", windowEnd);
  if (snapshotRes.error) {
    throw new Error(`growth report snapshots: ${snapshotRes.error.message}`);
  }

  // Resolved once for every month rather than per query.
  const vpsReadMode = await isVpsReadMode(businessId, db);
  const leadsByMonth = new Map<string, number>();
  for (const month of months) {
    const start = new Date(`${month}-01T00:00:00.000Z`);
    const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
    leadsByMonth.set(month, await countLeads(db, businessId, start, end, vpsReadMode));
  }

  return composeGrowthReport({
    months,
    snapshots: (snapshotRes.data ?? []) as SnapshotRow[],
    leadsByMonth
  });
}
