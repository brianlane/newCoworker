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
  purchasedAt?: string | null;
  expiresAt?: string | null;
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

function parseMs(value: string | null | undefined): number {
  return Date.parse(value ?? "");
}

function purchasedInWindow(g: UsageGrant, startMs: number): boolean {
  const at = parseMs(g.purchasedAt);
  return Number.isFinite(at) && at >= startMs;
}

function isLiveGrant(g: UsageGrant, nowMs: number): boolean {
  const exp = parseMs(g.expiresAt);
  return !Number.isFinite(exp) || exp > nowMs;
}

function expiredInWindow(g: UsageGrant, startMs: number, nowMs: number): boolean {
  const exp = parseMs(g.expiresAt);
  return Number.isFinite(exp) && exp > startMs && exp <= nowMs;
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
 * this-period pack draw is the overflow, capped by `unexpiredConsumed`
 * (this-period draw from packs that are still live, not lifetime leftover).
 *
 * Prefer {@link smsPlanMeterFromGrants}, which derives that consumed figure
 * from grant purchase/expiry times so leftover packs used this window still
 * raise the numerator, while overflow from a pack that expired this window
 * does not.
 */
function smsPlanMeter(input: {
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
 * Dashboard SMS PLAN meter. Live grants raise the denominator by full grant
 * size. Numerator overflow counts as live-pack draw unless a grant that
 * expired this window can explain it:
 *
 * - leftover pack purchased last window, used this window, still live: the
 *   overflow stays (normal 30-day / period-end survival)
 * - overflow from a pack that expired this window is dropped, even when
 *   another live pack keeps the denominator high
 * - leftover last-window consumption cannot cover that expired overflow
 */
export function smsPlanMeterFromGrants(input: {
  usedThisPeriod: number;
  includedCap: number;
  grants: readonly UsageGrant[] | null | undefined;
  windowStart: string | null | undefined;
  nowMs?: number;
}): PlanMeter {
  const nowMs = Number.isFinite(input.nowMs) ? Number(input.nowMs) : Date.now();
  const startMs = parseMs(input.windowStart);
  const grants = input.grants ?? [];
  const live = grants.filter((g) => isLiveGrant(g, nowMs));
  const livePurchased = sumUsageGrants(live).purchased;
  const period = finiteNonNeg(input.usedThisPeriod);
  const includedCap = finiteNonNeg(input.includedCap);
  const overflow = Math.max(0, period - includedCap);

  if (!Number.isFinite(startMs)) {
    return smsPlanMeter({
      usedThisPeriod: period,
      includedCap,
      unexpiredPurchased: livePurchased,
      unexpiredConsumed: 0
    });
  }

  const expiredThisWindow = grants.filter((g) => expiredInWindow(g, startMs, nowMs));
  const newLiveConsumed = sumUsageGrants(live.filter((g) => purchasedInWindow(g, startMs))).consumed;
  const newExpiredConsumed = sumUsageGrants(
    expiredThisWindow.filter((g) => purchasedInWindow(g, startMs))
  ).consumed;
  const rest = Math.max(0, overflow - newLiveConsumed - newExpiredConsumed);
  const hasOldExpired = expiredThisWindow.some((g) => !purchasedInWindow(g, startMs));
  const thisPeriodLive = Math.min(
    overflow,
    livePurchased,
    newLiveConsumed + (hasOldExpired ? 0 : rest)
  );
  return smsPlanMeter({
    usedThisPeriod: period,
    includedCap,
    unexpiredPurchased: livePurchased,
    unexpiredConsumed: thisPeriodLive
  });
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
