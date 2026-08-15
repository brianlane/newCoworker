/**
 * Contract coverage: how much prepaid VPS runway a tenant's contract needs,
 * and which Hostinger term buys the shortfall.
 *
 * Fleet strategy (Aug 2026). We used to buy a box whose Hostinger term
 * matched the customer's contract at SIGNUP: a 24-month customer immediately
 * funded a 24-month box. That put the platform's money at risk during the
 * customer's own 30-day money-back window, because Hostinger will not refund
 * us (30 days per box AND 180 days since the account's last VPS refund), and
 * it is why the refund used to withhold a month of service. Now every signup
 * buys a MONTHLY box, and a tenant is moved onto term-priced hardware only
 * once their refund window has closed and the platform is no longer exposed.
 *
 * The rule this module encodes, and the reason it is one rule rather than a
 * special case per scenario:
 *
 *   VPS runway must reach the end of the tenant's LIVE Stripe period, and we
 *   only ever buy the term that covers the SHORTFALL.
 *
 * Deriving the target from `stripe_current_period_end` rather than from the
 * contract length is what makes the awkward cases fall out for free:
 *
 * - Signup on a 24-month contract, monthly box: the box runs out roughly
 *   monthly, so the shortfall is ~23 months and we buy a 2y box at its first
 *   monthly renewal after the refund window closes.
 * - A tenant who ADOPTED a pooled box with 12 months of prepaid runway left
 *   (someone else churned mid-contract) is left alone for those 12 months,
 *   then needs only the remaining 12 to finish a 24-month contract, so we
 *   buy a 1y box, not another 2y.
 * - When the contract itself renews, Stripe advances the period end and the
 *   next sweep run simply reads the new target. Whether the renewal is
 *   another full prepaid term or a rollover to month-to-month
 *   (`isCommitmentElapsed` distinguishes those, and BOTH happen), we never
 *   have to predict it: we re-derive from what Stripe actually did.
 *
 * Everything here is pure so the sweep's decisions are unit-testable without
 * Hostinger or Stripe.
 */

import type { SubscriptionRow } from "@/lib/db/subscriptions";
import type { CustomerProfileRow } from "@/lib/db/customer-profiles";
import { isWithinLifetimeRefundWindow } from "@/lib/db/customer-profiles";
import {
  hostingerTermMonths,
  type HostingerBillingTerm
} from "@/lib/hostinger/provision";

/**
 * Add whole months in UTC, clamping the day to the target month's last day
 * so Jan 31 + 1 month is Feb 28/29 rather than spilling into March.
 */
function addMonthsUtc(date: Date, months: number): Date {
  const day = date.getUTCDate();
  const shifted = new Date(date.getTime());
  // Park on the 1st before shifting so the month arithmetic can never
  // overflow on its own, then restore the clamped day.
  shifted.setUTCDate(1);
  shifted.setUTCMonth(shifted.getUTCMonth() + months);
  const lastDayOfMonth = new Date(
    Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, 0)
  ).getUTCDate();
  shifted.setUTCDate(Math.min(day, lastDayOfMonth));
  return shifted;
}

/**
 * Slack allowed when asking "does this box already cover the contract?".
 *
 * Hostinger anniversaries and Stripe anniversaries drift by hours (different
 * clocks, different purchase minutes), so an exact comparison would call a
 * box that covers the contract to within a few hours "short" and buy a whole
 * extra term to close a gap that does not exist. Three days is comfortably
 * wider than any observed drift and far narrower than the smallest term we
 * could buy to fix it.
 */
export const COVERAGE_SLACK_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * Billing periods that represent a prepaid commitment. Monthly tenants have
 * no contract to cover: their box stays monthly forever, which is the whole
 * point of the strategy.
 */
export function isContractBillingPeriod(
  period: SubscriptionRow["billing_period"]
): boolean {
  return period === "annual" || period === "biennial";
}

/**
 * The instant VPS runway has to reach: the end of the tenant's live Stripe
 * period. Null for a tenant with no contract or no cached period bound (we
 * refuse to guess a target we cannot read).
 */
export function contractCoverageTargetAt(
  sub: Pick<SubscriptionRow, "billing_period" | "stripe_current_period_end">
): Date | null {
  if (!isContractBillingPeriod(sub.billing_period)) return null;
  if (!sub.stripe_current_period_end) return null;
  const at = new Date(sub.stripe_current_period_end);
  return Number.isNaN(at.getTime()) ? null : at;
}

/**
 * Whole months of contract still to cover between `from` and `targetAt`,
 * rounded UP so a partial month is still funded. Zero when the target is in
 * the past.
 *
 * Counted on the CALENDAR, not by dividing a duration by an average month.
 * An average-month divisor gets the most common case in this system wrong:
 * a 24-month contract measured across a leap year spans 731 days, which is
 * 24.01 average months and rounds up to 25, pushing the term selection a
 * notch too high and buying hardware we do not need.
 */
