/**
 * Production loader for the margin engine: assembles one
 * {@link BusinessMarginInput} per business from the live tables + the
 * synced vendor-cost tables, and computes fleet economics.
 *
 * Synced actuals (Hostinger billing snapshot, this month's Telnyx rows)
 * degrade gracefully to the per-unit estimates when the sync hasn't run or
 * a read fails — an admin page must render either way. Usage/AI reads are
 * likewise best-effort (zeroes), matching the dashboard's existing
 * behavior for the same sources.
 */

import { logger } from "@/lib/logger";
import { listBusinesses, type BusinessRow } from "@/lib/db/businesses";
import { listAllSubscriptions, type SubscriptionRow } from "@/lib/db/subscriptions";
import { listActiveEnterpriseDeals } from "@/lib/db/enterprise-deals";
import {
  getFleetCalendarMonthUsageByBusiness,
  type BusinessMonthUsage
} from "@/lib/db/usage";
import { getFleetCurrentAiSpendMicrosByBusiness } from "@/lib/db/chat-usage";
import {
  listHostingerVpsCosts,
  listTelnyxCostDaily,
  type HostingerVpsCostRow,
  type TelnyxCostDailyRow
} from "@/lib/db/platform-costs";
import { isVpsSize, vpsSizeFromHostingerPlan, type VpsSize } from "@/lib/vps/size";
import {
  computeBusinessMargin,
  computeFleetMarginTotals,
  type BusinessMarginEconomics,
  type FleetMarginTotals
} from "@/lib/admin/margin";

export type FleetMarginData = {
  businesses: BusinessRow[];
  economics: BusinessMarginEconomics[];
  byBusiness: Map<string, BusinessMarginEconomics>;
  usageByBusiness: Map<string, BusinessMonthUsage>;
  aiSpendMicrosByBusiness: Map<string, number>;
  /** The revenue-bearing subscription row per business (see {@link dedupeSubscriptionsPreferringActive}). */
  subscriptionByBusiness: Map<string, SubscriptionRow>;
  totals: FleetMarginTotals;
  /** True when this month's Telnyx sync rows exist (margin uses invoice actuals). */
  telnyxActuals: boolean;
  /** UTC YYYY-MM-DD the month window starts at. */
  monthStartYmd: string;
};

/**
 * One revenue-bearing subscription row per business from a newest-first
 * history: the newest ACTIVE Stripe-backed row wins; only businesses with
 * none fall back to their newest row of any status. Plain
 * newest-row-wins would let a `pending` resubscribe checkout shadow the
 * still-live subscription and zero the tenant's revenue/margin until it
 * activates.
 */
export function dedupeSubscriptionsPreferringActive(
  rows: SubscriptionRow[]
): Map<string, SubscriptionRow> {
  const picked = new Map<string, SubscriptionRow>();
  const pickedIsActive = new Set<string>();
  for (const row of rows) {
    const isActive = row.status === "active" && row.stripe_subscription_id !== null;
    if (!picked.has(row.business_id)) {
      picked.set(row.business_id, row);
      if (isActive) pickedIsActive.add(row.business_id);
      continue;
    }
    if (isActive && !pickedIsActive.has(row.business_id)) {
      picked.set(row.business_id, row);
      pickedIsActive.add(row.business_id);
    }
  }
  return picked;
}

export function monthStartYmdUtc(now: Date = new Date()): string {
  return `${now.toISOString().slice(0, 7)}-01`;
}

/**
 * businessId → summed monthly price of its synced Hostinger boxes.
 * Cancelled subscriptions recur nothing (sunk cost until lapse) — same
 * non-recurring rule as the Costs page fleet KPI and the pool burn view.
 */
export function hostingCentsByBusiness(rows: HostingerVpsCostRow[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const row of rows) {
    if (
      row.assigned_business_id === null ||
      row.monthly_price_cents === null ||
      row.status === "cancelled"
    ) {
      continue;
    }
    map.set(
      row.assigned_business_id,
      (map.get(row.assigned_business_id) ?? 0) + row.monthly_price_cents
    );
  }
  return map;
}

/**
 * businessId → parseable hardware sizes of its synced boxes (same row
 * filter as {@link hostingCentsByBusiness}; unparseable plan labels are
 * skipped rather than guessed).
 */
export function hostingSizesByBusiness(rows: HostingerVpsCostRow[]): Map<string, VpsSize[]> {
  const map = new Map<string, VpsSize[]>();
  for (const row of rows) {
    if (
      row.assigned_business_id === null ||
      row.monthly_price_cents === null ||
      row.status === "cancelled"
    ) {
      continue;
    }
    const size = vpsSizeFromHostingerPlan(row.plan);
    if (size === null) continue;
    const sizes = map.get(row.assigned_business_id) ?? [];
    sizes.push(size);
    map.set(row.assigned_business_id, sizes);
  }
  return map;
}

