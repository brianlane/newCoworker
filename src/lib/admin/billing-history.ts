/**
 * Month-by-month metered history for the admin Billing History page.
 *
 * The Usage page answers "what does this month look like?" for one month at a
 * time. This answers the question that one cannot: "which way is this going?"
 * The Telnyx spike of Aug 2026 ($30.78 -> $50.95) was invisible on a
 * single-month view for four weeks, because nothing put July and August side
 * by side per tenant.
 *
 * Every figure here is a MEASURED historical fact read from a day-keyed or
 * month-keyed table, never a re-derivation of a current-period cache:
 *
 * - texts and text units: `daily_usage` (`sms_sent` is a message count,
 *   `sms_text_units` is what the cap and the carrier actually bill)
 * - voice minutes and calls: `voice_settlements`, one row per settled call
 * - Telnyx cost: `telnyx_cost_daily`, the synced invoice-grade MDR aggregate
 * - Gemini cost: `gemini_spend_daily`, the day-keyed metered ledger
 * - revenue: `stripe_fee_monthly.charge_gross_cents`, real card charges only
 *
 * WHAT IS DELIBERATELY ABSENT: hosting. `hostinger_vps_costs` is a
 * full-replace snapshot with no history, so there is no honest per-month
 * hosting figure to show and the page says so rather than back-filling
 * today's fleet price across months that had a different fleet.
 *
 * Pure functions take rows in and give numbers out; the loader is the only
 * part that touches Supabase.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { listBusinesses, type BusinessRow } from "@/lib/db/businesses";
import { listTelnyxCostDaily, listStripeFeeMonthly } from "@/lib/db/platform-costs";
import { listGeminiSpendDaily } from "@/lib/db/gemini-spend";
import { listDailyUsageSince, listVoiceSettlementsSince } from "@/lib/db/usage";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

/** How many months the page shows by default, newest last. */
const DEFAULT_HISTORY_MONTHS = 12;

/** Micro-USD (1e-6 USD) per cent. */
const MICROS_PER_CENT = 10_000;

/** One tenant-month, or the fleet roll-up for that month. */
export type BillingHistoryCell = {
  /** Outbound messages, a message count (a 4-part text counts once). */
  messages: number;
  /** Billed SMS text units: what the carrier and the plan cap charge. */
  textUnits: number;
  voiceMinutes: number;
  calls: number;
  /** Telnyx spend in cents (the MDR cost already includes carrier fees). */
  telnyxCents: number;
  /** Metered Gemini spend in cents. */
  geminiCents: number;
  /** Card charges collected in that month, in cents. */
  revenueCents: number;
};

export type BillingHistoryRow = {
  /**
   * Stable identity for this series: the business id, or
   * {@link UNATTRIBUTED_KEY} for spend that matched no tenant at all.
   *
   * Carried separately from `business` because `business` is null in TWO
   * different situations, and collapsing them loses money. Telnyx MDRs that
   * matched no DID are genuinely unattributed; a `daily_usage` or
   * `gemini_spend_daily` row pointing at a business that is no longer in the
   * fleet list is a DELETED tenant, and there can be several of those. Keyed
   * only on `business`, every one of them rendered under one label, one React
   * key and one drill-in, so the per-tenant grid silently disagreed with the
   * fleet totals above it.
   */
  key: string;
  business: BusinessRow | null;
  /** Same length and order as the window's `months`. */
  cells: BillingHistoryCell[];
};

export type BillingHistory = {
  /** "YYYY-MM", oldest first. */
  months: string[];
  fleet: BillingHistoryCell[];
  /** One entry per business with any activity in the window, plus unattributed. */
  rows: BillingHistoryRow[];
  /**
   * True when the newest month is still in progress, so its column is a
   * partial month and must not be compared like-for-like with the one before.
   */
  newestMonthIsPartial: boolean;
  /** Fraction of the newest month elapsed (0-1], for the pro-rated projection. */
  newestMonthElapsed: number;
};

function emptyCell(): BillingHistoryCell {
  return {
    messages: 0,
    textUnits: 0,
    voiceMinutes: 0,
    calls: 0,
    telnyxCents: 0,
    geminiCents: 0,
    revenueCents: 0
  };
}

/** Vendor cost this page can actually source per month. Hosting is not in it. */
export function vendorCents(cell: BillingHistoryCell): number {
  return cell.telnyxCents + cell.geminiCents;
}

/** "2026-08" for a UTC instant. */
function monthKey(date: Date): string {
  return date.toISOString().slice(0, 7);
}

/** "2026-08" for a "YYYY-MM-DD" day string. */
function monthKeyOfYmd(ymd: string): string {
  return ymd.slice(0, 7);
}

/**
 * The window's month keys, oldest first, ending with the month `now` is in.
 * `count` is clamped to at least one month so a caller cannot ask for an
 * empty window and get a page with no columns.
 */
