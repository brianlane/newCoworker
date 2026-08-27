/**
 * Recovering a Hostinger VPS subscription's REAL monthly cost when Hostinger
 * stops describing its own term correctly.
 *
 * The failure this exists for: a term change can move `next_billing_at`
 * without updating `billing_period` / `billing_period_unit` /
 * `renewal_price`. VM 1806097 (2026-08-26) bought a one-year period for
 * $155.88; Hostinger moved the date a full year out and still reported
 * "1 month" at $19.49. `cycleContradictsNextBilling` (box-term.ts) detects
 * that, and PR #1636 made the cost sync withhold the fabricated $19.49
 * rather than publish it as an actual. This module recovers the true figure.
 *
 * Three facts make it possible, and one makes it awkward:
 *
 *   - The catalog DOES carry the real prices, keyed by size and term:
 *     KVM 1 at 1 year is 15588 cents, exactly what was paid. It is the
 *     SUBSCRIPTION record that is stale, not the price list.
 *   - The term length is legible from how far the billing date JUMPED.
 *   - It is NOT legible from the span since purchase. `created_at` is the
 *     ORIGINAL purchase, so next_billing minus created covers the whole
 *     subscription life: 427 days for VM 1806097, which is 14 months, not
 *     the 12 that were bought (the box ran two monthly cycles first). The
 *     retired KVM8 showed the same shape at 91 days against a declared
 *     1 month. Only a subscription still inside its FIRST cycle measures
 *     correctly that way, so span-derivation is a trap that looks right on
 *     exactly the boxes that never needed it.
 *   - The awkward part: seeing a jump requires the previous value, and
 *     `hostinger_vps_costs` is full-replaced every sync. Hence the
 *     `hostinger_billing_terms` table, and hence {@link inferTermFromRunway}
 *     as a one-time bootstrap for changes that predate the recording.
 */

import { catalogPriceMonths, findCatalogPrice } from "@/lib/vps/catalog-pricing";
import { hostingerTermMonths, type HostingerBillingTerm } from "@/lib/hostinger/provision";
import type { CatalogItem } from "@/lib/hostinger/client";
import type { VpsSize } from "@/lib/vps/size";

const DAY_MS = 24 * 60 * 60 * 1000;
const AVG_DAYS_PER_MONTH = 30.44;

/** Every term Hostinger actually sells, longest first. */
export const HOSTINGER_TERMS: readonly HostingerBillingTerm[] = ["2y", "1y", "1m"] as const;

/**
 * How close remaining runway must sit to a catalog term before
 * {@link inferTermFromRunway} will claim that term, as a fraction of the
 * term's own length.
 *
 * Proportional rather than a fixed number of days because the terms are
 * orders of magnitude apart: 9 days off a 1-month term is a third of it and
 * means nothing, while 9 days off a 1-year term (VM 1806097 sits at 374 days
 * against 365) is rounding. 8% allows about 29 days on a year and 58 on two,
 * comfortably absorbing Hostinger billing a fortnight early, while still
 * refusing a box sitting halfway through its term.
 */
export const RUNWAY_MATCH_TOLERANCE = 0.08;

/** Months for a term, or null when the number is not one Hostinger sells. */
export function hostingerTermForMonths(months: number): HostingerBillingTerm | null {
  return HOSTINGER_TERMS.find((term) => hostingerTermMonths(term) === months) ?? null;
}

/**
 * Whole months between two instants, rounded to the nearest month, or null
 * when either date is unusable or the second is not after the first.
 *
 * Rounded because calendar months are uneven: a 12-month jump anchored on the
 * 5th spans 365 or 366 days depending on where the leap day falls, and both
 * must read as 12.
 */
export function monthsBetween(
  fromIso: string | null | undefined,
  toIso: string | null | undefined
): number | null {
  if (!fromIso || !toIso) return null;
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  const months = Math.round((to - from) / DAY_MS / AVG_DAYS_PER_MONTH);
  return months > 0 ? months : null;
}

