import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearPackPriceCache,
  resolvePackChargeAmount
} from "@/lib/billing/auto-reload-pricing";

/**
 * The pricing guard. On the manual Checkout path a catalog/Stripe price drift
 * is visible to the customer before they pay; on the auto-reload path nobody
 * sees a page, so a drift would silently bill the wrong amount on a schedule.
 * Every branch here either agrees with the catalog or refuses to charge.
 */

function stripeWith(price: Record<string, unknown>) {
  const retrieve = vi.fn(async () => price as never);
  return { stripe: { prices: { retrieve } }, retrieve };
}

const ONE_TIME = { unit_amount: 1_000, currency: "usd", active: true, type: "one_time" };

beforeEach(() => {
  clearPackPriceCache();
  vi.clearAllMocks();
});

describe("resolvePackChargeAmount", () => {
  it("returns the Stripe amount when it agrees with the catalog", async () => {
    const { stripe } = stripeWith(ONE_TIME);
    expect(
      await resolvePackChargeAmount({ stripe, priceId: "price_1", catalogPriceCents: 1_000 })
    ).toEqual({ ok: true, amountCents: 1_000, currency: "usd" });
  });

  it("carries a non-USD currency through rather than assuming dollars", async () => {
    const { stripe } = stripeWith({ ...ONE_TIME, currency: "cad" });
    const res = await resolvePackChargeAmount({
      stripe,
      priceId: "price_cad",
      catalogPriceCents: 1_000
    });
    expect(res).toMatchObject({ ok: true, currency: "cad" });
  });

  it("refuses when Stripe and the catalog disagree, and says by how much", async () => {
    const { stripe } = stripeWith({ ...ONE_TIME, unit_amount: 1_500 });
    expect(
      await resolvePackChargeAmount({ stripe, priceId: "price_1", catalogPriceCents: 1_000 })
    ).toEqual({ ok: false, reason: "price_mismatch", stripeCents: 1_500, catalogCents: 1_000 });
  });

  it("refuses a price with no amount", async () => {
    const nullAmount = stripeWith({ ...ONE_TIME, unit_amount: null });
    expect(
      await resolvePackChargeAmount({
        stripe: nullAmount.stripe,
        priceId: "price_1",
        catalogPriceCents: 1_000
      })
    ).toEqual({ ok: false, reason: "price_missing" });

    clearPackPriceCache();
    const undef = stripeWith({ currency: "usd", active: true, type: "one_time" });
    expect(
      await resolvePackChargeAmount({
        stripe: undef.stripe,
        priceId: "price_2",
        catalogPriceCents: 1_000
      })
    ).toEqual({ ok: false, reason: "price_missing" });
  });

  it("refuses an archived price", async () => {
    const { stripe } = stripeWith({ ...ONE_TIME, active: false });
    expect(
      await resolvePackChargeAmount({ stripe, priceId: "price_1", catalogPriceCents: 1_000 })
    ).toEqual({ ok: false, reason: "price_inactive" });
  });

  it("refuses a recurring price", async () => {
    // A recurring SKU here would mean the catalog points at a subscription
    // price, which would charge the wrong thing on a schedule.
    const { stripe } = stripeWith({ ...ONE_TIME, type: "recurring" });
    expect(
      await resolvePackChargeAmount({ stripe, priceId: "price_1", catalogPriceCents: 1_000 })
    ).toEqual({ ok: false, reason: "price_not_one_time" });
  });

  it("caches so a sweep over many tenants is not N Stripe reads", async () => {
    const { stripe, retrieve } = stripeWith(ONE_TIME);
    const args = { stripe, priceId: "price_1", catalogPriceCents: 1_000, nowMs: 1_000 };
    await resolvePackChargeAmount(args);
    await resolvePackChargeAmount({ ...args, nowMs: 2_000 });
    await resolvePackChargeAmount({ ...args, nowMs: 60_000 });
    expect(retrieve).toHaveBeenCalledTimes(1);
  });

  it("re-reads once the cache entry is stale", async () => {
    const { stripe, retrieve } = stripeWith(ONE_TIME);
    const args = { stripe, priceId: "price_1", catalogPriceCents: 1_000 };
    await resolvePackChargeAmount({ ...args, nowMs: 0 });
    await resolvePackChargeAmount({ ...args, nowMs: 5 * 60 * 1000 + 1 });
    expect(retrieve).toHaveBeenCalledTimes(2);
  });

  it("still catches a mismatch against a cached price", async () => {
    // The cache must not become a way for a drift to slip through on the
    // second tenant of a sweep.
    const { stripe } = stripeWith(ONE_TIME);
    await resolvePackChargeAmount({ stripe, priceId: "price_1", catalogPriceCents: 1_000 });
    expect(
      await resolvePackChargeAmount({ stripe, priceId: "price_1", catalogPriceCents: 1_500 })
    ).toMatchObject({ ok: false, reason: "price_mismatch" });
  });

  it("defaults nowMs to the wall clock", async () => {
    const { stripe, retrieve } = stripeWith(ONE_TIME);
    await resolvePackChargeAmount({ stripe, priceId: "price_now", catalogPriceCents: 1_000 });
    await resolvePackChargeAmount({ stripe, priceId: "price_now", catalogPriceCents: 1_000 });
    expect(retrieve).toHaveBeenCalledTimes(1);
  });
});
