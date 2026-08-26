import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ requireAdmin: vi.fn() }));
vi.mock("@/lib/db/businesses", () => ({ getBusiness: vi.fn() }));
vi.mock("@/lib/db/subscriptions", () => ({
  getSubscription: vi.fn(),
  updateSubscription: vi.fn()
}));
vi.mock("@/lib/stripe/subscription-discount", () => ({
  applyMembershipDiscount: vi.fn(),
  removeMembershipDiscount: vi.fn()
}));
vi.mock("@/lib/admin/audit", () => ({ logAdminAction: vi.fn() }));
vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() }
}));

import { DELETE, POST } from "@/app/api/admin/membership-discount/route";
import { requireAdmin } from "@/lib/auth";
import { getBusiness } from "@/lib/db/businesses";
import { getSubscription, updateSubscription } from "@/lib/db/subscriptions";
import {
  applyMembershipDiscount,
  removeMembershipDiscount
} from "@/lib/stripe/subscription-discount";
import { logAdminAction } from "@/lib/admin/audit";
import { NO_MEMBERSHIP_DISCOUNT } from "@/lib/billing/membership-discount";

const BIZ_ID = "11111111-1111-4111-8111-111111111111";

function request(body: Record<string, unknown>, method: "POST" | "DELETE" = "POST"): Request {
  return new Request("http://localhost/api/admin/membership-discount", {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ businessId: BIZ_ID, ...body })
  });
}

const VALID_APPLY = {
  label: "Retention: August outage credit",
  percentOff: 30,
  duration: "forever" as const
};

/** A Stripe subscription with the discount expanded, as the route requests. */
function discountedSubscription() {
  return {
    id: "sub_stripe_1",
    discounts: [
      {
        id: "di_1",
        start: 1_787_616_000,
        end: null,
        source: {
          type: "coupon",
          coupon: {
            id: "co_new",
            name: "Retention: August outage credit",
            percent_off: 30,
            amount_off: null,
            duration: "forever",
            duration_in_months: null
          }
        }
      }
    ]
  };
}

