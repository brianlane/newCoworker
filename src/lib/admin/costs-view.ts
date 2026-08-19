/**
 * Pure view-model builders for the admin Costs page (/admin/costs): vendor
 * KPI roll-ups, the monthly Telnyx trend, the renewal calendar (Hostinger
 * box renewals + Stripe term rollovers, both money moments), and the
 * idle-pool burn table. All inputs are prefetched rows; nothing here
 * touches the network or bills anyone.
 */

import type { HostingerVpsCostRow, TelnyxCostDailyRow } from "@/lib/db/platform-costs";
import type { VpsInventoryRow } from "@/lib/db/vps-inventory";
import type { BusinessMarginEconomics, MarginLineKey } from "@/lib/admin/margin";
import { getPeriodPricing } from "@/lib/plans/tier";
import type { BillingPeriod, PlanTier } from "@/lib/plans/tier";
import { HOSTING_MONTHLY_CENTS_BY_SIZE } from "@/lib/plans/enterprise-pricing";
import { isVpsSize } from "@/lib/vps/size";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Fleet-wide cost per margin-line key (cents), summed across all businesses. */
export function sumMarginLinesByKey(
  economics: BusinessMarginEconomics[]
): Record<MarginLineKey, number> {
  const totals: Record<MarginLineKey, number> = {
    hosting: 0,
    did: 0,
    telnyx_usage: 0,
    gemini_chat: 0,
    stripe_fees: 0
  };
  for (const business of economics) {
    for (const line of business.lines) {
      totals[line.key] += line.cents;
    }
  }
  return totals;
}

export type TelnyxMonthPoint = {
  /** YYYY-MM */
  month: string;
  costMicros: number;
  messagingCount: number;
  voiceMinutes: number;
};

/** Synced Telnyx rows rolled up per calendar month, oldest first. */
export function telnyxMonthlyTrend(rows: TelnyxCostDailyRow[]): TelnyxMonthPoint[] {
  const byMonth = new Map<string, TelnyxMonthPoint>();
  for (const row of rows) {
    const month = row.day.slice(0, 7);
    let point = byMonth.get(month);
    if (!point) {
      point = { month, costMicros: 0, messagingCount: 0, voiceMinutes: 0 };
      byMonth.set(month, point);
    }
    point.costMicros += row.cost_micros;
    if (row.record_type === "messaging") point.messagingCount += row.record_count;
    else point.voiceMinutes += row.billed_seconds / 60;
  }
  return [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month));
}

export type TelnyxDirectionSummary = {
  recordType: "messaging" | "sip-trunking";
  direction: string;
  records: number;
  costMicros: number;
  carrierFeeMicros: number;
  voiceMinutes: number;
  /** Portion of costMicros on rows attributed to no tenant DID. */
  unattributedMicros: number;
};

/** This window's Telnyx rows summarized per record type + direction. */
export function telnyxDirectionSummary(rows: TelnyxCostDailyRow[]): TelnyxDirectionSummary[] {
  const byKey = new Map<string, TelnyxDirectionSummary>();
  for (const row of rows) {
    const key = `${row.record_type}|${row.direction}`;
    let summary = byKey.get(key);
    if (!summary) {
      summary = {
        recordType: row.record_type,
        direction: row.direction,
        records: 0,
        costMicros: 0,
        carrierFeeMicros: 0,
        voiceMinutes: 0,
        unattributedMicros: 0
      };
      byKey.set(key, summary);
    }
    summary.records += row.record_count;
    summary.costMicros += row.cost_micros;
    summary.carrierFeeMicros += row.carrier_fee_micros;
    summary.voiceMinutes += row.billed_seconds / 60;
    if (row.business_id === null) summary.unattributedMicros += row.cost_micros;
  }
  return [...byKey.values()].sort(
    (a, b) =>
      a.recordType.localeCompare(b.recordType) || a.direction.localeCompare(b.direction)
  );
}

export type TelnyxUsageWindowKey = "7d" | "14d" | "30d" | "90d";

export const TELNYX_USAGE_WINDOW_KEYS: TelnyxUsageWindowKey[] = ["7d", "14d", "30d", "90d"];

const TELNYX_USAGE_WINDOW_DAYS: Record<TelnyxUsageWindowKey, number> = {
  "7d": 7,
  "14d": 14,
  "30d": 30,
  "90d": 90
};

