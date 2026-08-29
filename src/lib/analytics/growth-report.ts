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
const DEFAULT_GROWTH_MONTHS = 6;

/** Fewest complete months before a forward projection is honest. */
const MIN_MONTHS_FOR_TREND = 3;

/**
 * A tenant with no calls and no texts in this many trailing days has stopped
 * using the product. Sending them a cheerful summary of a month they have
 * since abandoned is the wrong message at the wrong time, and it is the kind
 * of email that gets a product marked as spam.
 *
 * Measured from the send date, so it OVERLAPS the reported month: a tenant who
 * was busy all August is active on Sep 3 by construction. What it actually
 * catches is the tenant who was busy early in the month and then stopped.
 */
const RECAP_DORMANT_DAYS = 30;

/**
 * Below this many days of snapshot coverage the reported month is a sample,
 * not a month, and a "recap" of it would overstate what we know.
 */
const RECAP_MIN_COVERED_DAYS = 7;

/**
 * Fewest leads + texts + calls in the reported month worth an email. Under
 * this, a table of near-zeros tells the owner less than the silence does, and
 * it invites the reasonable question of why we bothered.
 */
const RECAP_MIN_MONTH_EVENTS = 5;

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
  /**
   * Any calls or texts in the {@link RECAP_DORMANT_DAYS} days before `now`.
   *
   * Snapshot-derived, so a lead captured with neither a message nor a call
   * does not count. That is rare in practice (the coworker texts a new lead)
   * and the failure is in the safe direction: a quiet tenant is not emailed.
   */
  recentlyActive: boolean;
};

function daysInMonth(month: string): number {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y!, m!, 0)).getUTCDate();
}

/**
 * The complete months ending with the one BEFORE `now`'s month, oldest first.
 *
 * Called on Sep 2 2026 with count 3 this gives June, July, August: the month
 * in progress is never in the list.
 */
