/**
 * What Stripe actually takes off the top, as a rate the margin engine can
 * apply to a monthly plan price.
 *
 * Two things the old flat `2.9% + $0.30` model got wrong:
 *
 *  1. **International cards.** Stripe adds a surcharge when the CARD was
 *     issued outside the US. A tenant paying on a non-US card costs ~4.4% +
 *     $0.30, not 2.9% + $0.30, a ~50% understatement of the fee line.
 *  2. **It was never checked against reality.** Nothing read what Stripe had
 *     really charged, so the gap could not surface.
 *
 * So a rate is resolved in two steps. When the Stripe fee sync
 * (src/lib/admin/cost-sync.ts) has observed real charges for a tenant, the
 * rate is DERIVED from them ({@link deriveStripeFeeRate}) and covers whatever
 * Stripe actually applied (international surcharge, Billing's recurring
 * percentage, currency conversion) without this module having to enumerate
 * those causes. Otherwise it falls back to an estimate keyed on the tenant's
 * resolved country ({@link stripeFeeRateForCountry}).
 *
 * Pure functions over plain numbers; nothing bills from these rates.
 */

import { ENTERPRISE_UNIT_COSTS } from "@/lib/plans/enterprise-pricing";
import type { BusinessCountry } from "@/lib/plans/business-country";

export type StripeFeeRate = {
  /** Fraction of the charge amount, e.g. 0.029. */
  percent: number;
  /** Flat cents per charge, e.g. 30. */
  fixedCents: number;
};

/** US card on a US account: Stripe's headline rate. */
export const DOMESTIC_STRIPE_FEE_RATE: StripeFeeRate = {
  percent: ENTERPRISE_UNIT_COSTS.stripePercent,
  fixedCents: ENTERPRISE_UNIT_COSTS.stripeFixedCentsPerCharge
};

/** Non-US card: the headline rate plus Stripe's international surcharge. */
export const INTERNATIONAL_STRIPE_FEE_RATE: StripeFeeRate = {
  percent:
    ENTERPRISE_UNIT_COSTS.stripePercent + ENTERPRISE_UNIT_COSTS.stripeInternationalPercent,
  fixedCents: ENTERPRISE_UNIT_COSTS.stripeFixedCentsPerCharge
};

/**
 * Fallback rate for a tenant with no observed charges yet.
 *
 * The signal is the tenant's own country (resolved from their phone /
 * timezone by `resolveBusinessCountry`), which is a PROXY for the card's
 * issuing country, not the thing Stripe charges on: a Canadian business can
 * pay on a US card and vice versa. It is the best guess available before the
 * fee sync sees a real charge, and it is only ever a fallback: observed
 * fees always win.
 */
export function stripeFeeRateForCountry(country: BusinessCountry): StripeFeeRate {
  return country === "US" ? DOMESTIC_STRIPE_FEE_RATE : INTERNATIONAL_STRIPE_FEE_RATE;
}

/**
 * A tenant's synced Stripe charge activity over the sync window, summed from
 * balance transactions (see `aggregateStripeFees`).
 */
export type ObservedStripeFees = {
  /** Gross charged, in cents. */
  grossCents: number;
  /** Stripe's total cut over the same charges, in cents. */
  feeCents: number;
  /** How many charges produced those totals (the $0.30 multiplier). */
  chargeCount: number;
};

/**
 * Plausible band for a DERIVED percentage rate. Stripe's real effective rate
 * on a card charge sits between the domestic headline (2.9%) and roughly
 * international + Billing + conversion stacked together; anything outside
 * this band means the window is not a clean read of ordinary card fees:
 * a dispute fee, a refund that returned the amount but not the fee, or a
 * payout/adjustment miscounted as a charge. Out-of-band derivations are
 * REJECTED rather than clamped, so the tenant falls back to the country
 * estimate instead of inheriting a garbage rate that looks authoritative.
 */
export const MIN_DERIVED_STRIPE_PERCENT = 0.02;
export const MAX_DERIVED_STRIPE_PERCENT = 0.08;

/**
 * Back out the percentage component of a tenant's real Stripe fees:
 *
 *     feeCents = grossCents × percent + fixedCents × chargeCount
 *
 * solved for `percent`. Returns null when there is nothing to derive from
 * (no charges, non-positive gross) or the result lands outside
 * {@link MIN_DERIVED_STRIPE_PERCENT}..{@link MAX_DERIVED_STRIPE_PERCENT}.
 * In every null case the caller should fall back to the country estimate.
 */
export function deriveStripeFeeRate(observed: ObservedStripeFees): StripeFeeRate | null {
  const { grossCents, feeCents, chargeCount } = observed;
  if (!Number.isFinite(grossCents) || !Number.isFinite(feeCents)) return null;
  if (!Number.isFinite(chargeCount) || chargeCount <= 0) return null;
  if (grossCents <= 0) return null;

  const fixedCents = ENTERPRISE_UNIT_COSTS.stripeFixedCentsPerCharge;
  const variableFeeCents = feeCents - fixedCents * chargeCount;
  // No separate finite check: both operands are finite and the divisor is
  // positive, so the quotient can only be finite or an infinity, and an
  // infinity fails the band check below like any other implausible rate.
  const percent = variableFeeCents / grossCents;
  if (percent < MIN_DERIVED_STRIPE_PERCENT) return null;
  if (percent > MAX_DERIVED_STRIPE_PERCENT) return null;
  return { percent, fixedCents };
}