describe("api/admin/membership-discount route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireAdmin).mockResolvedValue({
      userId: "admin-1",
      email: "admin@example.com",
      isAdmin: true
    } as never);
    vi.mocked(getBusiness).mockResolvedValue({ id: BIZ_ID, name: "Corp" } as never);
    vi.mocked(getSubscription).mockResolvedValue({
      id: "sub-row-1",
      status: "active",
      stripe_subscription_id: "sub_stripe_1",
      discount_coupon_id: null
    } as never);
    vi.mocked(applyMembershipDiscount).mockResolvedValue({
      couponId: "co_new",
      subscription: discountedSubscription()
    } as never);
    vi.mocked(removeMembershipDiscount).mockResolvedValue({
      id: "sub_stripe_1",
      discounts: []
    } as never);
  });

  describe("POST (apply)", () => {
    it("applies the discount and mirrors what Stripe returned", async () => {
      const res = await POST(request(VALID_APPLY));
      expect(res.status).toBe(200);

      expect(applyMembershipDiscount).toHaveBeenCalledWith(
        expect.objectContaining({
          subscriptionId: "sub_stripe_1",
          label: "Retention: August outage credit",
          discount: expect.objectContaining({ percentOff: 30, duration: "forever" }),
          metadata: expect.objectContaining({
            businessId: BIZ_ID,
            appliedBy: "admin@example.com",
            source: "admin_membership_discount"
          })
        })
      );
      expect(updateSubscription).toHaveBeenCalledWith("sub-row-1", {
        discount_coupon_id: "co_new",
        discount_name: "Retention: August outage credit",
        discount_percent_off: 30,
        discount_amount_off_cents: null,
        discount_duration: "forever",
        discount_duration_in_months: null,
        discount_started_at: "2026-08-25T00:00:00.000Z",
        discount_ends_at: null
      });

      const json = await res.json();
      expect(json.data.summary).toBe("30% off, every invoice");
      expect(logAdminAction).toHaveBeenCalledWith(
        expect.objectContaining({ action: "membership_discount_apply", businessId: BIZ_ID })
      );
    });

    it("converts a dollar amount and repeating months on the way to Stripe", async () => {
      await POST(
        request({
          label: "Outage credit",
          amountOffUsd: 40,
          duration: "repeating",
          durationInMonths: 3
        })
      );
      expect(applyMembershipDiscount).toHaveBeenCalledWith(
        expect.objectContaining({
          discount: {
            percentOff: null,
            amountOffCents: 4000,
            duration: "repeating",
            durationInMonths: 3
          }
        })
      );
    });

    it("leaves the mirror alone when Stripe's answer cannot be read", async () => {
      // Unexpanded discounts: writing a half-known mirror would be worse than
      // not claiming one, and the coupon id still reaches the audit line.
      vi.mocked(applyMembershipDiscount).mockResolvedValue({
        couponId: "co_new",
        subscription: { id: "sub_stripe_1", discounts: ["di_1"] }
      } as never);

      const res = await POST(request(VALID_APPLY));
      expect(res.status).toBe(200);
      expect(updateSubscription).not.toHaveBeenCalled();
      expect(logAdminAction).toHaveBeenCalledWith(
        expect.objectContaining({ detail: expect.objectContaining({ mirrored: false }) })
      );
    });

    it("falls back to the admin user id when the email is unresolvable", async () => {
      vi.mocked(requireAdmin).mockResolvedValue({
        userId: "admin-1",
        email: null,
        isAdmin: true
      } as never);
      await POST(request(VALID_APPLY));
      expect(applyMembershipDiscount).toHaveBeenCalledWith(
        expect.objectContaining({ metadata: expect.objectContaining({ appliedBy: "admin-1" }) })
      );
    });

    it("refuses an unknown business", async () => {
      vi.mocked(getBusiness).mockResolvedValue(null as never);
      expect((await POST(request(VALID_APPLY))).status).toBe(404);
    });

    it("refuses a business with no subscription row", async () => {
      vi.mocked(getSubscription).mockResolvedValue(null as never);
      expect((await POST(request(VALID_APPLY))).status).toBe(404);
    });

    it("refuses a subscription that is not active", async () => {
      vi.mocked(getSubscription).mockResolvedValue({
        id: "sub-row-1",
        status: "canceled",
        stripe_subscription_id: "sub_stripe_1"
      } as never);
      expect((await POST(request(VALID_APPLY))).status).toBe(409);
    });

    it("refuses a Stripe-less row, which has no invoice to discount", async () => {
      vi.mocked(getSubscription).mockResolvedValue({
        id: "sub-row-1",
        status: "active",
        stripe_subscription_id: null
      } as never);
      const res = await POST(request(VALID_APPLY));
      expect(res.status).toBe(409);
      expect((await res.json()).error.message).toContain("not billed through Stripe");
      expect(applyMembershipDiscount).not.toHaveBeenCalled();
    });

    it("refuses a label that is too short", async () => {
      const res = await POST(request({ ...VALID_APPLY, label: "x" }));
      expect(res.status).toBe(400);
      expect(applyMembershipDiscount).not.toHaveBeenCalled();
    });

    it("refuses a discount with both a percentage and an amount", async () => {
      const res = await POST(request({ ...VALID_APPLY, amountOffUsd: 40 }));
      expect(res.status).toBe(400);
      expect((await res.json()).error.message).toContain("only one");
      expect(applyMembershipDiscount).not.toHaveBeenCalled();
    });

    it("rejects a malformed body before touching Stripe", async () => {
      const res = await POST(request({ label: "Retention", duration: "sometimes" }));
      expect(res.status).toBe(400);
      expect(applyMembershipDiscount).not.toHaveBeenCalled();
    });

    it("translates a Stripe commitment-schedule rejection into plain language", async () => {
      vi.mocked(applyMembershipDiscount).mockRejectedValue(
        new Error("Cannot update discounts on a subscription with a schedule")
      );
      const res = await POST(request(VALID_APPLY));
      expect(res.status).toBe(500);
      expect((await res.json()).error.message).toContain("commitment schedule");
      expect(updateSubscription).not.toHaveBeenCalled();
    });

    it("surfaces a non-Error Stripe rejection rather than swallowing it", async () => {
      vi.mocked(applyMembershipDiscount).mockRejectedValue("stripe blew up");
      const res = await POST(request(VALID_APPLY));
      expect(res.status).toBe(500);
      expect((await res.json()).error.message).toBe("stripe blew up");
    });
  });

  describe("DELETE (remove)", () => {
    it("removes the discount and clears the mirror", async () => {
      vi.mocked(getSubscription).mockResolvedValue({
        id: "sub-row-1",
        status: "active",
        stripe_subscription_id: "sub_stripe_1",
        discount_coupon_id: "co_old"
      } as never);

      const res = await DELETE(request({}, "DELETE"));
      expect(res.status).toBe(200);
      expect(removeMembershipDiscount).toHaveBeenCalledWith({
        subscriptionId: "sub_stripe_1",
        couponId: "co_old"
      });
      expect(updateSubscription).toHaveBeenCalledWith("sub-row-1", NO_MEMBERSHIP_DISCOUNT);
      expect(logAdminAction).toHaveBeenCalledWith(
        expect.objectContaining({ action: "membership_discount_remove" })
      );
    });

    it("clears the mirror even when the confirmed removal came back unreadable", async () => {
      vi.mocked(removeMembershipDiscount).mockResolvedValue({
        id: "sub_stripe_1",
        discounts: ["di_1"]
      } as never);
      await DELETE(request({}, "DELETE"));
      expect(updateSubscription).toHaveBeenCalledWith("sub-row-1", NO_MEMBERSHIP_DISCOUNT);
    });

    it("applies the same guards as apply", async () => {
      vi.mocked(getSubscription).mockResolvedValue(null as never);
      expect((await DELETE(request({}, "DELETE"))).status).toBe(404);
      expect(removeMembershipDiscount).not.toHaveBeenCalled();
    });

    it("rejects a malformed body", async () => {
      const res = await DELETE(
        new Request("http://localhost/api/admin/membership-discount", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ businessId: "not-a-uuid" })
        })
      );
      expect(res.status).toBe(400);
    });

    it("leaves the mirror alone when Stripe refuses the removal", async () => {
      vi.mocked(removeMembershipDiscount).mockRejectedValue(new Error("Stripe down"));
      const res = await DELETE(request({}, "DELETE"));
      expect(res.status).toBe(500);
      // The discount is still live at Stripe, so the row must keep saying so.
      expect(updateSubscription).not.toHaveBeenCalled();
    });

    it("surfaces a non-Error rejection from the removal path", async () => {
      vi.mocked(removeMembershipDiscount).mockRejectedValue("nope");
      const res = await DELETE(request({}, "DELETE"));
      expect((await res.json()).error.message).toBe("nope");
    });
  });
});