function completeMonths(now: Date, count: number): string[] {
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
function linearFit(values: number[]): { slope: number; intercept: number } {
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
function projectNextMonth(values: number[]): number | null {
  if (values.length < MIN_MONTHS_FOR_TREND) return null;
  const { slope, intercept } = linearFit(values);
  return Math.max(0, Math.round(intercept + slope * values.length));
}

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

type SnapshotRow = {
  snapshot_date: string;
  calls: number | null;
  sms_sent: number | null;
  voice_minutes: number | null;
};

type ComposeGrowthReportInput = {
  /** Now, for the trailing-activity window. */
  now: Date;
  /**
   * One entry per month in the window, oldest first, with `leads` and
   * `daysInMonth` already filled and the snapshot counters at zero.
   *
   * Seeded by the caller rather than looked up here: a map lookup would need a
   * fallback for a month the caller forgot, which the caller cannot forget
   * (it builds both from the same list), and an unreachable fallback is a
   * branch nothing can test.
   */
  seeded: GrowthMonth[];
  snapshots: SnapshotRow[];
};

/** Fold snapshot days into the seeded months. */
function composeGrowthReport(input: ComposeGrowthReportInput): GrowthReport {
  const byMonth = new Map<string, GrowthMonth>(input.seeded.map((m) => [m.month, m]));
  // Days on or after this are the "still using it?" window. It reaches past
  // the reported month into the days since, which is the whole point.
  const dormantCutoff = new Date(input.now.getTime() - RECAP_DORMANT_DAYS * 86_400_000)
    .toISOString()
    .slice(0, 10);
  let recentlyActive = false;

  for (const row of input.snapshots) {
    const calls = Number(row.calls ?? 0);
    const texts = Number(row.sms_sent ?? 0);
    if (row.snapshot_date >= dormantCutoff && calls + texts > 0) recentlyActive = true;
    const entry = byMonth.get(row.snapshot_date.slice(0, 7));
    if (!entry) continue;
    entry.calls += calls;
    entry.texts += texts;
    entry.voiceMinutes += Number(row.voice_minutes ?? 0);
    entry.coveredDays += 1;
  }

  // Drop months nobody was measuring (rule 4 above). Leads would survive for
  // such a month (they come from `contacts`, not the snapshots), which is
  // exactly what makes the mixed row dangerous: a real lead count beside a
  // fabricated zero for texts and calls reads as a catastrophic month.
  const months = input.seeded.filter((m) => m.coveredDays > 0);
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
    latestMonthIncomplete: latest !== null && latest.coveredDays < latest.daysInMonth,
    recentlyActive
  };
}

/**
 * Whether this tenant should get a recap at all, and if not, why.
 *
 * Three different "no"s, kept apart because they mean different things to
 * whoever reads the sweep's summary:
 *
 * - `no_month`: nothing measured has finished yet. A tenant in their first
 *   calendar month, or one whose snapshots do not reach back far enough.
 * - `dormant`: they have not made a call or sent a text in
 *   RECAP_DORMANT_DAYS. They stopped, and a summary of a month they have
 *   since abandoned is the wrong message.
 * - `thin`: the month is measured but there is not enough in it to be worth
 *   an email, either because coverage is too short to represent a month or
 *   because almost nothing happened in it.
 */
/**
 * Derived figures the recap uses to show growth rather than just this month.
 *
 * Computed from the measured months only, which is what makes them safe to
 * put in front of a customer: a window that starts where the snapshots start
 * cannot quietly count a period nobody measured as a zero and turn it into
 * dramatic growth.
 */
export type GrowthStats = {
  /** Totals across every measured month in the window. */
  totals: { leads: number; texts: number; calls: number; voiceMinutes: number };
  /** How many months are actually measured, which is what "since" refers to. */
  measuredMonths: number;
  /** The most leads any measured month saw, for scaling a bar chart. */
  peakLeads: number;
  /** True when the reported month is the best month for leads so far. */
  latestIsBestForLeads: boolean;
  /**
   * Percent change in leads from the FIRST measured month to the latest.
   * Null when there is only one month, or when the first month was zero (an
   * "up from nothing" percentage is noise, not news).
   */
  leadsGrowthPct: number | null;
};

export function growthStats(report: GrowthReport): GrowthStats {
  const months = report.months;
  const totals = months.reduce(
    (t, m) => ({
      leads: t.leads + m.leads,
      texts: t.texts + m.texts,
      calls: t.calls + m.calls,
      voiceMinutes: t.voiceMinutes + m.voiceMinutes
    }),
    { leads: 0, texts: 0, calls: 0, voiceMinutes: 0 }
  );
  const leadCounts = months.map((m) => m.leads);
  const peakLeads = leadCounts.reduce((a, b) => (b > a ? b : a), 0);
  const first = months[0];
  const latest = report.latest;
  return {
    totals,
    measuredMonths: months.length,
    peakLeads,
    // ">= peak" not "=== peak": a tie means this month matched the best, and
    // for a customer reading it that is still their best month.
    latestIsBestForLeads: latest !== null && months.length > 1 && latest.leads >= peakLeads && peakLeads > 0,
    leadsGrowthPct:
      first && latest && months.length > 1 && first.leads > 0
        ? ((latest.leads - first.leads) / first.leads) * 100
        : null
  };
}

export type RecapVerdict = "send" | "no_month" | "dormant" | "thin";

export function classifyRecap(report: GrowthReport): RecapVerdict {
  const m = report.latest;
  if (!m) return "no_month";
  if (!report.recentlyActive) return "dormant";
  if (m.coveredDays < RECAP_MIN_COVERED_DAYS) return "thin";
  if (m.leads + m.texts + m.calls < RECAP_MIN_MONTH_EVENTS) return "thin";
  return "send";
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
    return composeGrowthReport({ now, seeded: [], snapshots: [] });
  }

  const windowStart = `${months[0]}-01`;
  // Deliberately NOT capped at the start of the current month. Days since the
  // month ended are what answer "are they still using this?", and the fold
  // below ignores any day outside the reported months anyway.
  const snapshotRes = await db
    .from("analytics_daily_snapshots")
    .select("snapshot_date, calls, sms_sent, voice_minutes")
    .eq("business_id", businessId)
    .gte("snapshot_date", windowStart);
  if (snapshotRes.error) {
    throw new Error(`growth report snapshots: ${snapshotRes.error.message}`);
  }

  // Resolved once for every month rather than per query.
  const vpsReadMode = await isVpsReadMode(businessId, db);
  const seeded: GrowthMonth[] = [];
  for (const month of months) {
    const start = new Date(`${month}-01T00:00:00.000Z`);
    const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
    seeded.push({
      month,
      leads: await countLeads(db, businessId, start, end, vpsReadMode),
      texts: 0,
      calls: 0,
      voiceMinutes: 0,
      coveredDays: 0,
      daysInMonth: daysInMonth(month)
    });
  }

  return composeGrowthReport({
    now,
    seeded,
    snapshots: (snapshotRes.data ?? []) as SnapshotRow[]
  });
}