/** The window a `?window=` query param selects; invalid values fall back to 14d. */
export function resolveTelnyxUsageWindowKey(raw: string | undefined): TelnyxUsageWindowKey {
  return (TELNYX_USAGE_WINDOW_KEYS as string[]).includes(raw ?? "")
    ? (raw as TelnyxUsageWindowKey)
    : "14d";
}

export type TelnyxUsageWindow = {
  key: TelnyxUsageWindowKey;
  /** Inclusive UTC start day. */
  startYmd: string;
  /** Exclusive UTC end day (tomorrow, so today's partial day is included). */
  endYmdExclusive: string;
};

function ymd(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Rolling UTC calendar-day window for a key, ending tomorrow (exclusive). */
export function telnyxUsageWindow(key: TelnyxUsageWindowKey, now: Date): TelnyxUsageWindow {
  const todayMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return {
    key,
    startYmd: ymd(todayMs - (TELNYX_USAGE_WINDOW_DAYS[key] - 1) * DAY_MS),
    endYmdExclusive: ymd(todayMs + DAY_MS)
  };
}

function inUsageWindow(day: string, window: TelnyxUsageWindow): boolean {
  return day >= window.startYmd && day < window.endYmdExclusive;
}

/**
 * Series keys for the two non-tenant stack buckets. Business ids are uuids,
 * so these literals can never collide with a real tenant's key.
 */
export const TELNYX_SERIES_OTHER = "other";
export const TELNYX_SERIES_UNATTRIBUTED = "unattributed";

/** Tenants ranked past this many fold into the "other" series. */
const TELNYX_TOP_TENANT_SERIES = 7;

export type TelnyxDailySeriesEntry = {
  /** A business uuid, TELNYX_SERIES_OTHER, or TELNYX_SERIES_UNATTRIBUTED. */
  seriesKey: string;
  totalMicros: number;
};

export type TelnyxDailyPoint = {
  day: string;
  costMicros: number;
  /** Nonzero stack segments, always in fixed series order. */
  segments: Array<{ seriesKey: string; costMicros: number }>;
};

export type TelnyxDailySeries = {
  /** Every day in the window (zero days included), oldest first. */
  points: TelnyxDailyPoint[];
  /** Stack + legend order: tenants by window spend, then other, then unattributed. */
  series: TelnyxDailySeriesEntry[];
  maxMicros: number;
  totalMicros: number;
};

/**
 * Per-day Telnyx cost stacked per tenant within the window. Unlike the
 * Gemini chart's per-day size sort, segments keep the series order on every
 * day, so a tenant holds one color and position across the whole chart and
 * a burn spike reads as a band growing, not colors trading places.
 */
export function buildTelnyxDailySeries(
  rows: TelnyxCostDailyRow[],
  window: TelnyxUsageWindow
): TelnyxDailySeries {
  const totalsByBusiness = new Map<string, number>();
  let unattributedTotal = 0;
  const byDay = new Map<string, Map<string, number>>();
  for (const row of rows) {
    if (!inUsageWindow(row.day, window)) continue;
    const rawKey = row.business_id ?? TELNYX_SERIES_UNATTRIBUTED;
    if (row.business_id === null) {
      unattributedTotal += row.cost_micros;
    } else {
      totalsByBusiness.set(
        row.business_id,
        (totalsByBusiness.get(row.business_id) ?? 0) + row.cost_micros
      );
    }
    let perKey = byDay.get(row.day);
    if (!perKey) {
      perKey = new Map();
      byDay.set(row.day, perKey);
    }
    perKey.set(rawKey, (perKey.get(rawKey) ?? 0) + row.cost_micros);
  }

  // Rank by window spend; ties settle by id so colors stay stable across
  // reloads. Everything past the top ranks folds into "other".
  const ranked = [...totalsByBusiness.entries()].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0])
  );
  const seriesKeyByBusiness = new Map<string, string>();
  for (const [index, [businessId]] of ranked.entries()) {
    seriesKeyByBusiness.set(
      businessId,
      index < TELNYX_TOP_TENANT_SERIES ? businessId : TELNYX_SERIES_OTHER
    );
  }
  const otherTotal = ranked
    .slice(TELNYX_TOP_TENANT_SERIES)
    .reduce((sum, [, micros]) => sum + micros, 0);

  const series: TelnyxDailySeriesEntry[] = ranked
    .slice(0, TELNYX_TOP_TENANT_SERIES)
    .filter(([, micros]) => micros > 0)
    .map(([businessId, micros]) => ({ seriesKey: businessId, totalMicros: micros }));
  if (otherTotal > 0) {
    series.push({ seriesKey: TELNYX_SERIES_OTHER, totalMicros: otherTotal });
  }
  if (unattributedTotal > 0) {
    series.push({ seriesKey: TELNYX_SERIES_UNATTRIBUTED, totalMicros: unattributedTotal });
  }

  const points: TelnyxDailyPoint[] = [];
  let maxMicros = 0;
  let totalMicros = 0;
  for (let ms = Date.parse(window.startYmd); ymd(ms) < window.endYmdExclusive; ms += DAY_MS) {
    const day = ymd(ms);
    const perKey = byDay.get(day) ?? new Map<string, number>();
    const bySeries = new Map<string, number>();
    for (const [rawKey, micros] of perKey) {
      const seriesKey =
        rawKey === TELNYX_SERIES_UNATTRIBUTED ? rawKey : (seriesKeyByBusiness.get(rawKey) as string);
      bySeries.set(seriesKey, (bySeries.get(seriesKey) ?? 0) + micros);
    }
    const segments = series
      .map((entry) => ({
        seriesKey: entry.seriesKey,
        costMicros: bySeries.get(entry.seriesKey) ?? 0
      }))
      .filter((segment) => segment.costMicros > 0);
    const costMicros = segments.reduce((sum, s) => sum + s.costMicros, 0);
    maxMicros = Math.max(maxMicros, costMicros);
    totalMicros += costMicros;
    points.push({ day, costMicros, segments });
  }
  return { points, series, maxMicros, totalMicros };
}

