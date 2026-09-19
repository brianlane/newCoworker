/**
 * PLAN-card usage meters: included allotment + unexpired purchased grants.
 *
 * Product rule (locked): when a tenant buys voice minutes, texts, or AI
 * budget, the dashboard PLAN row must raise the **denominator** by the
 * full grant size for as long as that purchase is unexpired. Remaining
 * pack balance is a side bucket for auto-reload / billing detail, not the
 * meter cap. Expired packs drop out of both the extra numerator usage and
 * the extra denominator.
 *
 * Auto-reload thresholds still read remaining headroom (included leftover
 * + bonus remaining). This module is display math only.
 */

export type PlanMeter = {
  /** Included usage this period + usage drawn from still-unexpired grants. */
  used: number;
  /** Included allotment + full grant size of still-unexpired purchases. */
  cap: number;
};

export type UsageGrant = {
  purchased: number;
  remaining: number;
};

export type UsageGrantTotals = {
  purchased: number;
  remaining: number;
  consumed: number;
};

function finiteNonNeg(n: unknown): number {
  const x = Number(n);
  return Number.isFinite(x) && x > 0 ? x : 0;
}

/**
 * Per-grant totals so a malformed row (remaining without purchased, or
 * remaining above purchased) cannot leak into another grant's consumed
 * amount. `purchased - remaining` on the sums is not the same.
 */
export function sumUsageGrants(grants: readonly UsageGrant[] | null | undefined): UsageGrantTotals {
  let purchased = 0;
  let remaining = 0;
  let consumed = 0;
  for (const g of grants ?? []) {
    const purchasedN = finiteNonNeg(g.purchased);
    const remainingN = finiteNonNeg(g.remaining);
    purchased += purchasedN;
    remaining += remainingN;
    consumed += Math.max(0, purchasedN - remainingN);
  }
  return { purchased, remaining, consumed };
}

/**
 * Shared PLAN fraction. `unexpiredPurchased` is grant SIZE (not leftover
 * balance). `unexpiredConsumed` is usage drawn from those same live grants.
 */
function planMeter(input: {
  includedUsed: number;
  includedCap: number;
  unexpiredPurchased: number;
  unexpiredConsumed: number;
}): PlanMeter {
  const includedCap = finiteNonNeg(input.includedCap);
  const includedUsed = Math.min(finiteNonNeg(input.includedUsed), includedCap);
  const purchased = finiteNonNeg(input.unexpiredPurchased);
  const consumed = Math.min(finiteNonNeg(input.unexpiredConsumed), purchased);
  return { used: includedUsed + consumed, cap: includedCap + purchased };
}

export function voicePlanMeter(input: {
  committedIncludedSeconds: number;
  tierCapSeconds: number;
  unexpiredPurchasedSeconds: number;
  unexpiredConsumedSeconds: number;
}): PlanMeter {
  return planMeter({
    includedUsed: input.committedIncludedSeconds,
    includedCap: input.tierCapSeconds,
    unexpiredPurchased: input.unexpiredPurchasedSeconds,
    unexpiredConsumed: input.unexpiredConsumedSeconds
  });
}

/**
 * SMS window usage is a single `daily_usage` total (plan + bonus) for the
 * current billing window. Bonus only starts after the included cap, so
 * this-period pack draw is the overflow, capped by lifetime consumption on
 * packs that are still unexpired:
 *
 * - leftover consumption from last window does not subtract from this-period
 *   included usage (overflow is 0 while under cap)
 * - usage drawn from a pack that later expires is dropped, even when another
 *   live pack keeps the denominator high
 */
export function smsPlanMeter(input: {
  usedThisPeriod: number;
  includedCap: number;
  unexpiredPurchased: number;
  unexpiredConsumed: number;
}): PlanMeter {
  const purchased = finiteNonNeg(input.unexpiredPurchased);
  const consumed = Math.min(finiteNonNeg(input.unexpiredConsumed), purchased);
  const period = finiteNonNeg(input.usedThisPeriod);
  const includedCap = finiteNonNeg(input.includedCap);
  const includedUsed = Math.min(period, includedCap);
  const overflow = Math.max(0, period - includedCap);
  return {
    used: includedUsed + Math.min(overflow, consumed),
    cap: includedCap + purchased
  };
}

/**
 * AI credit raises the period cap and is not drained per turn
 * (`chat_spend_credit_grants.credit_micros`). Unexpired credit is therefore
 * already the full grant size. Spend above the live cap (expired credit,
 * settlement overshoot) is dropped so the meter tracks live budget.
 */
export function aiBudgetPlanMeter(input: {
  spendMicros: number;
  baseCapMicros: number;
  unexpiredCreditMicros: number;
}): PlanMeter {
  const base = finiteNonNeg(input.baseCapMicros);
  const credit = finiteNonNeg(input.unexpiredCreditMicros);
  const spend = finiteNonNeg(input.spendMicros);
  const consumedFromCredit = Math.min(Math.max(0, spend - base), credit);
  const includedUsed = Math.min(spend, base);
  return { used: includedUsed + consumedFromCredit, cap: base + credit };
}

/** Dashboard PLAN row shows whole minutes. */
export function planMeterMinutes(meter: PlanMeter): { used: number; cap: number } {
  return { used: Math.round(meter.used / 60), cap: Math.round(meter.cap / 60) };
}