function historyMonths(now: Date, count: number): string[] {
  const wanted = Math.max(1, Math.trunc(count));
  const months: string[] = [];
  const cursor = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  for (let i = 0; i < wanted; i += 1) {
    months.push(monthKey(cursor));
    cursor.setUTCMonth(cursor.getUTCMonth() - 1);
  }
  return months.reverse();
}

/** First UTC day of the window, as "YYYY-MM-DD", for the `gte` reads. */
function windowStartYmd(months: string[]): string {
  return `${months[0]}-01`;
}

/**
 * How much of the newest month has elapsed, as a fraction in (0, 1].
 *
 * The current month is always short, so comparing it raw against a finished
 * month reads as a collapse in usage. The page pro-rates with this instead.
 */
function monthElapsedFraction(now: Date): number {
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  return (now.getTime() - start) / (end - start);
}

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

type DailyUsageInput = {
  business_id: string;
  usage_date: string;
  sms_sent: number | null;
  sms_text_units: number | null;
};

type VoiceSettlementInput = {
  business_id: string;
  created_at: string;
  billable_seconds: number | null;
};

type TelnyxCostInput = {
  business_id: string | null;
  day: string;
  cost_micros: number;
};

type GeminiSpendInput = {
  business_id: string;
  day: string;
  cost_micros: number;
};

type StripeFeeInput = {
  business_id: string | null;
  month_start: string;
  charge_gross_cents: number;
};

type ComposeBillingHistoryInput = {
  months: string[];
  businesses: BusinessRow[];
  usage: DailyUsageInput[];
  voice: VoiceSettlementInput[];
  telnyx: TelnyxCostInput[];
  gemini: GeminiSpendInput[];
  stripe: StripeFeeInput[];
  now: Date;
};

/**
 * The key an unattributed row files under. Telnyx MDRs that match no tenant
 * DID and Stripe charges with no known customer are real money, so they get a
 * row of their own rather than being dropped or silently folded into a tenant.
 */
export const UNATTRIBUTED_KEY = "__unattributed__";

/**
 * Fold every source into one months-by-tenant grid.
 *
 * A business with no activity anywhere in the window is omitted: the fleet has
 * had tenants that never sent anything, and a page of zero rows buries the
 * ones that moved.
 */
function composeBillingHistory(input: ComposeBillingHistoryInput): BillingHistory {
  const { months } = input;
  const index = new Map(months.map((m, i) => [m, i]));
  const grid = new Map<string, BillingHistoryCell[]>();

  const cellFor = (businessId: string, month: string): BillingHistoryCell | null => {
    const i = index.get(month);
    if (i === undefined) return null;
    let cells = grid.get(businessId);
    if (!cells) {
      cells = months.map(() => emptyCell());
      grid.set(businessId, cells);
    }
    return cells[i]!;
  };

  for (const row of input.usage) {
    const cell = cellFor(row.business_id, monthKeyOfYmd(row.usage_date));
    if (!cell) continue;
    cell.messages += Number(row.sms_sent ?? 0);
    cell.textUnits += Number(row.sms_text_units ?? 0);
  }

  for (const row of input.voice) {
    const cell = cellFor(row.business_id, row.created_at.slice(0, 7));
    if (!cell) continue;
    cell.voiceMinutes += Number(row.billable_seconds ?? 0) / 60;
    cell.calls += 1;
  }

  for (const row of input.telnyx) {
    const cell = cellFor(row.business_id ?? UNATTRIBUTED_KEY, monthKeyOfYmd(row.day));
    if (!cell) continue;
    cell.telnyxCents += Number(row.cost_micros) / MICROS_PER_CENT;
  }

  for (const row of input.gemini) {
    const cell = cellFor(row.business_id, monthKeyOfYmd(row.day));
    if (!cell) continue;
    cell.geminiCents += Number(row.cost_micros) / MICROS_PER_CENT;
  }

  for (const row of input.stripe) {
    const cell = cellFor(row.business_id ?? UNATTRIBUTED_KEY, monthKeyOfYmd(row.month_start));
    if (!cell) continue;
    cell.revenueCents += Number(row.charge_gross_cents);
  }

  const byId = new Map(input.businesses.map((b) => [b.id, b]));
  const rows: BillingHistoryRow[] = [...grid.entries()]
    .map(([key, cells]) => ({ key, business: byId.get(key) ?? null, cells }))
    .sort((a, b) => {
      // Biggest current vendor spend first: the reason to open this page is
      // usually "who is costing us more than last month".
      const spend = (r: BillingHistoryRow): number => vendorCents(r.cells[r.cells.length - 1]!);
      // A row with no business row has no name, so it sorts to the top of a
      // tie. Falling back to the KEY rather than "" keeps two different
      // unmatched ids in a stable, distinguishable order instead of an
      // arbitrary one.
      const name = (r: BillingHistoryRow): string => r.business?.name ?? r.key;
      return spend(b) - spend(a) || name(a).localeCompare(name(b));
    });

  const fleet = months.map((_, i) =>
    rows.reduce<BillingHistoryCell>((sum, row) => {
      const cell = row.cells[i]!;
      return {
        messages: sum.messages + cell.messages,
        textUnits: sum.textUnits + cell.textUnits,
        voiceMinutes: sum.voiceMinutes + cell.voiceMinutes,
        calls: sum.calls + cell.calls,
        telnyxCents: sum.telnyxCents + cell.telnyxCents,
        geminiCents: sum.geminiCents + cell.geminiCents,
        revenueCents: sum.revenueCents + cell.revenueCents
      };
    }, emptyCell())
  );

  return {
    months,
    fleet,
    rows,
    newestMonthIsPartial: months[months.length - 1] === monthKey(input.now),
    newestMonthElapsed: monthElapsedFraction(input.now)
  };
}