export type TelnyxTenantWindowRow = {
  /** null = matched no tenant DID (platform traffic, leak, or deleted tenant). */
  businessId: string | null;
  totalMicros: number;
  carrierFeeMicros: number;
  messagingMicros: number;
  messagingCount: number;
  voiceMicros: number;
  voiceMinutes: number;
  /** Integer percent of the window total; null when the window total is 0. */
  sharePct: number | null;
};

export type TelnyxTenantWindowBreakdown = {
  /** Biggest spender first; ties put the unattributed row last, then id order. */
  tenants: TelnyxTenantWindowRow[];
  totalMicros: number;
  /** False when the sync has no rows at all inside the window. */
  hasRows: boolean;
};

/** Per-tenant usage + cost rollup within the window, unattributed included. */
export function buildTelnyxTenantWindowBreakdown(
  rows: TelnyxCostDailyRow[],
  window: TelnyxUsageWindow
): TelnyxTenantWindowBreakdown {
  const byBusiness = new Map<string | null, TelnyxTenantWindowRow>();
  let totalMicros = 0;
  for (const row of rows) {
    if (!inUsageWindow(row.day, window)) continue;
    let tenant = byBusiness.get(row.business_id);
    if (!tenant) {
      tenant = {
        businessId: row.business_id,
        totalMicros: 0,
        carrierFeeMicros: 0,
        messagingMicros: 0,
        messagingCount: 0,
        voiceMicros: 0,
        voiceMinutes: 0,
        sharePct: null
      };
      byBusiness.set(row.business_id, tenant);
    }
    tenant.totalMicros += row.cost_micros;
    tenant.carrierFeeMicros += row.carrier_fee_micros;
    if (row.record_type === "messaging") {
      tenant.messagingMicros += row.cost_micros;
      tenant.messagingCount += row.record_count;
    } else {
      tenant.voiceMicros += row.cost_micros;
      tenant.voiceMinutes += row.billed_seconds / 60;
    }
    totalMicros += row.cost_micros;
  }
  const tenants = [...byBusiness.values()]
    .map((tenant) => ({
      ...tenant,
      sharePct: totalMicros > 0 ? Math.round((tenant.totalMicros / totalMicros) * 100) : null
    }))
    .sort(
      (a, b) =>
        b.totalMicros - a.totalMicros ||
        (a.businessId === null
          ? 1
          : b.businessId === null
            ? -1
            : a.businessId.localeCompare(b.businessId))
    );
  return { tenants, totalMicros, hasRows: tenants.length > 0 };
}

export type UnattributedSender = {
  /** Raw Telnyx sender id (a number, or something like an RCS agent id); null for rows synced before the column existed. */
  sender: string | null;
  /** Set when the sender is the platform's own and can never match a tenant DID; null means worth chasing. */
  platformLabel: string | null;
  costMicros: number;
  recordCount: number;
};

/**
 * The platform's own Telnyx senders, which can never match a tenant DID.
 * Kept here so a recurring platform sender renders with its role instead of
 * reading as a fresh leak: the bare "+16028384497" row was chased as a
 * leaked number on 2026-08-19, and it was our own two test SMS.
 */
