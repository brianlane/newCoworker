import { describe, expect, it } from "vitest";
import {
  businessIdForHostingerBillingSub,
  isLiveRowMissingHostingerBillingId,
  liveSubscriptionForBusiness,
  planSubscriptionHostingerReconcile,
  type HostingerLinkInventory,
  type HostingerLinkSubscription
} from "@/lib/vps/hostinger-tenant-link";

const HQ = "8f3a5c21-7e94-4b6a-9d02-c4e8b1f6a37d";
const KIN = "a912aff5-dd87-49fb-ad6a-477acefb66c0";

function sub(
  overrides: Partial<HostingerLinkSubscription> & Pick<HostingerLinkSubscription, "id" | "business_id">
): HostingerLinkSubscription {
  return {
    status: "active",
    stripe_subscription_id: "sub_x",
    hostinger_billing_subscription_id: null,
    ...overrides
  };
}

function inv(
  overrides: Partial<HostingerLinkInventory> & Pick<HostingerLinkInventory, "vm_id">
): HostingerLinkInventory {
  return {
    state: "assigned",
    assigned_business_id: HQ,
    hostinger_billing_subscription_id: "16BcBrVOTACBI8WdU",
    ...overrides
  };
}

describe("isLiveRowMissingHostingerBillingId", () => {
  it("is true only for live rows with a null Hostinger id", () => {
    expect(
      isLiveRowMissingHostingerBillingId({ status: "active", hostinger_billing_subscription_id: null })
    ).toBe(true);
    expect(
      isLiveRowMissingHostingerBillingId({ status: "past_due", hostinger_billing_subscription_id: null })
    ).toBe(true);
    expect(
      isLiveRowMissingHostingerBillingId({
        status: "active",
        hostinger_billing_subscription_id: "Azyp34VTaWZDIBG8"
      })
    ).toBe(false);
    expect(
      isLiveRowMissingHostingerBillingId({ status: "pending", hostinger_billing_subscription_id: null })
    ).toBe(false);
    expect(
      isLiveRowMissingHostingerBillingId({ status: "canceled", hostinger_billing_subscription_id: null })
    ).toBe(false);
  });
});

describe("businessIdForHostingerBillingSub", () => {
  it("prefers the subscription row over inventory", () => {
    expect(
      businessIdForHostingerBillingSub("Azyp34VTaWZDIBG8", {
        subscriptions: [{ business_id: KIN, hostinger_billing_subscription_id: "Azyp34VTaWZDIBG8" }],
        inventory: [inv({ vm_id: 1, assigned_business_id: HQ, hostinger_billing_subscription_id: "Azyp34VTaWZDIBG8" })]
      })
    ).toBe(KIN);
  });

  it("falls back to an assigned inventory row (the HQ 2027 prepaid shape)", () => {
    expect(
      businessIdForHostingerBillingSub("16BcBrVOTACBI8WdU", {
        subscriptions: [{ business_id: HQ, hostinger_billing_subscription_id: null }],
        inventory: [inv({ vm_id: 1806097 })]
      })
    ).toBe(HQ);
  });

  it("ignores pooled inventory and unknown ids", () => {
    expect(
      businessIdForHostingerBillingSub("16BcBrVOTACBI8WdU", {
        subscriptions: [],
        inventory: [
          inv({
            vm_id: 1806097,
            state: "available",
            assigned_business_id: null
          })
        ]
      })
    ).toBeNull();
    expect(
      businessIdForHostingerBillingSub("nope", { subscriptions: [], inventory: [inv({ vm_id: 1 })] })
    ).toBeNull();
  });
});

describe("liveSubscriptionForBusiness", () => {
  it("returns the last live row and ignores pending", () => {
    const pending = sub({
      id: "old-pending",
      business_id: KIN,
      status: "pending",
      stripe_subscription_id: null
    });
    const live = sub({
      id: "paid",
      business_id: KIN,
      hostinger_billing_subscription_id: "Azyp34VTaWZDIBG8"
    });
    expect(liveSubscriptionForBusiness(KIN, [pending, live])).toEqual(live);
    expect(liveSubscriptionForBusiness(HQ, [pending, live])).toBeNull();
  });

  it("last live row wins when created_at is missing", () => {
    const a = sub({ id: "a", business_id: KIN });
    const b = sub({ id: "b", business_id: KIN });
    expect(liveSubscriptionForBusiness(KIN, [a, b])?.id).toBe("b");
  });

  it("picks the newest created_at when two live rows exist", () => {
    const older = sub({
      id: "older",
      business_id: KIN,
      created_at: "2026-08-21T00:00:00Z"
    });
    const newer = sub({
      id: "newer",
      business_id: KIN,
      created_at: "2026-08-24T00:00:00Z"
    });
    expect(liveSubscriptionForBusiness(KIN, [newer, older])?.id).toBe("newer");
    expect(liveSubscriptionForBusiness(KIN, [older, newer])?.id).toBe("newer");
  });
});