// ---------------------------------------------------------------------------
// Trends
// ---------------------------------------------------------------------------

export type Trend = {
  previous: number;
  current: number;
  /**
   * `current` scaled to a whole month when the newest column is still in
   * progress, so the comparison is like-for-like. Equal to `current` on a
   * finished month.
   */
  projected: number;
  /** Percent change of `projected` against `previous`, or null when previous is 0. */
  changePct: number | null;
};

/**
 * Compare the newest month against the one before it.
 *
 * The pro-rating is the load-bearing part. On Aug 28 2026 Amy's Telnyx column
 * read $31.78 against July's $15.98, which is already alarming, but the honest
 * comparison is the projected $35.19: three days of the month had not happened
 * yet. Without this the page understates every live month by design.
 *
 * `changePct` is null rather than Infinity when the previous month is zero:
 * "up 3200%" from one cent is noise, and a null renders as "new".
 */
export function trendFor(
  series: number[],
  opts: { partial: boolean; elapsed: number }
): Trend {
  const current = series[series.length - 1] ?? 0;
  const previous = series[series.length - 2] ?? 0;
  // A zero elapsed fraction is not reachable from a real clock (the first
  // instant of a month is still > 0), but guarding it keeps a divide-by-zero
  // out of a page that renders money.
  const scale = opts.partial && opts.elapsed > 0 ? 1 / opts.elapsed : 1;
  const projected = current * scale;
  return {
    previous,
    current,
    projected,
    changePct: previous === 0 ? null : ((projected - previous) / previous) * 100
  };
}

/** Pull one metric out of a series of cells, for `trendFor` and sparklines. */
export function seriesOf(
  cells: BillingHistoryCell[],
  metric: (cell: BillingHistoryCell) => number
): number[] {
  return cells.map(metric);
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export type LoadBillingHistoryDeps = {
  client?: SupabaseClient;
  now?: Date;
  months?: number;
  loadBusinesses?: typeof listBusinesses;
  loadUsage?: typeof listDailyUsageSince;
  loadVoice?: typeof listVoiceSettlementsSince;
  loadTelnyx?: typeof listTelnyxCostDaily;
  loadGemini?: typeof listGeminiSpendDaily;
  loadStripe?: typeof listStripeFeeMonthly;
};

/**
 * Read the whole window ONCE per source and bucket in memory.
 *
 * The alternative, calling the existing single-month rollup twelve times, is
 * twelve round trips per source on a page a human is waiting for. Each of
 * these readers already pages past the PostgREST 1000-row cap.
 */
export async function loadBillingHistory(
  deps: LoadBillingHistoryDeps = {}
): Promise<BillingHistory> {
  /* c8 ignore start -- production defaults; unit tests inject every reader */
  const client = deps.client;
  const loadBusinesses = deps.loadBusinesses ?? listBusinesses;
  const loadUsage = deps.loadUsage ?? listDailyUsageSince;
  const loadVoice = deps.loadVoice ?? listVoiceSettlementsSince;
  const loadTelnyx = deps.loadTelnyx ?? listTelnyxCostDaily;
  const loadGemini = deps.loadGemini ?? listGeminiSpendDaily;
  const loadStripe = deps.loadStripe ?? listStripeFeeMonthly;
  /* c8 ignore stop */
  const now = deps.now ?? new Date();
  const months = historyMonths(now, deps.months ?? DEFAULT_HISTORY_MONTHS);
  const startYmd = windowStartYmd(months);

  const [businesses, usage, voice, telnyx, gemini, stripe] = await Promise.all([
    loadBusinesses(client),
    loadUsage(startYmd, client),
    loadVoice(`${startYmd}T00:00:00.000Z`, client),
    loadTelnyx(startYmd, client),
    loadGemini(startYmd, client),
    // Stripe rows are keyed to the first of the month, so the same day string
    // is already the right lower bound.
    loadStripe(startYmd, client)
  ]);

  return composeBillingHistory({
    months,
    businesses,
    usage,
    voice,
    telnyx,
    gemini,
    stripe,
    now
  });
}
