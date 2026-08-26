import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockSubRetrieve = vi.fn();
const mockSubUpdate = vi.fn();
const mockCouponCreate = vi.fn();
const mockCouponDel = vi.fn();

vi.mock("stripe", () => {
  class MockStripe {
    subscriptions = { retrieve: mockSubRetrieve, update: mockSubUpdate };
    coupons = { create: mockCouponCreate, del: mockCouponDel };
  }
  return { default: MockStripe };
});

vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() }
}));

import { logger } from "@/lib/logger";
import {
  applyMembershipDiscount,
  planProductIdFromSubscription,
  removeMembershipDiscount
} from "@/lib/stripe/subscription-discount";

const DISCOUNT = {
  percentOff: 30,
  amountOffCents: null,
  duration: "forever" as const,
  durationInMonths: null
};

/**
 * A subscription in this fleet's usual shape: plan first, add-ons after. The
 * second item is the Canadian messaging surcharge, which the coupon must NOT
 * be scoped to.
 */
function subscriptionWithAddOn() {
  return {
    id: "sub_1",
    items: {
      data: [
        { price: { id: "price_plan", product: "prod_plan" } },
        { price: { id: "price_ca_fee", product: "prod_ca_fee" } }
      ]
    }
  };
}

describe("stripe/subscription-discount", () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...OLD_ENV, STRIPE_SECRET_KEY: "sk_test_mock" };
    mockSubRetrieve.mockResolvedValue(subscriptionWithAddOn());
    mockCouponCreate.mockResolvedValue({ id: "co_new" });
    mockSubUpdate.mockResolvedValue({ id: "sub_1", discounts: [] });
    mockCouponDel.mockResolvedValue({ id: "co_new", deleted: true });
  });

  afterEach(() => {
    process.env = OLD_ENV;
  });

  describe("planProductIdFromSubscription", () => {
    it("takes the product off the PLAN item, not an add-on", () => {
      expect(planProductIdFromSubscription(subscriptionWithAddOn() as never)).toBe("prod_plan");
    });

    it("reads an expanded product object as well as an id", () => {
      expect(
        planProductIdFromSubscription({
          id: "sub_1",
          items: { data: [{ price: { product: { id: "prod_expanded" } } }] }
        } as never)
      ).toBe("prod_expanded");
    });

    it("refuses a subscription with no items rather than discounting nothing", () => {
      expect(() =>
        planProductIdFromSubscription({ id: "sub_empty", items: { data: [] } } as never)
      ).toThrow(/no items to discount/);
    });
  });

  describe("applyMembershipDiscount", () => {
    it("scopes the coupon to the tenant's own plan product and attaches it", async () => {
      const result = await applyMembershipDiscount({
        subscriptionId: "sub_1",
        label: "Retention credit",
        discount: DISCOUNT,
        metadata: { businessId: "biz-1" }
      });

      expect(mockCouponCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "Retention credit",
          percent_off: 30,
          duration: "forever",
          // The surcharge product is deliberately absent: an unscoped coupon
          // would discount pass-through fees the platform still pays out.
          applies_to: { products: ["prod_plan"] },
          metadata: { businessId: "biz-1" }
        })
      );
      expect(mockSubUpdate).toHaveBeenCalledWith("sub_1", {
        discounts: [{ coupon: "co_new" }],
        expand: ["discounts.source.coupon"]
      });
      expect(result.couponId).toBe("co_new");
      expect(mockCouponDel).not.toHaveBeenCalled();
    });

    it("retires the coupon it replaced, once the new one is attached", async () => {
      await applyMembershipDiscount({
        subscriptionId: "sub_1",
        label: "Bigger comp",
        discount: DISCOUNT,
        metadata: {},
        previousCouponId: "co_old"
      });
      // Detaching does not delete the coupon object, so without this a
      // re-comped tenant leaves an orphan behind on every change.
      expect(mockCouponDel).toHaveBeenCalledWith("co_old");
    });

    it("does not delete anything when there was no previous coupon", async () => {
      await applyMembershipDiscount({
        subscriptionId: "sub_1",
        label: "First comp",
        discount: DISCOUNT,
        metadata: {},
        previousCouponId: null
      });
      expect(mockCouponDel).not.toHaveBeenCalled();
    });

    it("never deletes the coupon it just attached, even if the ids match", async () => {
      mockCouponCreate.mockResolvedValue({ id: "co_same" });
      await applyMembershipDiscount({
        subscriptionId: "sub_1",
        label: "Same id",
        discount: DISCOUNT,
        metadata: {},
        previousCouponId: "co_same"
      });
      expect(mockCouponDel).not.toHaveBeenCalled();
    });

    it("keeps the apply successful when retiring the replaced coupon fails", async () => {
      mockCouponDel.mockRejectedValue(new Error("already deleted"));
      await expect(
        applyMembershipDiscount({
          subscriptionId: "sub_1",
          label: "Bigger comp",
          discount: DISCOUNT,
          metadata: {},
          previousCouponId: "co_old"
        })
      ).resolves.toMatchObject({ couponId: "co_new" });
      expect(logger.warn).toHaveBeenCalled();
    });

    it("deletes the coupon it just minted when the attach fails", async () => {
      mockSubUpdate.mockRejectedValue(new Error("No such subscription"));

      await expect(
        applyMembershipDiscount({
          subscriptionId: "sub_1",
          label: "Retention credit",
          discount: DISCOUNT,
          metadata: {}
        })
      ).rejects.toThrow("No such subscription");

      // Otherwise a rejected apply litters the Stripe account with coupons
      // that were never applied to anything.
      expect(mockCouponDel).toHaveBeenCalledWith("co_new");
    });

    it("still surfaces the attach failure when the cleanup delete also fails", async () => {
      mockSubUpdate.mockRejectedValue(new Error("attach exploded"));
      mockCouponDel.mockRejectedValue(new Error("delete exploded"));

      await expect(
        applyMembershipDiscount({
          subscriptionId: "sub_1",
          label: "Retention credit",
          discount: DISCOUNT,
          metadata: {}
        })
      ).rejects.toThrow("attach exploded");
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("coupon cleanup failed"),
        expect.objectContaining({ couponId: "co_new" })
      );
    });
  });

  describe("removeMembershipDiscount", () => {
    it("detaches first, then retires the coupon", async () => {
      const order: string[] = [];
      mockSubUpdate.mockImplementation(async () => {
        order.push("update");
        return { id: "sub_1", discounts: [] };
      });
      mockCouponDel.mockImplementation(async () => {
        order.push("del");
        return { deleted: true };
      });

      await removeMembershipDiscount({ subscriptionId: "sub_1", couponId: "co_old" });

      expect(mockSubUpdate).toHaveBeenCalledWith("sub_1", {
        discounts: "",
        expand: ["discounts.source.coupon"]
      });
      // Deleting a Stripe coupon does not revoke it from anyone who already
      // has it, so detaching has to happen first or the customer keeps the
      // discount while the object disappears.
      expect(order).toEqual(["update", "del"]);
    });

    it("skips the delete when no coupon id was mirrored", async () => {
      await removeMembershipDiscount({ subscriptionId: "sub_1", couponId: null });
      expect(mockSubUpdate).toHaveBeenCalled();
      expect(mockCouponDel).not.toHaveBeenCalled();
    });

    it("treats a failed coupon delete as non-fatal once the detach landed", async () => {
      mockCouponDel.mockRejectedValue(new Error("already deleted"));
      await expect(
        removeMembershipDiscount({ subscriptionId: "sub_1", couponId: "co_old" })
      ).resolves.toMatchObject({ id: "sub_1" });
      expect(logger.warn).toHaveBeenCalled();
    });

    it("propagates a failed detach, because that is the step that stops the money", async () => {
      mockSubUpdate.mockRejectedValue(new Error("Stripe down"));
      await expect(
        removeMembershipDiscount({ subscriptionId: "sub_1", couponId: "co_old" })
      ).rejects.toThrow("Stripe down");
      expect(mockCouponDel).not.toHaveBeenCalled();
    });

    it("logs a non-Error cleanup rejection without losing the reason", async () => {
      mockCouponDel.mockRejectedValue("plain string rejection");
      await removeMembershipDiscount({ subscriptionId: "sub_1", couponId: "co_old" });
      expect(logger.warn).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ error: "plain string rejection" })
      );
    });
  });
});