export function remainingContractMonths(from: Date, targetAt: Date): number {
  if (targetAt.getTime() <= from.getTime()) return 0;
  let months =
    (targetAt.getUTCFullYear() - from.getUTCFullYear()) * 12 +
    (targetAt.getUTCMonth() - from.getUTCMonth());
  // The year/month subtraction ignores day-of-month, so correct in both
  // directions: step back if we overshot the target, then step forward once
  // if any remainder is left (that remainder still has to be funded).
  if (addMonthsUtc(from, months).getTime() > targetAt.getTime()) months -= 1;
  if (addMonthsUtc(from, months).getTime() < targetAt.getTime()) months += 1;
  return Math.max(months, 0);
}

/**
 * Cheapest Hostinger term that covers `months` of remaining contract.
 *
 * Hostinger sells 1m, 1y and 2y only, so anything over a year rounds up to
 * 2y. Over-buying is deliberate and safe in that direction: surplus runway
 * is consumed by the contract's own renewal, and the per-month price of a
 * longer term is strictly lower, so a 2y box bought for 13 remaining months
 * costs less per month than stacking two 1y purchases. Under-buying is the
 * expensive mistake, since it means another migration.
 */
export function hostingerTermForRemainingMonths(months: number): HostingerBillingTerm {
  if (months <= 1) return "1m";
  if (months <= 12) return "1y";
  return "2y";
}

export type CoverageAssessment =
  | { covered: true; reason: "no_contract" | "runway_covers_contract" }
  | {
      covered: false;
      /** Whole months of contract the current box does not fund. */
      shortfallMonths: number;
      /** Hostinger term to buy to close that shortfall. */
      term: HostingerBillingTerm;
      /** Months that term actually buys (>= shortfallMonths). */
      termMonths: number;
    };

/**
 * Does this tenant's box already fund their contract, and if not, what do we
 * have to buy?
 *
 * `boxPaidThrough` is the Hostinger paid-through for the box the tenant is
 * running on. An UNKNOWN (null) paid-through is treated as "does not cover":
 * a monthly box that Hostinger has not reported on is the common case at
 * signup, and treating unknown as covered would strand a contract tenant on
 * monthly hardware forever. The sweep separately refuses to act until the
 * box is inside its renewal window, so an unknown expiry cannot trigger a
 * premature purchase on its own.
 */
export function assessContractCoverage(input: {
  subscription: Pick<SubscriptionRow, "billing_period" | "stripe_current_period_end">;
  boxPaidThrough: string | null;
  now: Date;
}): CoverageAssessment {
  const targetAt = contractCoverageTargetAt(input.subscription);
  if (!targetAt) return { covered: true, reason: "no_contract" };

  const paidThroughMs = input.boxPaidThrough
    ? new Date(input.boxPaidThrough).getTime()
    : Number.NaN;
  if (Number.isFinite(paidThroughMs) && paidThroughMs + COVERAGE_SLACK_MS >= targetAt.getTime()) {
    return { covered: true, reason: "runway_covers_contract" };
  }

  // Measure the shortfall from where the box's paid time actually ENDS, not
  // from now: a box with 12 prepaid months on a 24-month contract is short
  // by 12, not by 24. An unknown/unparseable paid-through falls back to now,
  // which is the conservative reading (it can only over-estimate the gap,
  // and the renewal-window gate is what stops us acting on it early).
  const measureFrom = Number.isFinite(paidThroughMs)
    ? new Date(Math.max(paidThroughMs, input.now.getTime()))
    : input.now;
  const shortfallMonths = remainingContractMonths(measureFrom, targetAt);
  const term = hostingerTermForRemainingMonths(shortfallMonths);
  return {
    covered: false,
    shortfallMonths,
    term,
    termMonths: hostingerTermMonths(term)
  };
}

/**
 * True when the platform is still exposed to a money-back refund for this
 * customer, so we must NOT put non-refundable term hardware behind them.
 *
 * This is the gate that replaces "wait 30 days after signup". Reading the
 * refund right itself, rather than the subscription's age, is what makes the
 * rule correct for the cases a day-count gets wrong: a customer who already
 * spent their lifetime-once refund on an earlier subscription is not exposed
 * at all, and a long-standing monthly customer who upgrades to a 24-month
 * contract has no open window either, so both are eligible immediately.
 */
export function isRefundExposureOpen(
  profile: Pick<CustomerProfileRow, "first_paid_at" | "refund_used_at"> | null,
  now: Date
): boolean {
  // No profile means we cannot verify the refund right is spent. The refund
  // planner refuses a refund in that state ("missing_context"), but a
  // never-paid profile also reads as "no window"; fail toward NOT buying
  // non-refundable hardware we might have to eat.
  if (!profile) return true;
  return isWithinLifetimeRefundWindow(profile, now);
}
