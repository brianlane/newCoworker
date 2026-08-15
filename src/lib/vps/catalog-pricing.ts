/**
 * Per-month normalization for Hostinger catalog prices.
 *
 * Catalog prices are quoted for a WHOLE billing period: the `-2y` price item
 * carries the total for 24 months, not a monthly rate. The existing
 * term-renewal sweep compares like with like (a 2y box's renewal against a
 * fresh 2y box's first period), so it can work in whole-period cents. The
 * contract-upgrade sweep cannot: it compares a MONTHLY box's renewal against
 * a 1y or 2y first period, and in whole-period cents that reads as the term
 * box being ~10x more expensive. Every upgrade would be silently skipped as
 * uneconomic, and the sweep would look healthy while doing nothing.
 *
 * So cross-term comparisons go through cents-per-month, derived from the
 * price row's own `period` / `period_unit` rather than from the term suffix
 * we asked for, so a catalog that reports a period we did not expect is
 * surfaced instead of silently mis-costed.
 */

import type { CatalogItem, CatalogPrice } from "@/lib/hostinger/client";
import { vpsPriceItemId, type HostingerBillingTerm } from "@/lib/hostinger/provision";
import type { VpsSize } from "@/lib/vps/size";

/**
 * Months covered by one cycle of this price row, or null when the row does
 * not describe a period we understand. Hostinger reports `period_unit` as
 * "month" or "year"; anything else (or a non-positive period) is refused
 * rather than guessed, because guessing here mis-prices a purchase.
 */
export function catalogPriceMonths(
  price: Pick<CatalogPrice, "period" | "period_unit">
): number | null {
  if (!Number.isFinite(price.period) || price.period <= 0) return null;
  if (price.period_unit === "month") return price.period;
  if (price.period_unit === "year") return price.period * 12;
  return null;
}

/** First-period cents from a catalog price row (`first_period_price ?? price`). */
export function catalogFirstPeriodCents(
  price: Pick<CatalogPrice, "price" | "first_period_price">
): number {
  return price.first_period_price ?? price.price;
}

/**
 * First-period cost expressed as cents per month, or null when the row's
 * period cannot be read. This is the only figure safe to compare across
 * different Hostinger terms.
 */
export function catalogFirstPeriodCentsPerMonth(price: CatalogPrice): number | null {
  const months = catalogPriceMonths(price);
  if (months === null) return null;
  return catalogFirstPeriodCents(price) / months;
}

/** The raw catalog price row for a size at a term, or null when absent. */
export function findCatalogPrice(
  catalog: CatalogItem[],
  size: VpsSize,
  term: HostingerBillingTerm
): CatalogPrice | null {
  const itemId = vpsPriceItemId(size, term);
  for (const item of catalog) {
    const price = item.prices.find((p) => p.id === itemId);
    if (price) return price;
  }
  return null;
}

/**
 * Monthly-equivalent cost of what the tenant is paying now, from their live
 * Hostinger billing subscription.
 *
 * `renewal_price` is the whole next cycle, so a 2y subscription's renewal
 * has to be spread across 24 months before it can be compared against a
 * monthly box. `cycleMonths` is the caller's best read of the subscription's
 * own cycle; null when unknown, which makes this return null rather than
 * quietly treating a two-year renewal as a monthly one.
 */
export function billingSubCentsPerMonth(
  sub: { renewal_price?: number; total_price?: number },
  cycleMonths: number | null
): number | null {
  if (cycleMonths === null || cycleMonths <= 0) return null;
  const cents = sub.renewal_price ?? sub.total_price;
  if (cents === undefined || !Number.isFinite(cents) || cents <= 0) return null;
  return cents / cycleMonths;
}

/**
 * Savings of `candidateCentsPerMonth` against `currentCentsPerMonth`, as a
 * ratio of the current rate. Negative when the candidate costs more. Zero
 * when the current rate is unusable, so an unknown baseline can never clear
 * a positive threshold.
 */
export function monthlySavingsRatio(
  currentCentsPerMonth: number | null,
  candidateCentsPerMonth: number | null
): number {
  if (currentCentsPerMonth === null || currentCentsPerMonth <= 0) return 0;
  if (candidateCentsPerMonth === null) return 0;
  return (currentCentsPerMonth - candidateCentsPerMonth) / currentCentsPerMonth;
}