/**
 * The term a subscription just bought, read from how far its billing date
 * moved between two syncs, or null when nothing conclusive happened.
 *
 * Requires the jump to exceed the declared cycle: a monthly box advancing one
 * month on its normal schedule is a renewal, not a term change, and must not
 * be reported as a 1-month "term purchase". The result must also be a term
 * Hostinger actually sells; a jump of some other size means something we do
 * not understand happened, and guessing a price for it is worse than
 * admitting we cannot.
 */
export function inferTermFromJump(
  previousNextBillingAt: string | null | undefined,
  nextBillingAt: string | null | undefined,
  declaredCycleMonths: number | null | undefined
): number | null {
  const jumped = monthsBetween(previousNextBillingAt, nextBillingAt);
  if (jumped === null) return null;
  const declared =
    typeof declaredCycleMonths === "number" && Number.isFinite(declaredCycleMonths)
      ? declaredCycleMonths
      : 1;
  if (jumped <= declared) return null;
  return hostingerTermForMonths(jumped) === null ? null : jumped;
}

/**
 * Bootstrap for a term change that happened BEFORE we started recording
 * billing dates: match the runway still remaining against the catalog terms.
 *
 * Deliberately narrow. This is only sound close to the START of a term,
 * because the runway shrinks every day while the term does not: a year-term
 * box read at month seven matches nothing, and forcing a match there would
 * invent a number. So it claims a term only within
 * {@link RUNWAY_MATCH_TOLERANCE}, returns null otherwise, and callers PERSIST
 * whatever it returns so the answer is computed once and then frozen rather
 * than re-derived from an ever-shrinking runway.
 */
export function inferTermFromRunway(
  nextBillingAt: string | null | undefined,
  now: Date = new Date()
): number | null {
  if (!nextBillingAt) return null;
  const at = Date.parse(nextBillingAt);
  if (!Number.isFinite(at)) return null;
  const daysLeft = (at - now.getTime()) / DAY_MS;
  if (daysLeft <= 0) return null;
  for (const term of HOSTINGER_TERMS) {
    const months = hostingerTermMonths(term);
    const termDays = months * AVG_DAYS_PER_MONTH;
    if (Math.abs(daysLeft - termDays) <= termDays * RUNWAY_MATCH_TOLERANCE) return months;
  }
  return null;
}

/**
 * Catalog cost per month for a size at a term, or null when the catalog does
 * not carry that combination.
 *
 * Uses the RENEWAL price (`price`), never `first_period_price`: the promo
 * applies to a box's first period only, and this is pricing a term already
 * running. Divides by the price row's OWN period rather than the term we
 * asked for, so a catalog that answers with an unexpected period surfaces as
 * null instead of being silently mis-costed (same rule as catalog-pricing).
 */
export function catalogMonthlyCentsForTerm(
  catalog: CatalogItem[],
  size: VpsSize,
  termMonths: number
): number | null {
  const term = hostingerTermForMonths(termMonths);
  if (term === null) return null;
  const price = findCatalogPrice(catalog, size, term);
  if (price === null) return null;
  const months = catalogPriceMonths(price);
  if (months === null || months <= 0) return null;
  if (!Number.isFinite(price.price) || price.price < 0) return null;
  return Math.round(price.price / months);
}

/**
 * Decide, for every VPS subscription in this sync, what term fact to store
 * and what monthly cost (if any) to publish.
 *
 * Pure: the caller does the reads and writes. That keeps the whole decision
 * table testable without a database or a Hostinger account, which matters
 * because the interesting cases (a jump, a bootstrap, a term that ends) are
 * awkward to reproduce live.
 *
 * The order of precedence is deliberate:
 *
 *   1. A JUMP beats everything. It is measured, not guessed, and it is how a
 *      term change is meant to be caught from here on.
 *   2. An EXISTING stored inference is kept while the billing date has not
 *      moved. This is what stops a bootstrap being re-derived from an
 *      ever-shrinking runway and silently expiring mid-term.
 *   3. A RUNWAY MATCH bootstraps a subscription we have never recorded, and
 *      only when the cycle is contradicted (a healthy box needs no rescue)
 *      and the runway sits squarely on a catalog term.
 *   4. Otherwise nothing is published, and the caller falls back to
 *      withholding the price, which is PR #1636's behavior.
 *
 * A subscription whose billing date moved but not by a whole extra term has
 * simply renewed: its stored inference is cleared, because a term that has
 * rolled over is no longer the term being paid for.
 */
