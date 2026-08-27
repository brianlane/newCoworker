import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ requireAdmin: vi.fn() }));

vi.mock("@/lib/db/promotions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db/promotions")>();
  return {
    ...actual,
    createPromotion: vi.fn(),
    getPromotion: vi.fn(),
    getPromotionByCode: vi.fn(),
    updatePromotion: vi.fn(),
    deletePromotion: vi.fn(),
    countPromotionRedemptions: vi.fn()
  };
});

vi.mock("@/lib/db/businesses", () => ({ listBusinesses: vi.fn() }));
vi.mock("@/lib/promotions/stats", () => ({ listPromotionsWithStats: vi.fn() }));

vi.mock("@/lib/stripe/promotions", () => ({
  createPromotionCoupon: vi.fn(),
  deletePromotionCoupon: vi.fn(),
  replacePromotionCoupon: vi.fn(),
  setPromotionCodeActive: vi.fn()
}));

import { POST, GET, PATCH, DELETE } from "@/app/api/admin/promotions/route";
import { requireAdmin } from "@/lib/auth";
import {
  countPromotionRedemptions,
  createPromotion,
  deletePromotion,
  getPromotion,
  getPromotionByCode,
  updatePromotion,
  type PromotionRow
} from "@/lib/db/promotions";
import { listBusinesses } from "@/lib/db/businesses";
import { listPromotionsWithStats } from "@/lib/promotions/stats";
import {
  createPromotionCoupon,
  deletePromotionCoupon,
  replacePromotionCoupon,
  setPromotionCodeActive
} from "@/lib/stripe/promotions";

const PROMO_ID = "22222222-2222-4222-8222-222222222222";
const BIZ_ID = "11111111-1111-4111-8111-111111111111";

const PROMO: PromotionRow = {
  id: PROMO_ID,
  code: "SUMMER20",
  name: "Summer 2026",
  percent_off: 20,
  amount_off_cents: null,
  duration: "once",
  duration_in_months: null,
  allowed_tiers: ["starter", "standard"],
  allowed_periods: ["monthly", "annual", "biennial"],
  starts_at: "2026-07-01T00:00:00Z",
  ends_at: null,
  max_redemptions: null,
  active: true,
  stripe_coupon_id: "coupon_1",
  stripe_promotion_code_id: "promo_1",
  created_by: "admin@example.com",
  created_at: "2026-07-01T00:00:00Z",
  updated_at: "2026-07-01T00:00:00Z"
};

function post(body: unknown) {
  return new Request("http://localhost/api/admin/promotions", {
    method: "POST",
    body: JSON.stringify(body)
  });
}
function patch(body: unknown) {
  return new Request("http://localhost/api/admin/promotions", {
    method: "PATCH",
    body: JSON.stringify(body)
  });
}
function del(body: unknown) {
  return new Request("http://localhost/api/admin/promotions", {
    method: "DELETE",
    body: JSON.stringify(body)
  });
}

const VALID_CREATE = {
  code: "summer20",
  name: "Summer 2026",
  percentOff: 20,
  allowedTiers: ["starter", "standard"],
  allowedPeriods: ["monthly", "annual", "biennial"]
};