const PLATFORM_SENDER_LABELS: ReadonlyMap<string, string> = new Map([
  // Ordered as the dedicated P2P international SMS gateway on 2026-08-06 and
  // released the same day, after Telnyx ruled US long codes domestic-only.
  ["+16028384497", "retired intl SMS gateway (released Aug 6 2026)"],
  // RCS traffic bills against the agent id, not a phone number, so the
  // digits-only DID matcher can never attribute it.
  ["new_coworker_jut3q1af_agent", "RCS agent id"]
]);

/**
 * Unattributed Telnyx spend grouped by the sender that spent it, biggest
 * first (ties broken by sender so the order is stable, unnamed last).
 *
 * Callers pass rows already narrowed to the period they are reporting on.
 * Rows with a `business_id` are skipped: those are attributed, and their
 * sender is the tenant's own DID.
 *
 * This exists because a bare "$0.03 matched no tenant DID" is unactionable.
 * Known platform senders carry their role as `platformLabel`; anything
 * unlabeled is a genuine leak worth chasing.
 */
export function buildUnattributedSenders(rows: TelnyxCostDailyRow[]): UnattributedSender[] {
  const bySender = new Map<string | null, UnattributedSender>();
  for (const row of rows) {
    if (row.business_id !== null) continue;
    const sender = row.sender ?? null;
    let entry = bySender.get(sender);
    if (!entry) {
      entry = {
        sender,
        platformLabel: sender === null ? null : (PLATFORM_SENDER_LABELS.get(sender) ?? null),
        costMicros: 0,
        recordCount: 0
      };
      bySender.set(sender, entry);
    }
    entry.costMicros += row.cost_micros;
    entry.recordCount += row.record_count;
  }
  return [...bySender.values()].sort(
    (a, b) =>
      b.costMicros - a.costMicros ||
      (a.sender === null
        ? 1
        : b.sender === null
          ? -1
          : a.sender.localeCompare(b.sender))
  );
}

export type RenewalEvent = {
  kind: "hostinger_renewal" | "hostinger_lapse" | "term_rollover";
  at: string;
  daysAway: number;
  label: string;
  detail: string;
  /** Monthly money at stake: renewal price for boxes, rate delta for rollovers. */
  monthlyCents: number | null;
  businessId: string | null;
};

export type RenewalCalendarSubscription = {
  business_id: string;
  tier: PlanTier;
  status: string;
  stripe_subscription_id: string | null;
  billing_period: BillingPeriod | null;
  renewal_at: string | null;
};

/**
 * Upcoming money moments within `horizonDays`, soonest first:
 * - Hostinger box renewals (spend continues) and lapses (box disappears,
 *   a problem if a tenant is on it, the plan if it's pooled).
 * - Stripe term rollovers: an active 12/24-month contract passing
 *   `renewal_at` rolls to the HIGHER month-to-month renewal rate unless
 *   auto-renew re-commits, revenue upside either way, worth watching.
 */
