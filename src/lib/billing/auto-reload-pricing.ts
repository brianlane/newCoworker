/**
 * Resolve what an auto-reload charge should actually cost.
 *
 * The pack catalogs carry both a Stripe Price id and a `priceCents` figure,
 * and keeping the two in step is an operator contract enforced only by deploy
 * discipline. On the manual Checkout path a drift is harmless-ish: Stripe
 * renders the real price and the customer sees it before paying. On the
 * auto-reload path nobody looks at a page, so a drift would silently charge
 * the wrong amount, unattended, on a schedule.
 *
 * So the amount comes from Stripe and a mismatch is a hard stop, not a
 * warning. That converts a silent overcharge into a loud, fixable pause at
 * the one place the pricing contract can cost real money with no human in
 * the loop.
 */
import type Stripe from "stripe";

export type ResolvedPackPrice =
  | { ok: true; amountCents: number; currency: string }
  | {
      ok: false;
      reason: "price_missing" | "price_inactive" | "price_not_one_time" | "price_mismatch";
      stripeCents?: number;
      catalogCents?: number;
    };

type PriceCacheEntry = { amountCents: number; currency: string; fetchedAtMs: number };

const PRICE_CACHE_TTL_MS = 5 * 60 * 1000;
const priceCache = new Map<string, PriceCacheEntry>();

/** Test seam: a sweep over many tenants must not re-read the same price N times. */
export function clearPackPriceCache(): void {
  priceCache.clear();
}

export type PackPriceStripe = {
  prices: { retrieve: (id: string) => Promise<Stripe.Price> };
};

export async function resolvePackChargeAmount(params: {
  stripe: PackPriceStripe;
  priceId: string;
  catalogPriceCents: number;
  nowMs?: number;
}): Promise<ResolvedPackPrice> {
  const nowMs = params.nowMs ?? Date.now();
  const cached = priceCache.get(params.priceId);
  if (cached && nowMs - cached.fetchedAtMs < PRICE_CACHE_TTL_MS) {
    return comparePrice(cached.amountCents, cached.currency, params.catalogPriceCents);
  }

  const price = await params.stripe.prices.retrieve(params.priceId);
  if (price.unit_amount === null || price.unit_amount === undefined) {
    return { ok: false, reason: "price_missing" };
  }
  if (!price.active) {
    return { ok: false, reason: "price_inactive" };
  }
  if (price.type !== "one_time") {
    // A recurring price here would mean the catalog points at a subscription
    // SKU, which would charge the wrong thing on a schedule.
    return { ok: false, reason: "price_not_one_time" };
  }

  priceCache.set(params.priceId, {
    amountCents: price.unit_amount,
    currency: price.currency,
    fetchedAtMs: nowMs
  });

  return comparePrice(price.unit_amount, price.currency, params.catalogPriceCents);
}

function comparePrice(
  stripeCents: number,
  currency: string,
  catalogCents: number
): ResolvedPackPrice {
  if (stripeCents !== catalogCents) {
    return { ok: false, reason: "price_mismatch", stripeCents, catalogCents };
  }
  return { ok: true, amountCents: stripeCents, currency };
}