export type TermInferenceInput = {
  subscriptionId: string;
  /** Plan label as Hostinger reports it, e.g. "KVM 1". */
  size: VpsSize | null;
  declaredCycleMonths: number | null;
  nextBillingAt: string | null;
  /** True when {@link cycleContradictsNextBilling} fired for this row. */
  cycleContradicted: boolean;
};

export type TermInferencePlan = {
  /** Rows to persist, one per subscription seen. */
  updates: Array<{
    subscription_id: string;
    observed_next_billing_at: string | null;
    term_months: number | null;
    monthly_cents: number | null;
    source: "jump" | "runway_match" | null;
    inferred_at: string | null;
  }>;
  /** subscriptionId -> monthly cents to publish as a real actual. */
  monthlyBySubscription: Map<string, number>;
};

export function planTermInference(params: {
  subscriptions: TermInferenceInput[];
  stored: Array<{
    subscription_id: string;
    observed_next_billing_at: string | null;
    term_months: number | null;
    monthly_cents: number | null;
    source: "jump" | "runway_match" | null;
    inferred_at: string | null;
  }>;
  catalog: CatalogItem[];
  now: Date;
}): TermInferencePlan {
  const storedById = new Map(params.stored.map((row) => [row.subscription_id, row]));
  const nowIso = params.now.toISOString();
  const updates: TermInferencePlan["updates"] = [];
  const monthlyBySubscription = new Map<string, number>();

  for (const sub of params.subscriptions) {
    const prior = storedById.get(sub.subscriptionId) ?? null;
    const priorDate = prior?.observed_next_billing_at ?? null;
    const dateMoved = priorDate !== null && priorDate !== sub.nextBillingAt;

    let termMonths: number | null = null;
    let source: "jump" | "runway_match" | null = null;
    let inferredAt: string | null = null;

    const jumped = inferTermFromJump(priorDate, sub.nextBillingAt, sub.declaredCycleMonths);
    if (jumped !== null) {
      termMonths = jumped;
      source = "jump";
      inferredAt = nowIso;
    } else if (prior !== null && prior.term_months !== null && !dateMoved) {
      // Held, not re-derived. Re-running the bootstrap here is exactly how a
      // correct answer would rot: the runway shrinks daily and would stop
      // matching its own term partway through.
      termMonths = prior.term_months;
      source = prior.source;
      inferredAt = prior.inferred_at;
    } else if (prior === null && sub.cycleContradicted) {
      const matched = inferTermFromRunway(sub.nextBillingAt, params.now);
      if (matched !== null) {
        termMonths = matched;
        source = "runway_match";
        inferredAt = nowIso;
      }
    }

    const monthlyCents =
      termMonths !== null && sub.size !== null
        ? catalogMonthlyCentsForTerm(params.catalog, sub.size, termMonths)
        : null;

    updates.push({
      subscription_id: sub.subscriptionId,
      observed_next_billing_at: sub.nextBillingAt,
      term_months: termMonths,
      monthly_cents: monthlyCents,
      source: termMonths === null ? null : source,
      inferred_at: termMonths === null ? null : inferredAt
    });

    // Only publish where the derived figure is untrustworthy. A healthy box's
    // own renewal price is the better number: it reflects whatever promo or
    // legacy rate it actually pays, which the catalog cannot know.
    if (sub.cycleContradicted && monthlyCents !== null) {
      monthlyBySubscription.set(sub.subscriptionId, monthlyCents);
    }
  }

  return { updates, monthlyBySubscription };
}
