/**
 * The ONE fleet cost model.
 *
 * Three admin surfaces used to answer "what does the fleet cost, and what do
 * we net?" and all three disagreed, because each had grown its own
 * arithmetic:
 *
 *   - the Dashboard's `net` came from a fleet-level estimator that had no
 *     Stripe fee line at all,
 *   - the Revenue page's Net Margin summed the per-tenant margin engine,
 *     which has Stripe fees but no campaign fee, taxes, leak or pool burn,
 *   - the Costs page added those five missing pieces inline, and was the
 *     only complete answer.
 *
 * On a live fleet that read as $450 net on one page and $434.90 on another,
 * with no way to tell which was right. The fix is not to keep the models in
 * step by hand: it is to have one. {@link composeFleetCost} is that model,
 * {@link loadFleetCostBreakdown} is its production loader, and all three
 * pages render what it returns.
 *
 * Nothing bills from these numbers, operator health metrics only.
 */

import { logger } from "@/lib/logger";
import {
  TELNYX_CAMPAIGN_FEE_MONTHLY_CENTS,
  estimateTelnyxTaxCents,
  TELNYX_VOICE_ADJUNCT_CENTS_PER_MINUTE
} from "@/lib/plans/enterprise-pricing";
import { buildPoolBoxBurn, sumMarginLinesByKey } from "@/lib/admin/costs-view";
import { loadFleetMargins, type FleetMarginData } from "@/lib/admin/margin-data";
import type { FleetMarginTotals, MarginLineKey } from "@/lib/admin/margin";
import {
  listHostingerVpsCosts,
  listTelnyxCostDaily,
  type HostingerVpsCostRow,
  type TelnyxCostDailyRow
} from "@/lib/db/platform-costs";
import { listVpsInventory, type VpsInventoryRow } from "@/lib/db/vps-inventory";

export type FleetCostBreakdown = {
  revenueCents: number;
  /** The per-tenant margin engine's lines, summed across the fleet. */
  perTenantCents: Record<MarginLineKey, number>;
  /** Telnyx spend matching no tenant DID, the leak detector. */
  unattributedTelnyxCents: number;
  /**
   * Stripe fees no tenant's modeled fee line represents: account-level
   * charges, plus disputes and adjustments Stripe attached to a customer
   * (a tenant's line models card pricing only).
   */
  unmodeledStripeFeeCents: number;
  /** Idle pool boxes no tenant is on yet. */
  poolHostingCents: number;
  /** The shared 10DLC campaign registration fee (one for the whole fleet). */
  campaignFeeCents: number;
  /** Call control, media streaming, recording, invoice-only, never in MDRs. */
  voiceAdjunctCents: number;
  telnyxTaxCents: number;
  totalCostCents: number;
  netMarginCents: number;
  /** Net margin as % of revenue; null when there is no revenue. */
  netMarginPct: number | null;
};

/**
 * Compose the complete fleet cost from the per-tenant margin totals plus
 * the five platform-level costs no tenant's margin can see.
 *
 * Pure: every input is passed in, so the same arithmetic is testable and
 * cannot drift between the pages that render it.
 */
export function composeFleetCost(params: {
  marginTotals: FleetMarginTotals;
  perTenantCents: Record<MarginLineKey, number>;
  unattributedTelnyxCents: number;
  unmodeledStripeFeeCents: number;
  poolHostingCents: number;
  /** This month's metered voice minutes, for the invoice-only adjuncts. */
  monthVoiceMinutes: number;
  /**
   * The VOICE (sip-trunking) share of this month's synced Telnyx spend.
   * Tax treats voice and messaging differently, so the two must arrive
   * apart; the rest of the month's spend is taken as messaging.
   */
  monthTelnyxVoiceCents: number;
}): FleetCostBreakdown {
  const voiceAdjunctCents = Math.round(
    params.monthVoiceMinutes * TELNYX_VOICE_ADJUNCT_CENTS_PER_MINUTE
  );
  // Arizona taxes telecom by GEOGRAPHY, not by charge family: number
  // rentals and the campaign fee are sourced to the Mesa billing address
  // and taxed in full, voice is predominantly in-state, and messaging is
  // taxable only on its intrastate share. The unattributed bucket rides
  // with messaging: every sender seen in it so far has been a messaging
  // one. See estimateTelnyxTaxCents.
  const telnyxTaxCents = estimateTelnyxTaxCents({
    recurringCents: params.perTenantCents.did + TELNYX_CAMPAIGN_FEE_MONTHLY_CENTS,
    voiceUsageCents: params.monthTelnyxVoiceCents + voiceAdjunctCents,
    messagingUsageCents:
      params.perTenantCents.telnyx_usage +
      params.unattributedTelnyxCents -
      params.monthTelnyxVoiceCents
  });

  const totalCostCents =
    params.marginTotals.costCents +
    params.unattributedTelnyxCents +
    // Stripe fees outside every tenant's modeled line are still money
    // Stripe took, so the fleet total carries them the same way the Telnyx
    // leak is carried.
    params.unmodeledStripeFeeCents +
    params.poolHostingCents +
    TELNYX_CAMPAIGN_FEE_MONTHLY_CENTS +
    voiceAdjunctCents +
    telnyxTaxCents;
  const netMarginCents = params.marginTotals.revenueCents - totalCostCents;

  return {
    revenueCents: params.marginTotals.revenueCents,
    perTenantCents: params.perTenantCents,
    unattributedTelnyxCents: params.unattributedTelnyxCents,
    unmodeledStripeFeeCents: params.unmodeledStripeFeeCents,
    poolHostingCents: params.poolHostingCents,
    campaignFeeCents: TELNYX_CAMPAIGN_FEE_MONTHLY_CENTS,
    voiceAdjunctCents,
    telnyxTaxCents,
    totalCostCents,
    netMarginCents,
    netMarginPct:
      params.marginTotals.revenueCents > 0
        ? Math.round((netMarginCents / params.marginTotals.revenueCents) * 1000) / 10
        : null
  };
}