export function buildRenewalCalendar(params: {
  hostingerRows: HostingerVpsCostRow[];
  subscriptions: RenewalCalendarSubscription[];
  businessNames: Map<string, string>;
  now: Date;
  horizonDays?: number;
}): RenewalEvent[] {
  const horizonDays = params.horizonDays ?? 90;
  const nowMs = params.now.getTime();
  const horizonMs = nowMs + horizonDays * DAY_MS;
  const events: RenewalEvent[] = [];

  const nameOf = (businessId: string | null): string =>
    businessId === null
      ? "unassigned"
      : (params.businessNames.get(businessId) ?? `${businessId.slice(0, 8)}…`);

  for (const row of params.hostingerRows) {
    // Same not-renewing rule as the Costs fleet table and the
    // billing-posture cron: an explicit auto-renew=false OR a terminal
    // status wins; a null flag on a live subscription counts as renewing.
    const lapsing =
      row.is_auto_renewed === false ||
      row.status === "non_renewing" ||
      row.status === "cancelled";
    const renewing = !lapsing;
    const at = renewing ? row.next_billing_at : (row.expires_at ?? row.next_billing_at);
    const atMs = at !== null ? Date.parse(at) : Number.NaN;
    if (!Number.isFinite(atMs) || atMs < nowMs || atMs > horizonMs) continue;
    const box = row.hostname ?? `VM ${row.vm_id ?? "?"}`;
    events.push({
      kind: renewing ? "hostinger_renewal" : "hostinger_lapse",
      at: at as string,
      daysAway: Math.ceil((atMs - nowMs) / DAY_MS),
      label: renewing ? `${box} renews` : `${box} lapses`,
      detail: renewing
        ? `${row.plan ?? "VPS"} · ${nameOf(row.assigned_business_id)}`
        : `${row.plan ?? "VPS"} · ${nameOf(row.assigned_business_id)} · auto-renew off`,
      monthlyCents: row.monthly_price_cents,
      businessId: row.assigned_business_id
    });
  }

  for (const sub of params.subscriptions) {
    if (
      sub.status !== "active" ||
      sub.stripe_subscription_id === null ||
      sub.tier === "enterprise" ||
      sub.billing_period === null ||
      sub.billing_period === "monthly" ||
      sub.renewal_at === null
    ) {
      continue;
    }
    const atMs = Date.parse(sub.renewal_at);
    if (!Number.isFinite(atMs) || atMs < nowMs || atMs > horizonMs) continue;
    const pricing = getPeriodPricing(sub.tier, sub.billing_period);
    events.push({
      kind: "term_rollover",
      at: sub.renewal_at,
      daysAway: Math.ceil((atMs - nowMs) / DAY_MS),
      label: `${nameOf(sub.business_id)} contract ends`,
      detail: `${sub.tier} ${sub.billing_period} → month-to-month at the renewal rate (or re-commits)`,
      monthlyCents: pricing.renewalMonthlyCents - pricing.monthlyCents,
      businessId: sub.business_id
    });
  }

  return events.sort((a, b) => a.at.localeCompare(b.at));
}

export type PoolBoxBurn = {
  vmId: number;
  hostname: string | null;
  plan: string;
  /** What the idle box costs while parked (synced price, else the SKU table). */
  monthlyCents: number | null;
  monthlySource: "actual" | "estimate";
  autoRenew: boolean | null;
  /** When the box lapses/renews; null when the billing row is unknown. */
  endsAt: string | null;
  daysLeft: number | null;
};

/** Idle (available) pool boxes with their carrying cost and lapse clock. */
export function buildPoolBoxBurn(params: {
  inventory: VpsInventoryRow[];
  hostingerRows: HostingerVpsCostRow[];
  now: Date;
}): PoolBoxBurn[] {
  const byVm = new Map<number, HostingerVpsCostRow>();
  const bySubscription = new Map<string, HostingerVpsCostRow>();
  for (const row of params.hostingerRows) {
    if (row.vm_id !== null) byVm.set(row.vm_id, row);
    bySubscription.set(row.subscription_id, row);
  }
  const nowMs = params.now.getTime();

  const burn: PoolBoxBurn[] = [];
  for (const box of params.inventory) {
    if (box.state !== "available") continue;
    // The VM join can miss (Hostinger drops the VM once it's deleted while
    // the billing row lingers); the inventory's own subscription id is the
    // fallback so cancelled/lapsing billing still resolves.
    const billing =
      byVm.get(box.vm_id) ??
      (box.hostinger_billing_subscription_id !== null
        ? (bySubscription.get(box.hostinger_billing_subscription_id) ?? null)
        : null);
    // A cancelled billing subscription recurs nothing, the box is sunk
    // cost until it lapses, not monthly burn (same rule as the fleet KPI,
    // which excludes cancelled rows). Only a missing billing row falls
    // back to the SKU estimate.
    const cancelled = billing !== null && billing.status === "cancelled";
    const syncedCents = cancelled ? null : (billing?.monthly_price_cents ?? null);
    const estimateCents =
      !cancelled && isVpsSize(box.plan) ? HOSTING_MONTHLY_CENTS_BY_SIZE[box.plan] : null;
    const endsAt = billing?.expires_at ?? billing?.next_billing_at ?? null;
    const endsMs = endsAt !== null ? Date.parse(endsAt) : Number.NaN;
    burn.push({
      vmId: box.vm_id,
      hostname: box.hostname,
      plan: box.plan,
      monthlyCents: syncedCents ?? estimateCents,
      monthlySource: syncedCents !== null ? "actual" : "estimate",
      autoRenew: billing?.is_auto_renewed ?? null,
      endsAt,
      daysLeft: Number.isFinite(endsMs) ? Math.max(0, Math.ceil((endsMs - nowMs) / DAY_MS)) : null
    });
  }
  return burn.sort((a, b) => (a.daysLeft ?? Number.MAX_SAFE_INTEGER) - (b.daysLeft ?? Number.MAX_SAFE_INTEGER));
}