/**
 * Whether the synced Hostinger billing should be REPLACED by the pinned
 * size's SKU estimate for this business's margin: true when the business
 * carries an explicit `vps_size` pin and ANY parseable synced box size
 * disagrees with it.
 *
 * Rationale: a pinned tenant sitting on a differently-sized box (e.g. a
 * standard tenant pinned kvm2 whose lapsing KVM8 is still the assigned
 * billing row) is mid-transition — the pin is the intended steady-state
 * hardware, so the pinned SKU is the tenant's RECURRING cost; the old
 * box's remaining term is sunk money the fleet views (Costs page vendor
 * table/KPI) still report. When the pin and box agree — or there is no
 * pin, or no parseable plan — the synced actual wins: real promo/term
 * pricing beats the SKU table.
 */
export function syncedHostingContradictsPin(
  vpsSizePin: string | null | undefined,
  syncedSizes: VpsSize[] | undefined
): boolean {
  if (!isVpsSize(vpsSizePin)) return false;
  if (!syncedSizes || syncedSizes.length === 0) return false;
  return syncedSizes.some((size) => size !== vpsSizePin);
}

/** businessId → this window's summed Telnyx cost (micro-USD); null key rows excluded. */
export function telnyxMicrosByBusiness(rows: TelnyxCostDailyRow[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const row of rows) {
    if (row.business_id === null) continue;
    map.set(row.business_id, (map.get(row.business_id) ?? 0) + row.cost_micros);
  }
  return map;
}

export async function loadFleetMargins(now: Date = new Date()): Promise<FleetMarginData> {
  const businesses = await listBusinesses();
  const monthStartYmd = monthStartYmdUtc(now);

  const [allSubscriptions, deals, usageByBusiness, aiSpendMicrosByBusiness, hostingerRows, telnyxRows] =
    await Promise.all([
      listAllSubscriptions(),
      listActiveEnterpriseDeals(),
      // Best-effort reads: a transient failure degrades one input to
      // zero/estimates instead of erroring the whole admin page.
      getFleetCalendarMonthUsageByBusiness().catch((err: unknown) => {
        logger.error("loadFleetMargins: usage rollup failed", {
          message: err instanceof Error ? err.message : String(err)
        });
        return new Map<string, BusinessMonthUsage>();
      }),
      getFleetCurrentAiSpendMicrosByBusiness().catch((err: unknown) => {
        logger.error("loadFleetMargins: AI spend read failed", {
          message: err instanceof Error ? err.message : String(err)
        });
        return new Map<string, number>();
      }),
      listHostingerVpsCosts().catch((err: unknown) => {
        logger.error("loadFleetMargins: hostinger snapshot read failed", {
          message: err instanceof Error ? err.message : String(err)
        });
        return [];
      }),
      listTelnyxCostDaily(monthStartYmd).catch((err: unknown) => {
        logger.error("loadFleetMargins: telnyx cost read failed", {
          message: err instanceof Error ? err.message : String(err)
        });
        return [];
      })
    ]);

  const subscriptionByBusiness = dedupeSubscriptionsPreferringActive(allSubscriptions);
  const dealByBusiness = new Map(deals.map((deal) => [deal.business_id, deal.monthly_cents]));
  const hostingByBusiness = hostingCentsByBusiness(hostingerRows);
  const hostingSizes = hostingSizesByBusiness(hostingerRows);
  const telnyxByBusiness = telnyxMicrosByBusiness(telnyxRows);
  // Any synced row this month means the Telnyx sync is live: businesses
  // without rows genuinely had no Telnyx cost (actual 0), not "unknown".
  const telnyxActuals = telnyxRows.length > 0;

  const economics: BusinessMarginEconomics[] = [];
  const byBusiness = new Map<string, BusinessMarginEconomics>();
  for (const business of businesses) {
    const usage = usageByBusiness.get(business.id);
    // A pinned tenant whose synced box size disagrees with the pin is
    // mid-transition (e.g. standard pinned kvm2 with a lapsing KVM8 still
    // assigned): drop the synced price so the margin reflects the pinned
    // SKU — the intended recurring cost — instead of the old box's bill.
    // See syncedHostingContradictsPin.
    const pinContradicted = syncedHostingContradictsPin(
      business.vps_size ?? null,
      hostingSizes.get(business.id)
    );
    const result = computeBusinessMargin(
      {
        businessId: business.id,
        tier: business.tier,
        status: business.status,
        hostingerVpsId: business.hostinger_vps_id,
        vpsSize: business.vps_size ?? null,
        vpsProvider: business.vps_provider ?? null,
        subscription: subscriptionByBusiness.get(business.id) ?? null,
        enterpriseDealMonthlyCents: dealByBusiness.get(business.id) ?? null,
        hostingerMonthlyPriceCents: pinContradicted
          ? null
          : (hostingByBusiness.get(business.id) ?? null),
        telnyxMonthCostMicros: telnyxActuals ? (telnyxByBusiness.get(business.id) ?? 0) : null,
        monthSmsSent: usage?.smsSent ?? 0,
        monthVoiceMinutes: usage?.voiceMinutes ?? 0,
        aiSpendMicros: aiSpendMicrosByBusiness.get(business.id) ?? 0
      },
      now
    );
    economics.push(result);
    byBusiness.set(business.id, result);
  }

  return {
    businesses,
    economics,
    byBusiness,
    usageByBusiness,
    aiSpendMicrosByBusiness,
    subscriptionByBusiness,
    totals: computeFleetMarginTotals(economics),
    telnyxActuals,
    monthStartYmd
  };
}