/** UTC YYYY-MM-DD 90 days before `now`, the Telnyx trend/window floor. */
export function trendWindowStartYmd(now: Date): string {
  return new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export type FleetCostData = {
  margins: FleetMarginData;
  hostingerRows: HostingerVpsCostRow[];
  /** The last 90 days of Telnyx cost rows (also feeds the Costs page windows). */
  telnyxTrendRows: TelnyxCostDailyRow[];
  inventory: VpsInventoryRow[];
  breakdown: FleetCostBreakdown;
};

/**
 * Production loader: everything {@link composeFleetCost} needs, plus the raw
 * rows the Costs page renders its per-window views from, so that page does
 * not fetch the same data twice.
 *
 * Every read past the margin load is best effort, a transient failure
 * degrades one platform-level line to zero rather than erroring an admin
 * page. `loadFleetMargins` itself is NOT caught here: without it there is no
 * revenue or per-tenant cost to compose, and callers already treat the whole
 * load as best effort.
 */
export async function loadFleetCostBreakdown(now: Date = new Date()): Promise<FleetCostData> {
  const [margins, hostingerRows, telnyxTrendRows, inventory] = await Promise.all([
    loadFleetMargins(now),
    listHostingerVpsCosts().catch((err: unknown) => {
      logger.error("loadFleetCostBreakdown: hostinger snapshot read failed", {
        message: err instanceof Error ? err.message : String(err)
      });
      return [] as HostingerVpsCostRow[];
    }),
    listTelnyxCostDaily(trendWindowStartYmd(now)).catch((err: unknown) => {
      logger.error("loadFleetCostBreakdown: telnyx trend read failed", {
        message: err instanceof Error ? err.message : String(err)
      });
      return [] as TelnyxCostDailyRow[];
    }),
    listVpsInventory().catch((err: unknown) => {
      logger.error("loadFleetCostBreakdown: vps inventory read failed", {
        message: err instanceof Error ? err.message : String(err)
      });
      return [] as VpsInventoryRow[];
    })
  ]);

  const monthTelnyxRows = telnyxTrendRows.filter((r) => r.day >= margins.monthStartYmd);
  const unattributedTelnyxCents = Math.round(
    monthTelnyxRows
      .filter((r) => r.business_id === null)
      .reduce((sum, r) => sum + r.cost_micros, 0) / 10_000
  );
  const poolHostingCents = buildPoolBoxBurn({ inventory, hostingerRows, now }).reduce(
    (sum, box) => sum + (box.monthlyCents ?? 0),
    0
  );
  const monthVoiceMinutes =
    monthTelnyxRows.reduce((sum, r) => sum + r.billed_seconds, 0) / 60;
  const monthTelnyxVoiceCents = Math.round(
    monthTelnyxRows
      .filter((r) => r.record_type === "sip-trunking")
      .reduce((sum, r) => sum + r.cost_micros, 0) / 10_000
  );

  return {
    margins,
    hostingerRows,
    telnyxTrendRows,
    inventory,
    breakdown: composeFleetCost({
      marginTotals: margins.totals,
      perTenantCents: sumMarginLinesByKey(margins.economics),
      unattributedTelnyxCents,
      unmodeledStripeFeeCents: margins.unmodeledStripeFeeCents,
      poolHostingCents,
      monthVoiceMinutes,
      monthTelnyxVoiceCents
    })
  };
}