describe("api/admin/promotions route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireAdmin).mockResolvedValue({
      userId: "admin-1",
      email: "admin@example.com",
      isAdmin: true
    } as never);
    vi.mocked(getPromotionByCode).mockResolvedValue(null);
    vi.mocked(createPromotionCoupon).mockResolvedValue({
      couponId: "coupon_1",
      promotionCodeId: "promo_1"
    });
    vi.mocked(createPromotion).mockResolvedValue(PROMO);
    vi.mocked(getPromotion).mockResolvedValue(PROMO);
    vi.mocked(updatePromotion).mockResolvedValue(PROMO);
    vi.mocked(countPromotionRedemptions).mockResolvedValue(0);
    vi.mocked(deletePromotion).mockResolvedValue(true);
    // clearAllMocks resets calls but keeps implementations, so the Stripe
    // doubles are re-armed here or a rejection from one test leaks into
    // the next.
    vi.mocked(deletePromotionCoupon).mockResolvedValue(undefined);
    vi.mocked(setPromotionCodeActive).mockResolvedValue(undefined);
  });

  describe("POST", () => {
    it("uppercases the code, mints the Stripe pair, and inserts the row", async () => {
      const res = await POST(post(VALID_CREATE));
      expect(res.status).toBe(200);
      expect(createPromotionCoupon).toHaveBeenCalledWith(
        expect.objectContaining({
          code: "SUMMER20",
          discount: { percentOff: 20, amountOffCents: null, duration: "once", durationInMonths: null }
        })
      );
      expect(createPromotion).toHaveBeenCalledWith(
        expect.objectContaining({
          code: "SUMMER20",
          percentOff: 20,
          amountOffCents: null,
          stripeCouponId: "coupon_1",
          stripePromotionCodeId: "promo_1",
          createdBy: "admin@example.com"
        })
      );
      expect(setPromotionCodeActive).not.toHaveBeenCalled();
    });

    it("gives Stripe the cap to enforce, since our own count is racy", async () => {
      await POST(post({ ...VALID_CREATE, maxRedemptions: 50 }));
      expect(createPromotionCoupon).toHaveBeenCalledWith(
        expect.objectContaining({ remainingRedemptions: 50 })
      );
    });

    it("leaves an uncapped promotion uncapped at Stripe", async () => {
      await POST(post(VALID_CREATE));
      expect(createPromotionCoupon).toHaveBeenCalledWith(
        expect.objectContaining({ remainingRedemptions: null })
      );
    });

    it("converts a whole-dollar amount to cents", async () => {
      await POST(post({ ...VALID_CREATE, percentOff: null, amountOffUsd: 25.5 }));
      expect(createPromotion).toHaveBeenCalledWith(
        expect.objectContaining({ percentOff: null, amountOffCents: 2550 })
      );
    });

    it("refuses a code that already exists", async () => {
      vi.mocked(getPromotionByCode).mockResolvedValue(PROMO);
      const res = await POST(post(VALID_CREATE));
      expect(res.status).toBe(409);
      expect(createPromotionCoupon).not.toHaveBeenCalled();
    });

    it("refuses both discount shapes at once, and neither", async () => {
      const both = await POST(post({ ...VALID_CREATE, amountOffUsd: 25 }));
      expect(both.status).toBe(400);
      const neither = await POST(post({ ...VALID_CREATE, percentOff: null }));
      expect(neither.status).toBe(400);
    });

    it("refuses a repeating promotion with no month count", async () => {
      const res = await POST(post({ ...VALID_CREATE, duration: "repeating" }));
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({
        error: { message: expect.stringContaining("number of months") }
      });
    });

    it("refuses a month count on a non-repeating promotion", async () => {
      const res = await POST(post({ ...VALID_CREATE, durationInMonths: 3 }));
      expect(res.status).toBe(400);
    });

    it("refuses an end date that is not after the start date", async () => {
      const res = await POST(
        post({
          ...VALID_CREATE,
          startsAt: "2026-08-01T00:00:00.000Z",
          endsAt: "2026-08-01T00:00:00.000Z"
        })
      );
      expect(res.status).toBe(400);
    });

    it("rejects a code with characters Stripe will not accept", async () => {
      const res = await POST(post({ ...VALID_CREATE, code: "SUMMER 20%" }));
      expect(res.status).toBe(400);
    });

    it("switches the Stripe code off when the promotion is created inactive", async () => {
      await POST(post({ ...VALID_CREATE, active: false }));
      expect(setPromotionCodeActive).toHaveBeenCalledWith("promo_1", false);
    });

    it("takes the Stripe objects back out when the row insert fails", async () => {
      vi.mocked(createPromotion).mockRejectedValue(new Error("duplicate key"));
      const res = await POST(post(VALID_CREATE));
      expect(res.status).toBe(500);
      expect(deletePromotionCoupon).toHaveBeenCalledWith({
        couponId: "coupon_1",
        promotionCodeId: "promo_1"
      });
    });

    it("still surfaces the insert failure when the Stripe cleanup also fails", async () => {
      vi.mocked(createPromotion).mockRejectedValue(new Error("duplicate key"));
      vi.mocked(deletePromotionCoupon).mockRejectedValue(new Error("stripe down"));
      const res = await POST(post(VALID_CREATE));
      expect(res.status).toBe(500);
    });
  });

  describe("GET", () => {
    it("returns promotions with stats and resolved business names", async () => {
      vi.mocked(listPromotionsWithStats).mockResolvedValue([
        {
          ...PROMO,
          lifecycle: "active",
          stats: { redemptionCount: 1, totalDiscountedCents: 47520, lastRedeemedAt: "x" },
          redemptions: [
            {
              id: "r1",
              promotion_id: PROMO_ID,
              business_id: BIZ_ID,
              tier: "standard",
              billing_period: "biennial",
              stripe_session_id: "cs_1",
              amount_discounted_cents: 47520,
              created_at: "2026-07-20T00:00:00Z"
            }
          ]
        }
      ]);
      vi.mocked(listBusinesses).mockResolvedValue([{ id: BIZ_ID, name: "Acme" }] as never);

      const json = (await (await GET()).json()) as {
        data: { promotions: Array<{ redemptions: Array<{ business_name: string | null }> }> };
      };
      expect(json.data.promotions[0].redemptions[0].business_name).toBe("Acme");
    });

    it("leaves the business name null when the tenant is gone", async () => {
      vi.mocked(listPromotionsWithStats).mockResolvedValue([
        {
          ...PROMO,
          lifecycle: "active",
          stats: { redemptionCount: 1, totalDiscountedCents: 0, lastRedeemedAt: "x" },
          redemptions: [
            {
              id: "r1",
              promotion_id: PROMO_ID,
              business_id: BIZ_ID,
              tier: "starter",
              billing_period: "monthly",
              stripe_session_id: "cs_1",
              amount_discounted_cents: 0,
              created_at: "2026-07-20T00:00:00Z"
            }
          ]
        }
      ]);
      vi.mocked(listBusinesses).mockResolvedValue([]);
      const json = (await (await GET()).json()) as {
        data: { promotions: Array<{ redemptions: Array<{ business_name: string | null }> }> };
      };
      expect(json.data.promotions[0].redemptions[0].business_name).toBeNull();
    });
  });

  describe("PATCH", () => {
    it("writes the row without touching Stripe when only the window changes", async () => {
      const res = await PATCH(
        patch({ promotionId: PROMO_ID, endsAt: "2026-09-01T00:00:00.000Z" })
      );
      expect(res.status).toBe(200);
      expect(replacePromotionCoupon).not.toHaveBeenCalled();
      expect(setPromotionCodeActive).not.toHaveBeenCalled();
      expect(updatePromotion).toHaveBeenCalledWith(
        PROMO_ID,
        expect.objectContaining({ endsAt: "2026-09-01T00:00:00.000Z" })
      );
    });

    it("syncs the Stripe code when the toggle flips", async () => {
      await PATCH(patch({ promotionId: PROMO_ID, active: false }));
      expect(setPromotionCodeActive).toHaveBeenCalledWith("promo_1", false);
      expect(replacePromotionCoupon).not.toHaveBeenCalled();
    });

    it("does not re-send a toggle that matches the current state", async () => {
      await PATCH(patch({ promotionId: PROMO_ID, active: true }));
      expect(setPromotionCodeActive).not.toHaveBeenCalled();
    });

    it("mints a replacement coupon when the discount value changes", async () => {
      vi.mocked(replacePromotionCoupon).mockResolvedValue({
        couponId: "coupon_2",
        promotionCodeId: "promo_2"
      });
      await PATCH(patch({ promotionId: PROMO_ID, percentOff: 30 }));
      expect(replacePromotionCoupon).toHaveBeenCalledWith(
        expect.objectContaining({
          previous: { couponId: "coupon_1", promotionCodeId: "promo_1" },
          code: "SUMMER20"
        })
      );
      expect(updatePromotion).toHaveBeenCalledWith(
        PROMO_ID,
        expect.objectContaining({
          stripeCouponId: "coupon_2",
          stripePromotionCodeId: "promo_2"
        })
      );
    });

    it("mints a replacement carrying the REMAINING balance when the cap changes", async () => {
      // A promotion code's max_redemptions is fixed at creation, and the
      // replacement counts from zero, so Stripe gets 100 - 40 rather than 100.
      vi.mocked(getPromotion).mockResolvedValue({ ...PROMO, max_redemptions: 100 });
      vi.mocked(countPromotionRedemptions).mockResolvedValue(40);
      vi.mocked(replacePromotionCoupon).mockResolvedValue({
        couponId: "coupon_2",
        promotionCodeId: "promo_2"
      });

      await PATCH(patch({ promotionId: PROMO_ID, maxRedemptions: 120 }));
      expect(replacePromotionCoupon).toHaveBeenCalledWith(
        expect.objectContaining({ remainingRedemptions: 80 })
      );
    });

    it("does not mint a replacement when the cap is re-submitted unchanged", async () => {
      vi.mocked(getPromotion).mockResolvedValue({ ...PROMO, max_redemptions: 100 });
      await PATCH(patch({ promotionId: PROMO_ID, maxRedemptions: 100 }));
      expect(replacePromotionCoupon).not.toHaveBeenCalled();
    });

    it("leaves an already-spent cap uncapped at Stripe, where our exhausted check is the gate", async () => {
      vi.mocked(getPromotion).mockResolvedValue({ ...PROMO, max_redemptions: 100 });
      vi.mocked(countPromotionRedemptions).mockResolvedValue(60);
      vi.mocked(replacePromotionCoupon).mockResolvedValue({
        couponId: "coupon_2",
        promotionCodeId: "promo_2"
      });

      // Stripe rejects max_redemptions below 1, and the local cap check
      // already refuses the code at 60 of 50.
      await PATCH(patch({ promotionId: PROMO_ID, maxRedemptions: 50 }));
      expect(replacePromotionCoupon).toHaveBeenCalledWith(
        expect.objectContaining({ remainingRedemptions: null })
      );
    });

    it("mints a replacement coupon when the tier scope changes", async () => {
      vi.mocked(replacePromotionCoupon).mockResolvedValue({
        couponId: "coupon_2",
        promotionCodeId: "promo_2"
      });
      await PATCH(patch({ promotionId: PROMO_ID, allowedTiers: ["starter"] }));
      expect(replacePromotionCoupon).toHaveBeenCalled();
    });

    it("leaves the replacement switched off for a promotion that is off", async () => {
      vi.mocked(getPromotion).mockResolvedValue({ ...PROMO, active: false });
      vi.mocked(replacePromotionCoupon).mockResolvedValue({
        couponId: "coupon_2",
        promotionCodeId: "promo_2"
      });
      await PATCH(patch({ promotionId: PROMO_ID, percentOff: 30 }));
      expect(setPromotionCodeActive).toHaveBeenCalledWith("promo_2", false);
    });

    it("does not treat a reordered tier list as a discount change", async () => {
      await PATCH(patch({ promotionId: PROMO_ID, allowedTiers: ["standard", "starter"] }));
      expect(replacePromotionCoupon).not.toHaveBeenCalled();
    });

    it("404s an unknown promotion", async () => {
      vi.mocked(getPromotion).mockResolvedValue(null);
      const res = await PATCH(patch({ promotionId: PROMO_ID, name: "New name" }));
      expect(res.status).toBe(404);
    });

    it("404s when the row vanishes between the read and the write", async () => {
      vi.mocked(updatePromotion).mockResolvedValue(null);
      const res = await PATCH(patch({ promotionId: PROMO_ID, name: "New name" }));
      expect(res.status).toBe(404);
      // Nothing was replaced, so there is nothing to undo.
      expect(setPromotionCodeActive).not.toHaveBeenCalled();
    });

    it("rolls the replacement back when the row write throws, so Stripe cannot lead the row", async () => {
      vi.mocked(replacePromotionCoupon).mockResolvedValue({
        couponId: "coupon_2",
        promotionCodeId: "promo_2"
      });
      vi.mocked(updatePromotion).mockRejectedValue(new Error("row locked"));

      const res = await PATCH(patch({ promotionId: PROMO_ID, percentOff: 30 }));

      expect(res.status).toBe(500);
      // The abandoned code goes off and the one the row still names comes
      // back on, or validation would accept a promo Stripe then refuses.
      expect(setPromotionCodeActive).toHaveBeenNthCalledWith(1, "promo_2", false);
      expect(setPromotionCodeActive).toHaveBeenNthCalledWith(2, "promo_1", true);
    });

    it("rolls the replacement back when the row disappeared mid-edit", async () => {
      vi.mocked(replacePromotionCoupon).mockResolvedValue({
        couponId: "coupon_2",
        promotionCodeId: "promo_2"
      });
      vi.mocked(updatePromotion).mockResolvedValue(null);

      const res = await PATCH(patch({ promotionId: PROMO_ID, percentOff: 30 }));

      expect(res.status).toBe(404);
      expect(setPromotionCodeActive).toHaveBeenNthCalledWith(1, "promo_2", false);
      expect(setPromotionCodeActive).toHaveBeenNthCalledWith(2, "promo_1", true);
    });

    it("restores a switched-off promotion to switched off, not on", async () => {
      vi.mocked(getPromotion).mockResolvedValue({ ...PROMO, active: false });
      vi.mocked(replacePromotionCoupon).mockResolvedValue({
        couponId: "coupon_2",
        promotionCodeId: "promo_2"
      });
      vi.mocked(updatePromotion).mockResolvedValue(null);

      await PATCH(patch({ promotionId: PROMO_ID, percentOff: 30 }));

      expect(setPromotionCodeActive).toHaveBeenLastCalledWith("promo_1", false);
    });

    it("still reports the original failure when the rollback itself fails", async () => {
      vi.mocked(replacePromotionCoupon).mockResolvedValue({
        couponId: "coupon_2",
        promotionCodeId: "promo_2"
      });
      vi.mocked(updatePromotion).mockRejectedValue(new Error("row locked"));
      vi.mocked(setPromotionCodeActive).mockRejectedValue(new Error("stripe down"));

      const res = await PATCH(patch({ promotionId: PROMO_ID, percentOff: 30 }));
      expect(res.status).toBe(500);
    });

    it("refuses an end date that is not after the (unchanged) start date", async () => {
      const res = await PATCH(patch({ promotionId: PROMO_ID, endsAt: "2026-06-01T00:00:00.000Z" }));
      expect(res.status).toBe(400);
    });

    it("rejects a malformed body", async () => {
      const res = await PATCH(patch({ promotionId: "not-a-uuid" }));
      expect(res.status).toBe(400);
    });
  });

  describe("DELETE", () => {
    it("deletes the row and the Stripe objects when nobody has redeemed it", async () => {
      const res = await DELETE(del({ promotionId: PROMO_ID }));
      expect(res.status).toBe(200);
      expect(deletePromotion).toHaveBeenCalledWith(PROMO_ID);
      expect(deletePromotionCoupon).toHaveBeenCalledWith({
        couponId: "coupon_1",
        promotionCodeId: "promo_1"
      });
    });

    it("still succeeds when the Stripe teardown fails, since the row is the authority", async () => {
      vi.mocked(deletePromotionCoupon).mockRejectedValue(new Error("stripe down"));
      const res = await DELETE(del({ promotionId: PROMO_ID }));
      expect(res.status).toBe(200);
      expect(deletePromotion).toHaveBeenCalledWith(PROMO_ID);
    });

    it("refuses to delete a redeemed promotion so the attribution survives", async () => {
      vi.mocked(countPromotionRedemptions).mockResolvedValue(2);
      const res = await DELETE(del({ promotionId: PROMO_ID }));
      expect(res.status).toBe(409);
      expect(deletePromotion).not.toHaveBeenCalled();
      expect(deletePromotionCoupon).not.toHaveBeenCalled();
    });

    it("404s an unknown promotion", async () => {
      vi.mocked(getPromotion).mockResolvedValue(null);
      const res = await DELETE(del({ promotionId: PROMO_ID }));
      expect(res.status).toBe(404);
    });

    it("rejects a malformed body", async () => {
      const res = await DELETE(del({}));
      expect(res.status).toBe(400);
    });
  });

  it("propagates the admin gate", async () => {
    vi.mocked(requireAdmin).mockRejectedValue(
      Object.assign(new Error("Admin access required"), { status: 403 })
    );
    expect((await POST(post(VALID_CREATE))).status).toBe(403);
    expect((await GET()).status).toBe(403);
    expect((await PATCH(patch({ promotionId: PROMO_ID }))).status).toBe(403);
    expect((await DELETE(del({ promotionId: PROMO_ID }))).status).toBe(403);
  });
});


