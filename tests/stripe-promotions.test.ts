import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockPriceRetrieve = vi.fn();
const mockCouponCreate = vi.fn();
const mockCouponDel = vi.fn();
const mockPromotionCodeCreate = vi.fn();
const mockPromotionCodeUpdate = vi.fn();

vi.mock("stripe", () => {
  class MockStripe {
    prices = { retrieve: mockPriceRetrieve };
    coupons = { create: mockCouponCreate, del: mockCouponDel };
    promotionCodes = { create: mockPromotionCodeCreate, update: mockPromotionCodeUpdate };
  }
  return { default: MockStripe };
});

vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() }
}));

import { logger } from "@/lib/logger";
import {
  createPromotionCoupon,
  deletePromotionCoupon,
  replacePromotionCoupon,
  resolveMembershipProductIds,
  setPromotionCodeActive
} from "@/lib/stripe/promotions";

const PERCENT_DISCOUNT = {
  percentOff: 20,
  amountOffCents: null,
  duration: "once" as const,
  durationInMonths: null
};

describe("stripe/promotions", () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = {
      ...OLD_ENV,
      STRIPE_SECRET_KEY: "sk_test_mock",
      STRIPE_STARTER_24MO_PRICE_ID: "price_starter_24mo",
      STRIPE_STARTER_12MO_PRICE_ID: "price_starter_12mo",
      STRIPE_STARTER_1MO_PRICE_ID: "price_starter_1mo",
      STRIPE_STANDARD_24MO_PRICE_ID: "price_standard_24mo",
      STRIPE_STANDARD_12MO_PRICE_ID: "price_standard_12mo",
      STRIPE_STANDARD_1MO_PRICE_ID: "price_standard_1mo"
    };
    mockPriceRetrieve.mockImplementation(async (priceId: string) => ({
      id: priceId,
      product: priceId.includes("starter") ? "prod_starter" : "prod_standard"
    }));
    mockCouponCreate.mockResolvedValue({ id: "coupon_new" });
    mockPromotionCodeCreate.mockResolvedValue({ id: "promo_new" });
    mockPromotionCodeUpdate.mockResolvedValue({ id: "promo_old" });
    mockCouponDel.mockResolvedValue({ id: "coupon_old", deleted: true });
  });

  afterEach(() => {
    process.env = OLD_ENV;
  });

  describe("resolveMembershipProductIds", () => {
    it("dedupes the products behind a tier's three period prices", async () => {
      await expect(resolveMembershipProductIds(["starter"])).resolves.toEqual(["prod_starter"]);
      expect(mockPriceRetrieve).toHaveBeenCalledTimes(3);
    });

    it("covers every allowed tier", async () => {
      await expect(resolveMembershipProductIds(["starter", "standard"])).resolves.toEqual([
        "prod_starter",
        "prod_standard"
      ]);
    });

    it("reads the product id off an expanded product object", async () => {
      mockPriceRetrieve.mockResolvedValue({ id: "price_x", product: { id: "prod_expanded" } });
      await expect(resolveMembershipProductIds(["standard"])).resolves.toEqual(["prod_expanded"]);
    });

    it("fails closed when a plan price is not configured", async () => {
      delete process.env.STRIPE_STANDARD_1MO_PRICE_ID;
      await expect(resolveMembershipProductIds(["standard"])).rejects.toThrow(
        "Stripe Price ID not configured"
      );
    });
  });

  describe("createPromotionCoupon", () => {
    it("mints a percentage coupon restricted to the membership products", async () => {
      await expect(
        createPromotionCoupon({
          code: "SUMMER20",
          name: "Summer 2026",
          tiers: ["standard"],
          discount: PERCENT_DISCOUNT
        })
      ).resolves.toEqual({ couponId: "coupon_new", promotionCodeId: "promo_new" });

      expect(mockCouponCreate).toHaveBeenCalledWith({
        name: "Summer 2026",
        duration: "once",
        percent_off: 20,
        applies_to: { products: ["prod_standard"] }
      });
      expect(mockPromotionCodeCreate).toHaveBeenCalledWith({
        promotion: { type: "coupon", coupon: "coupon_new" },
        code: "SUMMER20"
      });
    });

    it("mints a fixed-amount coupon in USD", async () => {
      await createPromotionCoupon({
        code: "FIFTYOFF",
        name: "Fifty off",
        tiers: ["starter"],
        discount: {
          percentOff: null,
          amountOffCents: 5000,
          duration: "repeating",
          durationInMonths: 3
        }
      });
      expect(mockCouponCreate).toHaveBeenCalledWith({
        name: "Fifty off",
        duration: "repeating",
        duration_in_months: 3,
        amount_off: 5000,
        currency: "usd",
        applies_to: { products: ["prod_starter"] }
      });
    });

    it("treats a shapeless amount as zero rather than sending undefined to Stripe", async () => {
      await createPromotionCoupon({
        code: "BROKEN",
        name: "Broken",
        tiers: ["starter"],
        discount: {
          percentOff: null,
          amountOffCents: null,
          duration: "forever",
          durationInMonths: null
        }
      });
      expect(mockCouponCreate.mock.calls[0][0]).toMatchObject({ amount_off: 0, currency: "usd" });
    });

    it("deletes the orphaned coupon when the code collides with an active one", async () => {
      mockPromotionCodeCreate.mockRejectedValue(new Error("code already exists"));
      await expect(
        createPromotionCoupon({
          code: "SUMMER20",
          name: "Summer",
          tiers: ["starter"],
          discount: PERCENT_DISCOUNT
        })
      ).rejects.toThrow("code already exists");
      expect(mockCouponDel).toHaveBeenCalledWith("coupon_new");
    });

    it.each([
      ["an Error", new Error("network down"), "network down"],
      ["a thrown string", "network down", "network down"]
    ])("logs %s and still rethrows when even the cleanup delete fails", async (_label, thrown, logged) => {
      mockPromotionCodeCreate.mockRejectedValue(new Error("code already exists"));
      mockCouponDel.mockRejectedValue(thrown);
      await expect(
        createPromotionCoupon({
          code: "SUMMER20",
          name: "Summer",
          tiers: ["starter"],
          discount: PERCENT_DISCOUNT
        })
      ).rejects.toThrow("code already exists");
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("orphaned Stripe coupon"),
        expect.objectContaining({ couponId: "coupon_new", error: logged })
      );
    });
  });

  describe("setPromotionCodeActive", () => {
    it("flips the Stripe code's active flag", async () => {
      await setPromotionCodeActive("promo_1", false);
      expect(mockPromotionCodeUpdate).toHaveBeenCalledWith("promo_1", { active: false });
    });
  });

  describe("replacePromotionCoupon", () => {
    it("retires the old code, mints a replacement, and leaves the old coupon alone", async () => {
      await expect(
        replacePromotionCoupon({
          previous: { couponId: "coupon_old", promotionCodeId: "promo_old" },
          code: "SUMMER20",
          name: "Summer 2026",
          tiers: ["standard"],
          discount: { ...PERCENT_DISCOUNT, percentOff: 30 }
        })
      ).resolves.toEqual({ couponId: "coupon_new", promotionCodeId: "promo_new" });

      expect(mockPromotionCodeUpdate).toHaveBeenCalledWith("promo_old", { active: false });
      // A Checkout Session minted seconds before the edit still points at it.
      expect(mockCouponDel).not.toHaveBeenCalled();
    });

    it("re-activates the old code when the replacement cannot be minted", async () => {
      mockCouponCreate.mockRejectedValue(new Error("stripe down"));
      await expect(
        replacePromotionCoupon({
          previous: { couponId: "coupon_old", promotionCodeId: "promo_old" },
          code: "SUMMER20",
          name: "Summer",
          tiers: ["starter"],
          discount: PERCENT_DISCOUNT
        })
      ).rejects.toThrow("stripe down");
      expect(mockPromotionCodeUpdate).toHaveBeenNthCalledWith(1, "promo_old", { active: false });
      expect(mockPromotionCodeUpdate).toHaveBeenNthCalledWith(2, "promo_old", { active: true });
    });

    it.each([
      ["an Error", new Error("still down"), "still down"],
      ["a thrown string", "still down", "still down"]
    ])("logs %s when the restore itself fails, and still surfaces the original error", async (_label, thrown, logged) => {
      mockCouponCreate.mockRejectedValue(new Error("stripe down"));
      mockPromotionCodeUpdate
        .mockResolvedValueOnce({ id: "promo_old" })
        .mockRejectedValueOnce(thrown);
      await expect(
        replacePromotionCoupon({
          previous: { couponId: "coupon_old", promotionCodeId: "promo_old" },
          code: "SUMMER20",
          name: "Summer",
          tiers: ["starter"],
          discount: PERCENT_DISCOUNT
        })
      ).rejects.toThrow("stripe down");
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("could not re-activate"),
        expect.objectContaining({ promotionCodeId: "promo_old", error: logged })
      );
    });
  });

  describe("deletePromotionCoupon", () => {
    it("deactivates the code and deletes the coupon", async () => {
      await deletePromotionCoupon({ couponId: "coupon_1", promotionCodeId: "promo_1" });
      expect(mockPromotionCodeUpdate).toHaveBeenCalledWith("promo_1", { active: false });
      expect(mockCouponDel).toHaveBeenCalledWith("coupon_1");
    });
  });
});