describe("planSubscriptionHostingerReconcile", () => {
  it("stamps HQ when inventory has the id and the live row does not", () => {
    const { plans, skips } = planSubscriptionHostingerReconcile({
      subscriptions: [sub({ id: "hq-sub", business_id: HQ, stripe_subscription_id: null })],
      inventory: [inv({ vm_id: 1806097 })]
    });
    expect(skips).toEqual([]);
    expect(plans).toEqual([
      {
        kind: "stamp",
        businessId: HQ,
        subscriptionId: "hq-sub",
        hostingerBillingSubscriptionId: "16BcBrVOTACBI8WdU",
        vmId: 1806097
      }
    ]);
  });

  it("cancels KIN's unpaid pending sibling next to the live paid row", () => {
    const { plans } = planSubscriptionHostingerReconcile({
      subscriptions: [
        sub({
          id: "kin-pending",
          business_id: KIN,
          status: "pending",
          stripe_subscription_id: null
        }),
        sub({
          id: "kin-live",
          business_id: KIN,
          hostinger_billing_subscription_id: "Azyp34VTaWZDIBG8"
        })
      ],
      inventory: [
        inv({
          vm_id: 1936826,
          assigned_business_id: KIN,
          hostinger_billing_subscription_id: "Azyp34VTaWZDIBG8"
        })
      ]
    });
    expect(plans).toEqual([
      {
        kind: "cancel_pending",
        businessId: KIN,
        subscriptionId: "kin-pending"
      }
    ]);
  });

  it("skips unassigned inventory, non-pending siblings, and duplicate pending ids", () => {
    const { plans, skips } = planSubscriptionHostingerReconcile({
      subscriptions: [
        sub({
          id: "kin-pending",
          business_id: KIN,
          status: "pending",
          stripe_subscription_id: null
        }),
        sub({
          id: "kin-pending",
          business_id: KIN,
          status: "pending",
          stripe_subscription_id: null
        }),
        sub({
          id: "kin-canceled",
          business_id: KIN,
          status: "canceled",
          stripe_subscription_id: null
        }),
        sub({
          id: "kin-live",
          business_id: KIN,
          hostinger_billing_subscription_id: "Azyp34VTaWZDIBG8"
        })
      ],
      inventory: [
        inv({
          vm_id: 1,
          state: "retired",
          assigned_business_id: KIN,
          hostinger_billing_subscription_id: "Azyp34VTaWZDIBG8"
        }),
        inv({
          vm_id: 2,
          state: "available",
          assigned_business_id: null,
          hostinger_billing_subscription_id: "x"
        }),
        inv({
          vm_id: 1936826,
          assigned_business_id: KIN,
          hostinger_billing_subscription_id: "Azyp34VTaWZDIBG8"
        })
      ]
    });
    expect(skips).toEqual([]);
    expect(plans).toEqual([
      {
        kind: "cancel_pending",
        businessId: KIN,
        subscriptionId: "kin-pending"
      }
    ]);
  });

  it("does not cancel a pending row that already has a Stripe id, or the live row", () => {
    const { plans } = planSubscriptionHostingerReconcile({
      subscriptions: [
        sub({
          id: "mid-flight",
          business_id: KIN,
          status: "pending",
          stripe_subscription_id: "sub_in_flight"
        }),
        sub({ id: "kin-live", business_id: KIN, hostinger_billing_subscription_id: "h" })
      ],
      inventory: [
        inv({ vm_id: 1, assigned_business_id: KIN, hostinger_billing_subscription_id: "h" })
      ]
    });
    expect(plans).toEqual([]);
  });

  it("skips a stamp when the live row already disagrees (partial cutover)", () => {
    const { plans, skips } = planSubscriptionHostingerReconcile({
      subscriptions: [
        sub({
          id: "hq-sub",
          business_id: HQ,
          hostinger_billing_subscription_id: "other-id"
        })
      ],
      inventory: [inv({ vm_id: 1806097 })]
    });
    expect(plans).toEqual([]);
    expect(skips[0]?.reason).toContain("partial cutover");
  });

  it("skips assigned inventory with no Hostinger id, and assigned boxes with no live sub", () => {
    const { skips } = planSubscriptionHostingerReconcile({
      subscriptions: [],
      inventory: [
        inv({ vm_id: 1, hostinger_billing_subscription_id: null }),
        inv({ vm_id: 2, assigned_business_id: KIN })
      ]
    });
    expect(skips.map((s) => s.reason)).toEqual([
      "vm 1 is assigned but inventory has no Hostinger billing id",
      "vm 2 is assigned but this business has no live subscription row"
    ]);
  });

  it("honours an optional business-id filter", () => {
    const { plans } = planSubscriptionHostingerReconcile({
      subscriptions: [
        sub({ id: "hq-sub", business_id: HQ, stripe_subscription_id: null }),
        sub({
          id: "kin-pending",
          business_id: KIN,
          status: "pending",
          stripe_subscription_id: null
        }),
        sub({
          id: "kin-live",
          business_id: KIN,
          hostinger_billing_subscription_id: "Azyp34VTaWZDIBG8"
        })
      ],
      inventory: [
        inv({ vm_id: 1806097 }),
        inv({
          vm_id: 1936826,
          assigned_business_id: KIN,
          hostinger_billing_subscription_id: "Azyp34VTaWZDIBG8"
        })
      ],
      businessIds: new Set([HQ])
    });
    expect(plans).toEqual([
      {
        kind: "stamp",
        businessId: HQ,
        subscriptionId: "hq-sub",
        hostingerBillingSubscriptionId: "16BcBrVOTACBI8WdU",
        vmId: 1806097
      }
    ]);
  });
});