describe("multi-cycle coupons cannot allow term plans (audit 983-F1)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireAdmin).mockResolvedValue({
      userId: "admin-1",
      email: "admin@example.com",
      isAdmin: true
    } as never);
    vi.mocked(getPromotionByCode).mockResolvedValue(null);
    vi.mocked(getPromotion).mockResolvedValue(PROMO);
    vi.mocked(countPromotionRedemptions).mockResolvedValue(0);
  });

  it("refuses to mint a forever code that allows biennial", async () => {
    // A term plan is one prepaid invoice; whether Stripe's schedule phase
    // rewrite drops a redeemed coupon is pinned nowhere, and schedule setup
    // failure is non-fatal at checkout, so a multi-cycle coupon could
    // silently discount every full-term renewal.
    const res = await POST(
      post({
        ...VALID_CREATE,
        duration: "forever",
        allowedPeriods: ["monthly", "biennial"]
      })
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.message).toContain("one prepaid");
    expect(createPromotionCoupon).not.toHaveBeenCalled();
  });

  it("still mints a repeating code restricted to monthly", async () => {
    vi.mocked(createPromotionCoupon).mockResolvedValue({
      couponId: "coupon_1",
      promotionCodeId: "promo_1"
    });
    vi.mocked(createPromotion).mockResolvedValue(PROMO);
    const res = await POST(
      post({
        ...VALID_CREATE,
        duration: "repeating",
        durationInMonths: 3,
        allowedPeriods: ["monthly"]
      })
    );
    expect(res.status).toBe(200);
  });

  it("refuses a PATCH that makes an existing term-allowed code repeating", async () => {
    vi.mocked(getPromotion).mockResolvedValue({
      ...PROMO,
      allowed_periods: ["annual"]
    } as never);
    const res = await PATCH(
      patch({ promotionId: PROMO.id, duration: "repeating", durationInMonths: 6 })
    );
    expect(res.status).toBe(400);
  });
});
