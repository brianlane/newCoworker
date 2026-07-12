/**
 * Pure view-model builders for the admin Costs page (/admin/costs): vendor
 * KPI roll-ups, the monthly Telnyx trend, the renewal calendar (Hostinger
 * box renewals + Stripe term rollovers — both money moments), and the
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
    gemini_voice: 0,
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
 * - Hostinger box renewals (spend continues) and lapses (box disappears —
 *   a problem if a tenant is on it, the plan if it's pooled).
 * - Stripe term rollovers: an active 12/24-month contract passing
 *   `renewal_at` rolls to the HIGHER month-to-month renewal rate unless
 *   auto-renew re-commits — revenue upside either way, worth watching.
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
    const renewing = row.is_auto_renewed === true && row.status !== "cancelled";
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
  for (const row of params.hostingerRows) {
    if (row.vm_id !== null) byVm.set(row.vm_id, row);
  }
  const nowMs = params.now.getTime();

  const burn: PoolBoxBurn[] = [];
  for (const box of params.inventory) {
    if (box.state !== "available") continue;
    const billing = byVm.get(box.vm_id) ?? null;
    const syncedCents = billing?.monthly_price_cents ?? null;
    const estimateCents = isVpsSize(box.plan) ? HOSTING_MONTHLY_CENTS_BY_SIZE[box.plan] : null;
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
