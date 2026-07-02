import { beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";

const { backupBusinessDataMock, restoreBusinessDataMock } = vi.hoisted(() => ({
  backupBusinessDataMock: vi.fn(),
  restoreBusinessDataMock: vi.fn()
}));

const { orchestrateProvisioningMock } = vi.hoisted(() => ({
  orchestrateProvisioningMock: vi.fn()
}));

const {
  getBusinessMock,
  setBusinessCustomerProfileMock
} = vi.hoisted(() => ({
  getBusinessMock: vi.fn(),
  setBusinessCustomerProfileMock: vi.fn()
}));

const {
  getSubscriptionMock,
  getSubscriptionByStripeSubscriptionIdMock,
  createSubscriptionMock,
  updateSubscriptionMock,
  updateSubscriptionIfNotWipedMock
} = vi.hoisted(() => ({
  getSubscriptionMock: vi.fn(),
  getSubscriptionByStripeSubscriptionIdMock: vi.fn(),
  createSubscriptionMock: vi.fn(),
  updateSubscriptionMock: vi.fn(),
  updateSubscriptionIfNotWipedMock: vi.fn()
}));

const {
  upsertCustomerProfileMock,
  incrementLifetimeSubscriptionCountMock,
  decrementLifetimeSubscriptionCountMock
} = vi.hoisted(() => ({
  upsertCustomerProfileMock: vi.fn(),
  incrementLifetimeSubscriptionCountMock: vi.fn(),
  decrementLifetimeSubscriptionCountMock: vi.fn()
}));

const {
  stripeRetrieveMock,
  stripeCancelMock,
  stripeScheduleReleaseMock,
  ensureCommitmentScheduleMock
} = vi.hoisted(() => ({
  stripeRetrieveMock: vi.fn(),
  stripeCancelMock: vi.fn(),
  stripeScheduleReleaseMock: vi.fn(),
  ensureCommitmentScheduleMock: vi.fn()
}));

const {
  hostingerGetVmMock,
  hostingerCreateSnapshotMock,
  hostingerStopVirtualMachineMock,
  hostingerCancelBillingSubscriptionMock
} = vi.hoisted(() => ({
  hostingerGetVmMock: vi.fn(),
  hostingerCreateSnapshotMock: vi.fn(),
  hostingerStopVirtualMachineMock: vi.fn(),
  hostingerCancelBillingSubscriptionMock: vi.fn()
}));

vi.mock("@/lib/hostinger/client", () => {
  class HostingerClient {
    getVirtualMachine(id: number) {
      return hostingerGetVmMock(id);
    }
    createSnapshot(id: number) {
      return hostingerCreateSnapshotMock(id);
    }
    stopVirtualMachine(id: number) {
      return hostingerStopVirtualMachineMock(id);
    }
    cancelBillingSubscription(id: string, reason?: string) {
      return hostingerCancelBillingSubscriptionMock(id, reason);
    }
  }
  return {
    DEFAULT_HOSTINGER_BASE_URL: "https://developers.hostinger.com",
    HostingerClient
  };
});

vi.mock("@/lib/hostinger/data-migration", () => ({
  backupBusinessData: backupBusinessDataMock,
  restoreBusinessData: restoreBusinessDataMock
}));

vi.mock("@/lib/provisioning/orchestrate", () => ({
  orchestrateProvisioning: orchestrateProvisioningMock
}));

vi.mock("@/lib/db/businesses", () => ({
  getBusiness: getBusinessMock,
  setBusinessCustomerProfile: setBusinessCustomerProfileMock
}));

vi.mock("@/lib/db/subscriptions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db/subscriptions")>();
  return {
    ...actual,
    getSubscription: getSubscriptionMock,
    getSubscriptionByStripeSubscriptionId: getSubscriptionByStripeSubscriptionIdMock,
    createSubscription: createSubscriptionMock,
    updateSubscription: updateSubscriptionMock,
    updateSubscriptionIfNotWiped: updateSubscriptionIfNotWipedMock,
    stripeSubscriptionPeriodCache: vi.fn().mockReturnValue({})
  };
});

vi.mock("@/lib/db/customer-profiles", () => ({
  upsertCustomerProfile: upsertCustomerProfileMock,
  incrementLifetimeSubscriptionCount: incrementLifetimeSubscriptionCountMock,
  decrementLifetimeSubscriptionCount: decrementLifetimeSubscriptionCountMock
}));

vi.mock("@/lib/stripe/client", () => ({
  getStripe: vi.fn(() => ({
    subscriptions: {
      retrieve: stripeRetrieveMock,
      cancel: stripeCancelMock
    },
    subscriptionSchedules: {
      release: stripeScheduleReleaseMock
    }
  })),
  ensureCommitmentSchedule: ensureCommitmentScheduleMock
}));

vi.mock("@/lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  }
}));

import {
  runChangePlanFromCheckout,
  runResubscribeFromCheckout
} from "@/lib/billing/change-plan-orchestrator";

function makeSession(overrides: Partial<Stripe.Checkout.Session> = {}): Stripe.Checkout.Session {
  return {
    id: "cs_test_123",
    object: "checkout.session",
    customer: "cus_new",
    subscription: "sub_new",
    customer_email: null,
    customer_details: { email: "owner@example.com" } as NonNullable<Stripe.Checkout.Session["customer_details"]>,
    metadata: {
      businessId: "biz-1",
      previousSubscriptionId: "sub-row-old",
      tier: "standard",
      billingPeriod: "annual",
      lifecycleAction: "changePlan"
    },
    ...overrides
  } as Stripe.Checkout.Session;
}

beforeEach(() => {
  vi.clearAllMocks();

  getBusinessMock.mockResolvedValue({
    id: "biz-1",
    owner_email: "owner@example.com",
    hostinger_vps_id: "1001",
    customer_profile_id: "prof-1",
    status: "online"
  });
  getSubscriptionMock.mockResolvedValue({
    id: "sub-row-old",
    business_id: "biz-1",
    stripe_subscription_id: "sub_old",
    hostinger_billing_subscription_id: "billing_old",
    customer_profile_id: "prof-1",
    tier: "starter",
    billing_period: "monthly",
    status: "active",
    created_at: "2026-01-01T00:00:00.000Z",
    cancel_at_period_end: false
  });
  // Default: the orchestrator hasn't run for this Stripe subscription
  // id yet, so the idempotency guard is a no-op for the existing
  // suite. Tests covering re-delivery override this explicitly.
  getSubscriptionByStripeSubscriptionIdMock.mockResolvedValue(null);
  upsertCustomerProfileMock.mockResolvedValue("prof-1");
  createSubscriptionMock.mockResolvedValue({});
  updateSubscriptionMock.mockResolvedValue({});
  // Default: the conditional resurrect-write succeeds (i.e. no
  // grace-sweep wipe raced this orchestrator). Tests covering the
  // grace-sweep race override this with `null`.
  updateSubscriptionIfNotWipedMock.mockResolvedValue({ id: "sub-row-old" });
  incrementLifetimeSubscriptionCountMock.mockResolvedValue(undefined);
  decrementLifetimeSubscriptionCountMock.mockResolvedValue(2);
  setBusinessCustomerProfileMock.mockResolvedValue(undefined);
  ensureCommitmentScheduleMock.mockResolvedValue(null);

  hostingerGetVmMock.mockImplementation(async (id: number) => ({
    id,
    ipv4: [{ address: id === 1001 ? "10.0.0.1" : "10.0.0.2" }]
  }));
  hostingerCreateSnapshotMock.mockResolvedValue({ id: 1, state: "success" });
  hostingerStopVirtualMachineMock.mockResolvedValue({ id: 2, state: "success" });
  hostingerCancelBillingSubscriptionMock.mockResolvedValue({ ok: true });

  backupBusinessDataMock.mockResolvedValue({
    storageBucket: "business-backups",
    storagePath: "backups/biz-1/latest.tar.gz",
    sha256: "abc",
    sizeBytes: 1024
  });
  restoreBusinessDataMock.mockResolvedValue({
    storagePath: "backups/biz-1/latest.tar.gz",
    sha256: "abc",
    sizeBytes: 1024
  });

  orchestrateProvisioningMock.mockResolvedValue({
    vpsId: "2002",
    tunnelUrl: "https://biz-1.example.com",
    hostingerBillingSubscriptionId: "billing_new"
  });

  stripeRetrieveMock.mockImplementation(async (id: string) => ({
    id,
    status: id === "sub_old" ? "active" : "active",
    schedule: id === "sub_old" ? "sched_old" : null,
    items: { data: [{ current_period_start: 1700000000, current_period_end: 1702678400 }] }
  }));
  stripeCancelMock.mockResolvedValue({ id: "sub_old", status: "canceled" });
  stripeScheduleReleaseMock.mockResolvedValue({ id: "sched_old" });
});

describe("runChangePlanFromCheckout", () => {
  it("backs up old VPS, provisions new, restores data, and tears down old Stripe + Hostinger", async () => {
    await runChangePlanFromCheckout(makeSession(), "evt_1");

    expect(backupBusinessDataMock).toHaveBeenCalledWith(
      expect.objectContaining({ businessId: "biz-1", vpsHost: "10.0.0.1" })
    );

    expect(orchestrateProvisioningMock).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: "biz-1",
        tier: "standard",
        ownerEmail: "owner@example.com"
      })
    );

    expect(restoreBusinessDataMock).toHaveBeenCalledWith(
      expect.objectContaining({ businessId: "biz-1", vpsHost: "10.0.0.2" })
    );

    expect(createSubscriptionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        business_id: "biz-1",
        tier: "standard",
        billing_period: "annual",
        status: "active",
        stripe_subscription_id: "sub_new",
        hostinger_billing_subscription_id: "billing_new",
        customer_profile_id: "prof-1"
      })
    );

    expect(incrementLifetimeSubscriptionCountMock).toHaveBeenCalledWith("prof-1");
    expect(setBusinessCustomerProfileMock).toHaveBeenCalledWith("biz-1", "prof-1");

    expect(ensureCommitmentScheduleMock).toHaveBeenCalledWith(
      expect.objectContaining({ subscriptionId: "sub_new", tier: "standard", billingPeriod: "annual" })
    );

    // Old Stripe teardown (schedule release + cancel).
    expect(stripeScheduleReleaseMock).toHaveBeenCalledWith("sched_old");
    expect(stripeCancelMock).toHaveBeenCalledWith("sub_old", { prorate: false });

    expect(hostingerCreateSnapshotMock).toHaveBeenCalledWith(1001);
    expect(hostingerStopVirtualMachineMock).toHaveBeenCalledWith(1001);

    // Old Hostinger billing canceled.
    expect(hostingerCancelBillingSubscriptionMock).toHaveBeenCalledWith(
      "billing_old",
      expect.any(String)
    );

    // Old subscription row marked canceled with upgrade_switch reason.
    expect(updateSubscriptionMock).toHaveBeenCalledWith(
      "sub-row-old",
      expect.objectContaining({
        status: "canceled",
        cancel_reason: "upgrade_switch"
      })
    );
  });

  describe("re-contract lifetime-cap exemption", () => {
    function termOldSub(overrides: Record<string, unknown> = {}) {
      return {
        id: "sub-row-old",
        business_id: "biz-1",
        stripe_subscription_id: "sub_old",
        hostinger_billing_subscription_id: "billing_old",
        customer_profile_id: "prof-1",
        tier: "standard",
        billing_period: "biennial",
        status: "active",
        created_at: "2024-06-01T00:00:00.000Z",
        cancel_at_period_end: false,
        // Commitment ended yesterday → rollover phase (monthly Stripe period).
        renewal_at: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
        stripe_current_period_start: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
        stripe_current_period_end: new Date(Date.now() + 29 * 24 * 60 * 60 * 1000).toISOString(),
        ...overrides
      };
    }

    function recontractSession() {
      return makeSession({
        metadata: {
          businessId: "biz-1",
          previousSubscriptionId: "sub-row-old",
          tier: "standard",
          billingPeriod: "biennial",
          lifecycleAction: "changePlan",
          recontract: "1"
        }
      });
    }

    it("skips the lifetime increment for a verified re-contract", async () => {
      getSubscriptionMock.mockResolvedValue(termOldSub());
      await runChangePlanFromCheckout(recontractSession(), "evt_recontract");
      expect(incrementLifetimeSubscriptionCountMock).not.toHaveBeenCalled();
      // Same-tier re-contract takes the period-only fast path: no VPS
      // migration, just the Stripe swap + old-sub teardown.
      expect(orchestrateProvisioningMock).not.toHaveBeenCalled();
      expect(stripeCancelMock).toHaveBeenCalledWith("sub_old", { prorate: false });
      expect(createSubscriptionMock).toHaveBeenCalledWith(
        expect.objectContaining({ hostinger_billing_subscription_id: "billing_old" })
      );
    });

    it("still increments when the recontract flag fails re-verification (commitment not elapsed)", async () => {
      getSubscriptionMock.mockResolvedValue(
        termOldSub({ renewal_at: "2099-01-01T00:00:00.000Z" })
      );
      await runChangePlanFromCheckout(recontractSession(), "evt_recontract_bad");
      expect(incrementLifetimeSubscriptionCountMock).toHaveBeenCalledWith("prof-1");
    });

    it("still increments when the old sub has no Stripe subscription id", async () => {
      getSubscriptionMock.mockResolvedValue(
        termOldSub({ stripe_subscription_id: null, hostinger_billing_subscription_id: null })
      );
      await runChangePlanFromCheckout(recontractSession(), "evt_recontract_nostripe");
      expect(incrementLifetimeSubscriptionCountMock).toHaveBeenCalledWith("prof-1");
    });

    it("still increments when the old sub is inside a renewed full term (multi-month Stripe period)", async () => {
      getSubscriptionMock.mockResolvedValue(
        termOldSub({
          stripe_current_period_end: new Date(
            Date.now() + 729 * 24 * 60 * 60 * 1000
          ).toISOString()
        })
      );
      await runChangePlanFromCheckout(recontractSession(), "evt_recontract_renewed");
      expect(incrementLifetimeSubscriptionCountMock).toHaveBeenCalledWith("prof-1");
    });
  });

  describe("period-only fast path (same tier, different billing period)", () => {
    function periodOnlySession() {
      // Old sub fixture is starter/monthly — same tier, new period.
      return makeSession({
        metadata: {
          businessId: "biz-1",
          previousSubscriptionId: "sub-row-old",
          tier: "starter",
          billingPeriod: "annual",
          lifecycleAction: "changePlan"
        }
      });
    }

    it("swaps Stripe billing without touching the VPS", async () => {
      await runChangePlanFromCheckout(periodOnlySession(), "evt_period_only");

      // None of the migration machinery runs.
      expect(hostingerCreateSnapshotMock).not.toHaveBeenCalled();
      expect(backupBusinessDataMock).not.toHaveBeenCalled();
      expect(orchestrateProvisioningMock).not.toHaveBeenCalled();
      expect(restoreBusinessDataMock).not.toHaveBeenCalled();
      // CRITICAL: the old Hostinger billing sub is the LIVE box — it must
      // never be stopped or canceled on a period-only switch.
      expect(hostingerStopVirtualMachineMock).not.toHaveBeenCalled();
      expect(hostingerCancelBillingSubscriptionMock).not.toHaveBeenCalled();

      // The new sub row inherits the existing box's Hostinger billing id.
      expect(createSubscriptionMock).toHaveBeenCalledWith(
        expect.objectContaining({
          business_id: "biz-1",
          tier: "starter",
          billing_period: "annual",
          status: "active",
          stripe_subscription_id: "sub_new",
          hostinger_billing_subscription_id: "billing_old"
        })
      );

      // Stripe swap + old-row bookkeeping still run in full.
      expect(ensureCommitmentScheduleMock).toHaveBeenCalledWith(
        expect.objectContaining({ subscriptionId: "sub_new", tier: "starter", billingPeriod: "annual" })
      );
      expect(stripeCancelMock).toHaveBeenCalledWith("sub_old", { prorate: false });
      expect(updateSubscriptionMock).toHaveBeenCalledWith(
        "sub-row-old",
        expect.objectContaining({ status: "canceled", cancel_reason: "upgrade_switch" })
      );
    });

    it("still counts the lifetime slot on a non-recontract period switch", async () => {
      await runChangePlanFromCheckout(periodOnlySession(), "evt_period_only_lifetime");
      expect(incrementLifetimeSubscriptionCountMock).toHaveBeenCalledWith("prof-1");
    });

    it("leaves the new row's Hostinger billing id null when the old sub had none", async () => {
      getSubscriptionMock.mockResolvedValueOnce({
        id: "sub-row-old",
        business_id: "biz-1",
        stripe_subscription_id: "sub_old",
        hostinger_billing_subscription_id: null,
        customer_profile_id: "prof-1",
        tier: "starter",
        billing_period: "monthly",
        status: "active",
        created_at: "2026-01-01T00:00:00.000Z",
        cancel_at_period_end: false
      });

      await runChangePlanFromCheckout(periodOnlySession(), "evt_period_only_no_billing");

      expect(createSubscriptionMock).toHaveBeenCalledWith(
        expect.objectContaining({ hostinger_billing_subscription_id: null })
      );
      expect(hostingerCancelBillingSubscriptionMock).not.toHaveBeenCalled();
    });

    it("tier changes still take the full migration path", async () => {
      // Default fixture: old starter/monthly → session standard/annual.
      await runChangePlanFromCheckout(makeSession(), "evt_tier_change_full_path");
      expect(orchestrateProvisioningMock).toHaveBeenCalled();
      expect(hostingerCancelBillingSubscriptionMock).toHaveBeenCalledWith(
        "billing_old",
        expect.any(String)
      );
    });
  });

  it("aborts if the business is missing and cancels the fresh Stripe sub", async () => {
    getBusinessMock.mockResolvedValueOnce(null);
    await runChangePlanFromCheckout(makeSession(), "evt_2");
    expect(orchestrateProvisioningMock).not.toHaveBeenCalled();
    expect(backupBusinessDataMock).not.toHaveBeenCalled();
    // Regression: Stripe captured payment for the new plan but we can't
    // orchestrate anything without a business row. Cancel the new sub.
    expect(stripeCancelMock).toHaveBeenCalledWith("sub_new", { prorate: false });
  });

  it("aborts if the old subscription row is missing and cancels the fresh Stripe sub", async () => {
    getSubscriptionMock.mockResolvedValueOnce(null);
    await runChangePlanFromCheckout(makeSession(), "evt_no_old_sub");
    expect(orchestrateProvisioningMock).not.toHaveBeenCalled();
    expect(stripeCancelMock).toHaveBeenCalledWith("sub_new", { prorate: false });
  });

  it("aborts if previousSubscriptionId does not match the current subscription and cancels the fresh Stripe sub", async () => {
    getSubscriptionMock.mockResolvedValueOnce({
      id: "sub-row-different",
      business_id: "biz-1",
      stripe_subscription_id: "sub_old",
      hostinger_billing_subscription_id: "billing_old",
      customer_profile_id: "prof-1",
      tier: "starter",
      billing_period: "monthly",
      status: "active",
      created_at: "2026-01-01T00:00:00.000Z",
      cancel_at_period_end: false
    });

    await runChangePlanFromCheckout(makeSession(), "evt_3");

    expect(orchestrateProvisioningMock).not.toHaveBeenCalled();
    expect(updateSubscriptionMock).not.toHaveBeenCalled();
    // Regression: stale/ooo replay can't clobber the newer row, but
    // must still cancel the fresh Stripe sub to avoid silent renewal.
    expect(stripeCancelMock).toHaveBeenCalledWith("sub_new", { prorate: false });
  });

  it("skips session without required metadata", async () => {
    await runChangePlanFromCheckout(
      makeSession({ metadata: { lifecycleAction: "changePlan" } }),
      "evt_4"
    );
    expect(getBusinessMock).not.toHaveBeenCalled();
  });

  it("skips unsupported change-plan tier and billing period metadata", async () => {
    await runChangePlanFromCheckout(
      makeSession({
        metadata: {
          businessId: "biz-1",
          previousSubscriptionId: "sub-row-old",
          tier: "enterprise",
          billingPeriod: "annual",
          lifecycleAction: "changePlan"
        }
      }),
      "evt_bad_tier"
    );
    await runChangePlanFromCheckout(
      makeSession({
        metadata: {
          businessId: "biz-1",
          previousSubscriptionId: "sub-row-old",
          tier: "standard",
          billingPeriod: "weekly",
          lifecycleAction: "changePlan"
        }
      }),
      "evt_bad_period"
    );

    expect(getBusinessMock).not.toHaveBeenCalled();
  });

  it("accepts object-shaped Stripe customer and subscription metadata", async () => {
    await runChangePlanFromCheckout(
      makeSession({
        customer: { id: "cus_object" } as Stripe.Customer,
        subscription: { id: "sub_object" } as Stripe.Subscription,
        customer_details: null,
        customer_email: "fallback@example.com"
      }),
      "evt_object_ids"
    );

    expect(createSubscriptionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        stripe_customer_id: "cus_object",
        stripe_subscription_id: "sub_object"
      })
    );
  });

  it("aborts change-plan if the existing subscription row is missing", async () => {
    getSubscriptionMock.mockResolvedValueOnce(null);

    await runChangePlanFromCheckout(makeSession(), "evt_missing_old_row");

    expect(orchestrateProvisioningMock).not.toHaveBeenCalled();
    expect(createSubscriptionMock).not.toHaveBeenCalled();
  });

  it("continues change-plan when customer profile upsert and old snapshot fail", async () => {
    upsertCustomerProfileMock.mockRejectedValueOnce(new Error("profile upsert failed"));
    hostingerCreateSnapshotMock.mockRejectedValueOnce(new Error("snapshot failed"));

    await runChangePlanFromCheckout(makeSession(), "evt_profile_snapshot_failures");

    expect(incrementLifetimeSubscriptionCountMock).toHaveBeenCalledWith("prof-1");
    expect(createSubscriptionMock).toHaveBeenCalled();
    expect(stripeCancelMock).toHaveBeenCalledWith("sub_old", { prorate: false });
  });

  it("continues change-plan without backup when old VPS id cannot resolve", async () => {
    getBusinessMock.mockResolvedValueOnce({
      id: "biz-1",
      owner_email: "owner@example.com",
      hostinger_vps_id: "not-a-number",
      customer_profile_id: "prof-1",
      status: "online"
    });

    await runChangePlanFromCheckout(makeSession(), "evt_no_old_vps");

    expect(backupBusinessDataMock).not.toHaveBeenCalled();
    expect(createSubscriptionMock).toHaveBeenCalled();
  });

  it("continues change-plan when old or new VM IP lookup fails", async () => {
    hostingerGetVmMock.mockRejectedValue(new Error("vm lookup failed"));

    await runChangePlanFromCheckout(makeSession(), "evt_vm_lookup_fail");

    expect(backupBusinessDataMock).not.toHaveBeenCalled();
    expect(restoreBusinessDataMock).not.toHaveBeenCalled();
    expect(createSubscriptionMock).toHaveBeenCalled();
  });

  it("skips change-plan restore when the new provisioning id is not numeric", async () => {
    orchestrateProvisioningMock.mockResolvedValueOnce({
      vpsId: "not-a-number",
      tunnelUrl: "https://biz-1.example.com",
      hostingerBillingSubscriptionId: "billing_new"
    });

    await runChangePlanFromCheckout(makeSession(), "evt_change_new_vps_not_numeric");

    expect(backupBusinessDataMock).toHaveBeenCalled();
    expect(restoreBusinessDataMock).not.toHaveBeenCalled();
    expect(createSubscriptionMock).toHaveBeenCalled();
  });

  it("allows change-plan without optional checkout ids or customer profile", async () => {
    getBusinessMock.mockResolvedValueOnce({
      id: "biz-1",
      owner_email: "owner@example.com",
      hostinger_vps_id: "1001",
      customer_profile_id: null,
      status: "online"
    });
    getSubscriptionMock.mockResolvedValueOnce({
      id: "sub-row-old",
      business_id: "biz-1",
      stripe_subscription_id: "sub_old",
      hostinger_billing_subscription_id: "billing_old",
      customer_profile_id: null,
      tier: "starter",
      billing_period: "monthly",
      status: "active",
      created_at: "2026-01-01T00:00:00.000Z",
      cancel_at_period_end: false
    });

    await runChangePlanFromCheckout(
      makeSession({
        customer: null,
        subscription: null,
        customer_details: null,
        customer_email: null
      }),
      "evt_change_optional_ids_missing"
    );

    expect(incrementLifetimeSubscriptionCountMock).not.toHaveBeenCalled();
    expect(setBusinessCustomerProfileMock).not.toHaveBeenCalled();
    expect(createSubscriptionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        stripe_customer_id: null,
        stripe_subscription_id: null,
        customer_profile_id: null
      })
    );
    expect(ensureCommitmentScheduleMock).not.toHaveBeenCalled();
  });

  it("continues change-plan when the old subscription has no Hostinger billing id", async () => {
    getSubscriptionMock.mockResolvedValueOnce({
      id: "sub-row-old",
      business_id: "biz-1",
      stripe_subscription_id: "sub_old",
      hostinger_billing_subscription_id: null,
      customer_profile_id: "prof-1",
      tier: "starter",
      billing_period: "monthly",
      status: "active",
      created_at: "2026-01-01T00:00:00.000Z",
      cancel_at_period_end: false
    });

    await runChangePlanFromCheckout(makeSession(), "evt_no_old_hostinger_billing");

    expect(hostingerCancelBillingSubscriptionMock).not.toHaveBeenCalled();
    expect(updateSubscriptionMock).toHaveBeenCalledWith(
      "sub-row-old",
      expect.objectContaining({ status: "canceled" })
    );
  });

  it("continues change-plan when the old subscription has no Stripe id", async () => {
    getSubscriptionMock.mockResolvedValueOnce({
      id: "sub-row-old",
      business_id: "biz-1",
      stripe_subscription_id: null,
      hostinger_billing_subscription_id: "billing_old",
      customer_profile_id: "prof-1",
      tier: "starter",
      billing_period: "monthly",
      status: "active",
      created_at: "2026-01-01T00:00:00.000Z",
      cancel_at_period_end: false
    });

    await runChangePlanFromCheckout(makeSession(), "evt_no_old_stripe_id");

    expect(stripeCancelMock).not.toHaveBeenCalledWith("sub_old", expect.anything());
    expect(updateSubscriptionMock).toHaveBeenCalledWith(
      "sub-row-old",
      expect.objectContaining({ status: "canceled" })
    );
  });

  it("continues teardown even if backup fails", async () => {
    backupBusinessDataMock.mockRejectedValueOnce(new Error("ssh blew up"));
    await runChangePlanFromCheckout(makeSession(), "evt_5");
    expect(orchestrateProvisioningMock).toHaveBeenCalled();
    expect(restoreBusinessDataMock).not.toHaveBeenCalled();
    expect(stripeCancelMock).toHaveBeenCalled();
    expect(hostingerCancelBillingSubscriptionMock).toHaveBeenCalled();
    expect(updateSubscriptionMock).toHaveBeenCalledWith(
      "sub-row-old",
      expect.objectContaining({ status: "canceled", cancel_reason: "upgrade_switch" })
    );
  });

  it("does not unwind new provisioning if teardown of old sub fails", async () => {
    stripeCancelMock.mockRejectedValueOnce(new Error("stripe down"));
    hostingerCancelBillingSubscriptionMock.mockRejectedValueOnce(new Error("hostinger down"));

    await runChangePlanFromCheckout(makeSession(), "evt_6");

    expect(createSubscriptionMock).toHaveBeenCalled();
    expect(updateSubscriptionMock).toHaveBeenCalledWith(
      "sub-row-old",
      expect.objectContaining({ status: "canceled" })
    );
  });

  it("covers string teardown failures and already-missing Stripe subscriptions", async () => {
    stripeRetrieveMock.mockImplementation(async (id: string) => {
      if (id === "sub_old") throw new Error("No such subscription: sub_old");
      return {
        id,
        status: "active",
        schedule: null,
        items: { data: [{ current_period_start: 1700000000, current_period_end: 1702678400 }] }
      };
    });
    hostingerCancelBillingSubscriptionMock.mockRejectedValueOnce("hostinger string failure");

    await runChangePlanFromCheckout(makeSession(), "evt_missing_old");

    expect(createSubscriptionMock).toHaveBeenCalled();
    expect(updateSubscriptionMock).toHaveBeenCalledWith(
      "sub-row-old",
      expect.objectContaining({ status: "canceled" })
    );
  });

  it("continues when old Stripe schedule release throws a non-Error", async () => {
    stripeScheduleReleaseMock.mockRejectedValueOnce("release string failure");

    await runChangePlanFromCheckout(makeSession(), "evt_release_string");

    expect(stripeCancelMock).toHaveBeenCalledWith("sub_old", { prorate: false });
  });

  it("handles object schedules and already-canceled old Stripe subscriptions", async () => {
    stripeRetrieveMock.mockImplementation(async (id: string) => ({
      id,
      status: id === "sub_old" ? "canceled" : "active",
      schedule: id === "sub_old" ? ({ id: "sched_object" } as Stripe.SubscriptionSchedule) : null,
      items: { data: [{ current_period_start: 1700000000, current_period_end: 1702678400 }] }
    }));

    await runChangePlanFromCheckout(makeSession(), "evt_object_schedule_canceled");

    expect(stripeScheduleReleaseMock).toHaveBeenCalledWith("sched_object");
    expect(stripeCancelMock).not.toHaveBeenCalledWith("sub_old", expect.anything());
  });

  it("handles old Stripe subscriptions without schedules", async () => {
    stripeRetrieveMock.mockImplementation(async (id: string) => ({
      id,
      status: "active",
      schedule: null,
      items: { data: [{ current_period_start: 1700000000, current_period_end: 1702678400 }] }
    }));

    await runChangePlanFromCheckout(makeSession(), "evt_no_schedule");

    expect(stripeScheduleReleaseMock).not.toHaveBeenCalled();
    expect(stripeCancelMock).toHaveBeenCalledWith("sub_old", { prorate: false });
  });

  it("continues when old Stripe schedule release throws an Error", async () => {
    stripeScheduleReleaseMock.mockRejectedValueOnce(new Error("release error"));

    await runChangePlanFromCheckout(makeSession(), "evt_release_error");

    expect(stripeCancelMock).toHaveBeenCalledWith("sub_old", { prorate: false });
  });

  it("treats string resource_missing errors as already gone", async () => {
    stripeRetrieveMock.mockImplementation(async (id: string) => {
      if (id === "sub_old") throw "resource_missing";
      return {
        id,
        status: "active",
        schedule: null,
        items: { data: [{ current_period_start: 1700000000, current_period_end: 1702678400 }] }
      };
    });

    await runChangePlanFromCheckout(makeSession(), "evt_resource_missing_string");

    expect(stripeCancelMock).not.toHaveBeenCalledWith("sub_old", expect.anything());
    expect(updateSubscriptionMock).toHaveBeenCalledWith(
      "sub-row-old",
      expect.objectContaining({ status: "canceled" })
    );
  });

  it("logs and continues when old Stripe cancel fails unexpectedly", async () => {
    stripeRetrieveMock.mockImplementation(async (id: string) => {
      if (id === "sub_old") throw new Error("stripe outage");
      return {
        id,
        status: "active",
        schedule: null,
        items: { data: [{ current_period_start: 1700000000, current_period_end: 1702678400 }] }
      };
    });

    await runChangePlanFromCheckout(makeSession(), "evt_stripe_outage");

    expect(updateSubscriptionMock).toHaveBeenCalledWith(
      "sub-row-old",
      expect.objectContaining({ status: "canceled" })
    );
  });

  it("continues when change-plan bookkeeping, scheduling, and old VPS stop fail", async () => {
    setBusinessCustomerProfileMock.mockRejectedValueOnce(new Error("profile link failed"));
    ensureCommitmentScheduleMock.mockRejectedValueOnce(new Error("schedule failed"));
    hostingerStopVirtualMachineMock.mockRejectedValueOnce(new Error("stop failed"));

    await runChangePlanFromCheckout(makeSession(), "evt_change_best_effort_failures");

    expect(createSubscriptionMock).toHaveBeenCalled();
    expect(hostingerCancelBillingSubscriptionMock).toHaveBeenCalledWith(
      "billing_old",
      expect.any(String)
    );
    expect(updateSubscriptionMock).toHaveBeenCalledWith(
      "sub-row-old",
      expect.objectContaining({ status: "canceled" })
    );
  });

  it("continues when change-plan restore and new Stripe lookup fail", async () => {
    restoreBusinessDataMock.mockRejectedValueOnce(new Error("restore failed"));
    stripeRetrieveMock.mockImplementation(async (id: string) => {
      if (id === "sub_new") throw new Error("new stripe lookup failed");
      return {
        id,
        status: "active",
        schedule: id === "sub_old" ? "sched_old" : null,
        items: { data: [{ current_period_start: 1700000000, current_period_end: 1702678400 }] }
      };
    });

    await runChangePlanFromCheckout(makeSession(), "evt_change_restore_lookup_fail");

    expect(createSubscriptionMock).toHaveBeenCalledWith(
      expect.objectContaining({ stripe_subscription_id: "sub_new" })
    );
    expect(stripeCancelMock).toHaveBeenCalledWith("sub_old", { prorate: false });
  });

  it("cancels the fresh Stripe sub if new provisioning throws before touching old subscription", async () => {
    orchestrateProvisioningMock.mockRejectedValueOnce(new Error("provision boom"));

    await runChangePlanFromCheckout(makeSession(), "evt_7");

    expect(createSubscriptionMock).not.toHaveBeenCalled();
    expect(stripeCancelMock).toHaveBeenCalledWith("sub_new", { prorate: false });
    expect(stripeCancelMock).not.toHaveBeenCalledWith("sub_old", expect.anything());
    expect(hostingerCancelBillingSubscriptionMock).not.toHaveBeenCalled();
    expect(updateSubscriptionMock).not.toHaveBeenCalled();
    // Lifetime-count rollback: the counter was bumped before provisioning
    // (atomic cap enforcement); when provisioning throws we must
    // compensate so the customer doesn't permanently lose a lifetime
    // slot for a subscription they never received.
    expect(decrementLifetimeSubscriptionCountMock).toHaveBeenCalledWith("prof-1");
  });

  it("aborts without cancelling Stripe when provisioning throws and no new Stripe sub id is on the session", async () => {
    orchestrateProvisioningMock.mockRejectedValueOnce(new Error("provision boom"));

    await runChangePlanFromCheckout(makeSession({ subscription: null }), "evt_7b");

    expect(createSubscriptionMock).not.toHaveBeenCalled();
    expect(stripeCancelMock).not.toHaveBeenCalled();
    expect(hostingerCancelBillingSubscriptionMock).not.toHaveBeenCalled();
    expect(updateSubscriptionMock).not.toHaveBeenCalled();
  });

  it("skips lifetime rollback when provisioning fails and customer profile id is unresolved", async () => {
    // Edge: no session email + no customer_profile_id linkage on either
    // the business row or the old subscription row → customerProfileId
    // ends up null. Provisioning failure must NOT call decrement (no row
    // to compensate) and the cancel still fires.
    getBusinessMock.mockResolvedValueOnce({
      id: "biz-1",
      owner_email: "owner@example.com",
      hostinger_vps_id: "1001",
      customer_profile_id: null,
      status: "online"
    });
    getSubscriptionMock.mockResolvedValueOnce({
      id: "sub-row-old",
      business_id: "biz-1",
      stripe_subscription_id: "sub_old",
      hostinger_billing_subscription_id: "billing_old",
      customer_profile_id: null,
      tier: "starter",
      billing_period: "monthly",
      status: "active",
      created_at: "2026-01-01T00:00:00.000Z",
      cancel_at_period_end: false
    });
    orchestrateProvisioningMock.mockRejectedValueOnce(new Error("provision boom"));

    await runChangePlanFromCheckout(
      makeSession({ customer_details: null, customer_email: null }),
      "evt_change_no_profile"
    );

    expect(stripeCancelMock).toHaveBeenCalledWith("sub_new", { prorate: false });
    expect(decrementLifetimeSubscriptionCountMock).not.toHaveBeenCalled();
  });

  it("aborts changePlan business-missing without cancelling Stripe when no new Stripe sub id is on the session", async () => {
    getBusinessMock.mockResolvedValueOnce(null);
    await runChangePlanFromCheckout(makeSession({ subscription: null }), "evt_no_biz_no_sub");
    expect(stripeCancelMock).not.toHaveBeenCalled();
  });

  it("aborts changePlan when oldSub is missing and no new Stripe sub id was issued", async () => {
    getSubscriptionMock.mockResolvedValueOnce(null);
    await runChangePlanFromCheckout(
      makeSession({ subscription: null }),
      "evt_no_old_sub_no_stripe"
    );
    expect(stripeCancelMock).not.toHaveBeenCalled();
  });

  it("aborts changePlan on sub mismatch without cancelling Stripe when no new Stripe sub id is on the session", async () => {
    getSubscriptionMock.mockResolvedValueOnce({
      id: "sub-row-different",
      business_id: "biz-1",
      stripe_subscription_id: "sub_old",
      hostinger_billing_subscription_id: "billing_old",
      customer_profile_id: "prof-1",
      tier: "starter",
      billing_period: "monthly",
      status: "active",
      created_at: "2026-01-01T00:00:00.000Z",
      cancel_at_period_end: false
    });
    await runChangePlanFromCheckout(
      makeSession({ subscription: null }),
      "evt_sub_mismatch_no_stripe"
    );
    expect(stripeCancelMock).not.toHaveBeenCalled();
  });

  it("aborts before provisioning when the lifetime cap increment rejects and cancels the fresh Stripe sub", async () => {
    incrementLifetimeSubscriptionCountMock.mockRejectedValueOnce(new Error("cap reached"));

    await runChangePlanFromCheckout(makeSession(), "evt_change_cap");

    expect(orchestrateProvisioningMock).not.toHaveBeenCalled();
    expect(createSubscriptionMock).not.toHaveBeenCalled();
    // The newly paid Stripe subscription must be canceled so it doesn't
    // silently auto-renew for a customer who'll never be provisioned.
    expect(stripeCancelMock).toHaveBeenCalledWith("sub_new", { prorate: false });
    // The OLD sub is NOT touched — teardown never ran.
    expect(stripeCancelMock).not.toHaveBeenCalledWith("sub_old", expect.anything());
  });

  it("aborts without calling Stripe cancel when cap rejects and no fresh sub id was issued", async () => {
    // Defensive branch: if session.subscription is absent (pathological
    // Stripe state), we can't cancel anything, but we still must not
    // provision.
    incrementLifetimeSubscriptionCountMock.mockRejectedValueOnce(new Error("cap reached"));

    await runChangePlanFromCheckout(
      makeSession({ subscription: null }),
      "evt_change_cap_no_sub"
    );

    expect(orchestrateProvisioningMock).not.toHaveBeenCalled();
    expect(createSubscriptionMock).not.toHaveBeenCalled();
    expect(stripeCancelMock).not.toHaveBeenCalled();
  });

  it("is idempotent on webhook re-delivery: skips re-execution when an active row is already linked to the new Stripe sub", async () => {
    // Regression: Stripe re-delivers `checkout.session.completed` on
    // ack timeouts, manual replays, and delivery sweeps, and the webhook
    // entrypoint has no event-id deduplication. A naïve re-entry after
    // a successful first run would observe `getSubscription(businessId)`
    // returning the new active sub (most-recent row), see its id !==
    // `previousSubscriptionId`, and call `cancelStripeSubscriptionSafely`
    // on `stripeSubscriptionId` — which is the LIVE customer-paid
    // subscription. Detecting the already-completed signature must
    // short-circuit BEFORE that branch can fire.
    getSubscriptionByStripeSubscriptionIdMock.mockResolvedValueOnce({
      id: "sub-row-new",
      business_id: "biz-1",
      stripe_subscription_id: "sub_new",
      hostinger_billing_subscription_id: "billing_new",
      customer_profile_id: "prof-1",
      tier: "standard",
      billing_period: "annual",
      status: "active",
      created_at: "2026-02-01T00:00:00.000Z",
      cancel_at_period_end: false
    });

    await runChangePlanFromCheckout(makeSession(), "evt_redelivery");

    // Critical: must NOT cancel the live, customer-paid Stripe sub.
    expect(stripeCancelMock).not.toHaveBeenCalled();
    // And must not re-run any of the orchestrator's side effects.
    expect(orchestrateProvisioningMock).not.toHaveBeenCalled();
    expect(backupBusinessDataMock).not.toHaveBeenCalled();
    expect(restoreBusinessDataMock).not.toHaveBeenCalled();
    expect(createSubscriptionMock).not.toHaveBeenCalled();
    expect(updateSubscriptionMock).not.toHaveBeenCalled();
    expect(incrementLifetimeSubscriptionCountMock).not.toHaveBeenCalled();
    expect(hostingerCancelBillingSubscriptionMock).not.toHaveBeenCalled();
  });

  it("does NOT short-circuit on a same-stripe-id row owned by a different business (defense against id-collision spoofing)", async () => {
    // The idempotency check requires both the stripe id match AND the
    // business id match. A row pinned to a different business must not
    // be treated as a successful prior run for this business.
    getSubscriptionByStripeSubscriptionIdMock.mockResolvedValueOnce({
      id: "sub-row-new",
      business_id: "biz-OTHER",
      stripe_subscription_id: "sub_new",
      status: "active",
      tier: "standard",
      billing_period: "annual",
      customer_profile_id: "prof-other",
      created_at: "2026-02-01T00:00:00.000Z",
      cancel_at_period_end: false
    });

    await runChangePlanFromCheckout(makeSession(), "evt_id_collision");

    expect(orchestrateProvisioningMock).toHaveBeenCalled();
  });

  it("does NOT short-circuit when the linked row is non-active (e.g. mid-cancellation)", async () => {
    // A canceled / wiped row is not a "successful prior run" — the
    // orchestrator should be free to proceed (or hit a structural
    // abort) rather than returning silently.
    getSubscriptionByStripeSubscriptionIdMock.mockResolvedValueOnce({
      id: "sub-row-new",
      business_id: "biz-1",
      stripe_subscription_id: "sub_new",
      status: "canceled",
      tier: "standard",
      billing_period: "annual",
      customer_profile_id: "prof-1",
      created_at: "2026-02-01T00:00:00.000Z",
      cancel_at_period_end: false
    });

    await runChangePlanFromCheckout(makeSession(), "evt_canceled_link");

    expect(orchestrateProvisioningMock).toHaveBeenCalled();
  });
});

describe("runResubscribeFromCheckout", () => {
  it("provisions a fresh VPS, restores backup, and clears grace on the existing subscription row", async () => {
    getSubscriptionMock.mockResolvedValue({
      id: "sub-row-grace",
      business_id: "biz-1",
      stripe_subscription_id: "sub_old_canceled",
      hostinger_billing_subscription_id: "billing_old_canceled",
      customer_profile_id: "prof-1",
      tier: "starter",
      billing_period: "monthly",
      status: "canceled",
      grace_ends_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      wiped_at: null,
      created_at: "2026-01-01T00:00:00.000Z"
    });

    await runResubscribeFromCheckout(
      makeSession({
        metadata: {
          businessId: "biz-1",
          tier: "standard",
          billingPeriod: "annual",
          lifecycleAction: "resubscribe",
          customerProfileId: "prof-1"
        }
      }),
      "evt_resub"
    );

    expect(orchestrateProvisioningMock).toHaveBeenCalledWith({
      businessId: "biz-1",
      tier: "standard",
      ownerEmail: "owner@example.com"
    });
    expect(restoreBusinessDataMock).toHaveBeenCalledWith({
      businessId: "biz-1",
      vpsHost: "10.0.0.2"
    });
    expect(updateSubscriptionIfNotWipedMock).toHaveBeenCalledWith(
      "sub-row-grace",
      expect.objectContaining({
        status: "active",
        stripe_subscription_id: "sub_new",
        tier: "standard",
        billing_period: "annual",
        grace_ends_at: null,
        cancel_reason: null,
        canceled_at: null,
        cancel_at_period_end: false
      })
    );
    expect(incrementLifetimeSubscriptionCountMock).toHaveBeenCalledWith("prof-1");
  });

  it("continues when resubscribe post-update bookkeeping fails", async () => {
    getSubscriptionMock.mockResolvedValue({
      id: "sub-row-grace",
      business_id: "biz-1",
      stripe_subscription_id: "sub_old_canceled",
      hostinger_billing_subscription_id: "billing_old_canceled",
      customer_profile_id: "prof-1",
      tier: "starter",
      billing_period: "monthly",
      status: "canceled",
      grace_ends_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      wiped_at: null,
      created_at: "2026-01-01T00:00:00.000Z"
    });
    setBusinessCustomerProfileMock.mockRejectedValueOnce(new Error("profile link failed"));
    ensureCommitmentScheduleMock.mockRejectedValueOnce(new Error("schedule failed"));

    await runResubscribeFromCheckout(
      makeSession({
        metadata: {
          businessId: "biz-1",
          tier: "standard",
          billingPeriod: "annual",
          lifecycleAction: "resubscribe",
          customerProfileId: "prof-1"
        }
      }),
      "evt_resub_failures"
    );

    expect(updateSubscriptionIfNotWipedMock).toHaveBeenCalledWith(
      "sub-row-grace",
      expect.objectContaining({ status: "active", cancel_reason: null })
    );
    expect(ensureCommitmentScheduleMock).toHaveBeenCalled();
  });

  it("aborts resubscribe before provisioning when the lifetime cap increment rejects and cancels the fresh Stripe sub", async () => {
    getSubscriptionMock.mockResolvedValue({
      id: "sub-row-grace",
      business_id: "biz-1",
      customer_profile_id: "prof-1",
      status: "canceled",
      grace_ends_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      wiped_at: null
    });
    incrementLifetimeSubscriptionCountMock.mockRejectedValueOnce(new Error("cap reached"));

    await runResubscribeFromCheckout(
      makeSession({
        metadata: {
          businessId: "biz-1",
          tier: "standard",
          billingPeriod: "annual",
          lifecycleAction: "resubscribe",
          customerProfileId: "prof-1"
        }
      }),
      "evt_resub_cap"
    );

    expect(orchestrateProvisioningMock).not.toHaveBeenCalled();
    expect(updateSubscriptionMock).not.toHaveBeenCalled();
    // Same guarantee as the changePlan cap-reached branch: the freshly
    // paid resubscribe Stripe sub must be canceled so the customer
    // doesn't keep getting billed with no service behind it.
    expect(stripeCancelMock).toHaveBeenCalledWith("sub_new", { prorate: false });
  });

  it("aborts resubscribe when fresh provisioning fails and cancels the new Stripe sub + rolls back lifetime count", async () => {
    getSubscriptionMock.mockResolvedValue({
      id: "sub-row-grace",
      business_id: "biz-1",
      customer_profile_id: "prof-1",
      status: "canceled",
      grace_ends_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      wiped_at: null
    });
    orchestrateProvisioningMock.mockRejectedValueOnce(new Error("provision failed"));

    await runResubscribeFromCheckout(
      makeSession({
        metadata: {
          businessId: "biz-1",
          tier: "standard",
          billingPeriod: "annual",
          lifecycleAction: "resubscribe",
          customerProfileId: "prof-1"
        }
      }),
      "evt_resub_provision_fail"
    );

    expect(updateSubscriptionMock).not.toHaveBeenCalled();
    // Regression: previously this path silently returned, leaving the
    // customer charged forever for a subscription that delivered no
    // service. Cancel the fresh Stripe sub and roll back the lifetime
    // counter that was bumped before provisioning.
    expect(stripeCancelMock).toHaveBeenCalledWith("sub_new", { prorate: false });
    expect(decrementLifetimeSubscriptionCountMock).toHaveBeenCalledWith("prof-1");
  });

  it("swallows rollback errors so the primary provisioning error stays surfaced", async () => {
    getSubscriptionMock.mockResolvedValue({
      id: "sub-row-grace",
      business_id: "biz-1",
      customer_profile_id: "prof-1",
      status: "canceled",
      grace_ends_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      wiped_at: null
    });
    orchestrateProvisioningMock.mockRejectedValueOnce(new Error("provision failed"));
    decrementLifetimeSubscriptionCountMock.mockRejectedValueOnce(new Error("rollback RPC down"));

    await expect(
      runResubscribeFromCheckout(
        makeSession({
          metadata: {
            businessId: "biz-1",
            tier: "standard",
            billingPeriod: "annual",
            lifecycleAction: "resubscribe",
            customerProfileId: "prof-1"
          }
        }),
        "evt_resub_rollback_fail"
      )
    ).resolves.toBeUndefined();

    expect(decrementLifetimeSubscriptionCountMock).toHaveBeenCalledWith("prof-1");
  });

  it("aborts resubscribe (fail-closed) when restoreBusinessData throws — prevents silent empty-workspace activation after grace-sweep partial-execute", async () => {
    // Regression: the orchestrator previously caught and swallowed
    // restoreBusinessData errors (logging "customer may need manual
    // recovery") and continued to the optimistic write. The
    // `updateSubscriptionIfNotWiped` guard ONLY blocks when
    // `wiped_at` is set, but the grace-sweep planner used to delete
    // the backup artifact BEFORE stamping `wiped_at` — so a
    // partial-execute crash (Vercel timeout, transient Storage
    // error) could leave the backup gone but `wiped_at` still null,
    // and the orchestrator would silently provision an empty
    // workspace + charge the customer + bump lifetime. The grace-
    // sweep planner ordering is now fixed too (sister test in
    // billing-lifecycle.test.ts), but this orchestrator-side
    // fail-closed is defense-in-depth: any `restoreBusinessData`
    // throw (no backup recorded, sha mismatch, missing SSH key,
    // transient SSH error) must abort the resubscribe with an
    // operator-visible signal rather than silently activating.
    getSubscriptionMock.mockResolvedValue({
      id: "sub-row-grace",
      business_id: "biz-1",
      customer_profile_id: "prof-1",
      status: "canceled",
      grace_ends_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      wiped_at: null
    });
    restoreBusinessDataMock.mockRejectedValueOnce(
      new Error("restoreBusinessData: no backup recorded for biz-1")
    );

    await runResubscribeFromCheckout(
      makeSession({
        metadata: {
          businessId: "biz-1",
          tier: "standard",
          billingPeriod: "annual",
          lifecycleAction: "resubscribe",
          customerProfileId: "prof-1"
        }
      }),
      "evt_resub_restore_fail"
    );

    // No optimistic write — the row stays canceled-in-grace so
    // operators can investigate the missing backup.
    expect(updateSubscriptionIfNotWipedMock).not.toHaveBeenCalled();
    // Cancel the brand-new Stripe sub so it can't auto-renew for
    // service we'll never provide.
    expect(stripeCancelMock).toHaveBeenCalledWith("sub_new", { prorate: false });
    // Roll back the lifetime counter we bumped earlier so the
    // customer doesn't lose a slot for an attempt that never landed.
    expect(decrementLifetimeSubscriptionCountMock).toHaveBeenCalledWith("prof-1");
  });

  it("aborts resubscribe on restore failure even when the Stripe sub id is missing — only the lifetime rollback runs (no Stripe.cancel call)", async () => {
    // Branch coverage for the restore-throw abort: `if
    // (stripeSubscriptionId)` false. A checkout session with no
    // `subscription` field should still trigger the lifetime rollback
    // but NOT call Stripe.cancel (there is no Stripe sub to cancel).
    // This ensures we don't blow up trying to cancel a null id.
    getSubscriptionMock.mockResolvedValue({
      id: "sub-row-grace",
      business_id: "biz-1",
      customer_profile_id: "prof-1",
      status: "canceled",
      grace_ends_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      wiped_at: null
    });
    restoreBusinessDataMock.mockRejectedValueOnce(new Error("no backup"));

    await runResubscribeFromCheckout(
      makeSession({
        subscription: null,
        metadata: {
          businessId: "biz-1",
          tier: "standard",
          billingPeriod: "annual",
          lifecycleAction: "resubscribe",
          customerProfileId: "prof-1"
        }
      }),
      "evt_resub_restore_fail_no_sub"
    );

    expect(updateSubscriptionIfNotWipedMock).not.toHaveBeenCalled();
    expect(stripeCancelMock).not.toHaveBeenCalled();
    expect(decrementLifetimeSubscriptionCountMock).toHaveBeenCalledWith("prof-1");
  });

  it("aborts resubscribe on restore failure even when no customer profile is resolvable — only Stripe.cancel runs (no rollback call)", async () => {
    // Branch coverage for the restore-throw abort: `if
    // (customerProfileId)` false. With no profile id resolvable from
    // metadata, the old sub, business row, OR session email upsert,
    // the lifetime rollback is skipped (there's no profile slot to
    // give back), but Stripe.cancel still fires to stop the new sub.
    getSubscriptionMock.mockResolvedValue({
      id: "sub-row-grace",
      business_id: "biz-1",
      customer_profile_id: null,
      status: "canceled",
      grace_ends_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      wiped_at: null,
      tier: "standard",
      billing_period: "annual"
    });
    getBusinessMock.mockResolvedValue({
      id: "biz-1",
      owner_email: null,
      hostinger_vps_id: "1001",
      customer_profile_id: null,
      status: "online"
    });
    restoreBusinessDataMock.mockRejectedValueOnce(new Error("no backup"));

    await runResubscribeFromCheckout(
      makeSession({
        customer_email: null,
        customer_details: null as unknown as NonNullable<Stripe.Checkout.Session["customer_details"]>,
        metadata: {
          businessId: "biz-1",
          lifecycleAction: "resubscribe"
        }
      }),
      "evt_resub_restore_fail_no_profile"
    );

    expect(updateSubscriptionIfNotWipedMock).not.toHaveBeenCalled();
    expect(stripeCancelMock).toHaveBeenCalledWith("sub_new", { prorate: false });
    expect(decrementLifetimeSubscriptionCountMock).not.toHaveBeenCalled();
  });

  it("aborts resubscribe on unresolvable VPS host even when the Stripe sub id is missing — only the lifetime rollback runs", async () => {
    // Branch coverage for the host-unresolvable abort: `if
    // (stripeSubscriptionId)` false. Same defense-in-depth reasoning
    // as the restore-throw branch, but for the unreachable-VM path.
    getSubscriptionMock.mockResolvedValue({
      id: "sub-row-grace",
      business_id: "biz-1",
      customer_profile_id: "prof-1",
      status: "canceled",
      grace_ends_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      wiped_at: null
    });
    hostingerGetVmMock.mockImplementation(async (id: number) => ({ id, ipv4: [] }));

    await runResubscribeFromCheckout(
      makeSession({
        subscription: null,
        metadata: {
          businessId: "biz-1",
          tier: "standard",
          billingPeriod: "annual",
          lifecycleAction: "resubscribe",
          customerProfileId: "prof-1"
        }
      }),
      "evt_resub_no_host_no_sub"
    );

    expect(updateSubscriptionIfNotWipedMock).not.toHaveBeenCalled();
    expect(stripeCancelMock).not.toHaveBeenCalled();
    expect(decrementLifetimeSubscriptionCountMock).toHaveBeenCalledWith("prof-1");
  });

  it("aborts resubscribe on unresolvable VPS host even when no customer profile is resolvable — only Stripe.cancel runs", async () => {
    // Branch coverage for the host-unresolvable abort: `if
    // (customerProfileId)` false.
    getSubscriptionMock.mockResolvedValue({
      id: "sub-row-grace",
      business_id: "biz-1",
      customer_profile_id: null,
      status: "canceled",
      grace_ends_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      wiped_at: null,
      tier: "standard",
      billing_period: "annual"
    });
    getBusinessMock.mockResolvedValue({
      id: "biz-1",
      owner_email: null,
      hostinger_vps_id: "1001",
      customer_profile_id: null,
      status: "online"
    });
    hostingerGetVmMock.mockImplementation(async (id: number) => ({ id, ipv4: [] }));

    await runResubscribeFromCheckout(
      makeSession({
        customer_email: null,
        customer_details: null as unknown as NonNullable<Stripe.Checkout.Session["customer_details"]>,
        metadata: {
          businessId: "biz-1",
          lifecycleAction: "resubscribe"
        }
      }),
      "evt_resub_no_host_no_profile"
    );

    expect(updateSubscriptionIfNotWipedMock).not.toHaveBeenCalled();
    expect(stripeCancelMock).toHaveBeenCalledWith("sub_new", { prorate: false });
    expect(decrementLifetimeSubscriptionCountMock).not.toHaveBeenCalled();
  });

  it("continues resubscribe when ONLY the post-restore Stripe subscription lookup fails (period cache is best-effort)", async () => {
    // Stripe.subscriptions.retrieve at the end of the orchestrator
    // is purely for refreshing the local period cache — its failure
    // must NOT abort because the customer's data restored fine and
    // every other field on the write is already known. The
    // resurrected-row period cache is recomputed on the next
    // `invoice.paid` / `customer.subscription.updated` mirror.
    getSubscriptionMock.mockResolvedValue({
      id: "sub-row-grace",
      business_id: "biz-1",
      customer_profile_id: "prof-1",
      status: "canceled",
      grace_ends_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      wiped_at: null
    });
    restoreBusinessDataMock.mockResolvedValueOnce(undefined as never);
    stripeRetrieveMock.mockRejectedValueOnce(new Error("stripe lookup failed"));

    await runResubscribeFromCheckout(
      makeSession({
        metadata: {
          businessId: "biz-1",
          tier: "standard",
          billingPeriod: "annual",
          lifecycleAction: "resubscribe",
          customerProfileId: "prof-1"
        }
      }),
      "evt_resub_stripe_lookup_fail"
    );

    expect(updateSubscriptionIfNotWipedMock).toHaveBeenCalledWith(
      "sub-row-grace",
      expect.objectContaining({ status: "active" })
    );
  });

  it("aborts resubscribe when business is missing or latest row is not in grace and cancels the new Stripe sub", async () => {
    getBusinessMock.mockResolvedValueOnce(null);
    await runResubscribeFromCheckout(
      makeSession({
        metadata: {
          businessId: "biz-1",
          tier: "standard",
          billingPeriod: "annual",
          lifecycleAction: "resubscribe"
        }
      }),
      "evt_resub_no_business"
    );
    expect(orchestrateProvisioningMock).not.toHaveBeenCalled();
    // Regression: must cancel the freshly-minted Stripe sub so the
    // customer isn't billed forever for a resubscribe we won't complete.
    expect(stripeCancelMock).toHaveBeenCalledWith("sub_new", { prorate: false });

    stripeCancelMock.mockClear();
    getBusinessMock.mockResolvedValueOnce({
      id: "biz-1",
      owner_email: "owner@example.com",
      hostinger_vps_id: "1001",
      customer_profile_id: "prof-1",
      status: "online"
    });
    getSubscriptionMock.mockResolvedValueOnce(null);
    await runResubscribeFromCheckout(
      makeSession({
        metadata: {
          businessId: "biz-1",
          tier: "standard",
          billingPeriod: "annual",
          lifecycleAction: "resubscribe"
        }
      }),
      "evt_resub_no_grace"
    );
    expect(orchestrateProvisioningMock).not.toHaveBeenCalled();
    // Same regression: out-of-grace / wiped old sub must still cancel
    // the new Stripe sub.
    expect(stripeCancelMock).toHaveBeenCalledWith("sub_new", { prorate: false });
  });

  it("aborts resubscribe business-missing without cancelling when there is no new Stripe sub id on the session", async () => {
    getBusinessMock.mockResolvedValueOnce(null);
    await runResubscribeFromCheckout(
      makeSession({
        subscription: null,
        metadata: {
          businessId: "biz-1",
          tier: "standard",
          billingPeriod: "annual",
          lifecycleAction: "resubscribe"
        }
      }),
      "evt_resub_no_biz_no_sub"
    );
    expect(stripeCancelMock).not.toHaveBeenCalled();
    expect(orchestrateProvisioningMock).not.toHaveBeenCalled();
  });

  it("aborts resubscribe out-of-grace without cancelling when there is no new Stripe sub id on the session", async () => {
    getSubscriptionMock.mockResolvedValueOnce(null);
    await runResubscribeFromCheckout(
      makeSession({
        subscription: null,
        metadata: {
          businessId: "biz-1",
          tier: "standard",
          billingPeriod: "annual",
          lifecycleAction: "resubscribe"
        }
      }),
      "evt_resub_no_grace_no_sub"
    );
    expect(stripeCancelMock).not.toHaveBeenCalled();
    expect(orchestrateProvisioningMock).not.toHaveBeenCalled();
  });

  it("skips resubscribe Stripe cancel when provisioning fails and no new Stripe sub id is on the session", async () => {
    getSubscriptionMock.mockResolvedValue({
      id: "sub-row-grace",
      business_id: "biz-1",
      customer_profile_id: "prof-1",
      status: "canceled",
      grace_ends_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      wiped_at: null,
      tier: "standard",
      billing_period: "annual"
    });
    orchestrateProvisioningMock.mockRejectedValueOnce(new Error("provision failed"));

    await runResubscribeFromCheckout(
      makeSession({
        subscription: null,
        metadata: {
          businessId: "biz-1",
          tier: "standard",
          billingPeriod: "annual",
          lifecycleAction: "resubscribe",
          customerProfileId: "prof-1"
        }
      }),
      "evt_resub_provision_fail_no_sub"
    );

    expect(stripeCancelMock).not.toHaveBeenCalled();
    // Lifetime count rollback still runs even without a Stripe sub id
    // since we already bumped the counter.
    expect(decrementLifetimeSubscriptionCountMock).toHaveBeenCalledWith("prof-1");
  });

  it("skips resubscribe lifetime rollback when provisioning fails and no profile is resolved", async () => {
    // Edge: session has no email + neither business nor old sub has a
    // customer_profile_id linkage AND the metadata customerProfileId
    // is missing → customerProfileId stays null. Provisioning failure
    // must skip the rollback (no row to compensate) but still cancel
    // the fresh Stripe sub.
    getBusinessMock.mockResolvedValueOnce({
      id: "biz-1",
      owner_email: "owner@example.com",
      hostinger_vps_id: "1001",
      customer_profile_id: null,
      status: "online"
    });
    getSubscriptionMock.mockResolvedValue({
      id: "sub-row-grace",
      business_id: "biz-1",
      customer_profile_id: null,
      status: "canceled",
      grace_ends_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      wiped_at: null,
      tier: "standard",
      billing_period: "annual"
    });
    orchestrateProvisioningMock.mockRejectedValueOnce(new Error("provision failed"));

    await runResubscribeFromCheckout(
      makeSession({
        customer_details: null,
        customer_email: null,
        metadata: {
          businessId: "biz-1",
          tier: "standard",
          billingPeriod: "annual",
          lifecycleAction: "resubscribe"
        }
      }),
      "evt_resub_no_profile_provision_fail"
    );

    expect(stripeCancelMock).toHaveBeenCalledWith("sub_new", { prorate: false });
    expect(decrementLifetimeSubscriptionCountMock).not.toHaveBeenCalled();
  });

  it("cancels the new Stripe sub when the old sub was wiped between checkout creation and completion", async () => {
    // Grace-state tenant clicks Resubscribe, pays, but the grace-sweep
    // cron wiped the row between session creation and
    // `checkout.session.completed`. The sub is now out-of-grace, so we
    // refuse to resubscribe — but must not leave the fresh Stripe sub
    // auto-renewing.
    getSubscriptionMock.mockResolvedValueOnce({
      id: "sub-row-wiped",
      business_id: "biz-1",
      customer_profile_id: "prof-1",
      status: "canceled",
      grace_ends_at: "2026-01-01T00:00:00.000Z",
      wiped_at: "2026-01-02T00:00:00.000Z"
    });

    await runResubscribeFromCheckout(
      makeSession({
        metadata: {
          businessId: "biz-1",
          tier: "standard",
          billingPeriod: "annual",
          lifecycleAction: "resubscribe"
        }
      }),
      "evt_resub_wiped_race"
    );

    expect(orchestrateProvisioningMock).not.toHaveBeenCalled();
    expect(stripeCancelMock).toHaveBeenCalledWith("sub_new", { prorate: false });
  });

  it("continues resubscribe when profile upsert fails", async () => {
    getSubscriptionMock.mockResolvedValue({
      id: "sub-row-grace",
      business_id: "biz-1",
      customer_profile_id: "prof-1",
      status: "canceled",
      grace_ends_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      wiped_at: null
    });
    upsertCustomerProfileMock.mockRejectedValueOnce(new Error("upsert failed"));

    await runResubscribeFromCheckout(
      makeSession({
        metadata: {
          businessId: "biz-1",
          tier: "standard",
          billingPeriod: "annual",
          lifecycleAction: "resubscribe",
          customerProfileId: "prof-1"
        }
      }),
      "evt_resub_upsert_fail"
    );

    expect(updateSubscriptionIfNotWipedMock).toHaveBeenCalledWith(
      "sub-row-grace",
      expect.objectContaining({ customer_profile_id: "prof-1" })
    );
  });

  it("uses customer_email and object customer/subscription ids for resubscribe metadata", async () => {
    getSubscriptionMock.mockResolvedValue({
      id: "sub-row-grace",
      business_id: "biz-1",
      customer_profile_id: null,
      status: "canceled",
      grace_ends_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      wiped_at: null
    });

    await runResubscribeFromCheckout(
      makeSession({
        customer: { id: "cus_object" } as Stripe.Customer,
        subscription: { id: "sub_object" } as Stripe.Subscription,
        customer_details: null,
        customer_email: "fallback@example.com",
        metadata: {
          businessId: "biz-1",
          tier: "standard",
          billingPeriod: "annual",
          lifecycleAction: "resubscribe"
        }
      }),
      "evt_resub_object_ids"
    );

    expect(upsertCustomerProfileMock).toHaveBeenCalledWith({
      email: "fallback@example.com",
      stripeCustomerId: "cus_object",
      signupIp: null
    });
    expect(updateSubscriptionIfNotWipedMock).toHaveBeenCalledWith(
      "sub-row-grace",
      expect.objectContaining({
        stripe_customer_id: "cus_object",
        stripe_subscription_id: "sub_object"
      })
    );
  });

  it("allows resubscribe without optional checkout ids or customer profile", async () => {
    getBusinessMock.mockResolvedValueOnce({
      id: "biz-1",
      owner_email: "owner@example.com",
      hostinger_vps_id: "1001",
      customer_profile_id: null,
      status: "online"
    });
    getSubscriptionMock.mockResolvedValue({
      id: "sub-row-grace",
      business_id: "biz-1",
      customer_profile_id: null,
      status: "canceled",
      grace_ends_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      wiped_at: null
    });

    await runResubscribeFromCheckout(
      makeSession({
        customer: null,
        subscription: null,
        customer_details: null,
        customer_email: null,
        metadata: {
          businessId: "biz-1",
          tier: "standard",
          billingPeriod: "annual",
          lifecycleAction: "resubscribe"
        }
      }),
      "evt_resub_optional_ids_missing"
    );

    expect(incrementLifetimeSubscriptionCountMock).not.toHaveBeenCalled();
    expect(setBusinessCustomerProfileMock).not.toHaveBeenCalled();
    expect(updateSubscriptionIfNotWipedMock).toHaveBeenCalledWith(
      "sub-row-grace",
      expect.objectContaining({
        stripe_customer_id: null,
        stripe_subscription_id: null,
        customer_profile_id: null
      })
    );
    expect(ensureCommitmentScheduleMock).not.toHaveBeenCalled();
  });

  it("falls back to old sub's tier/billingPeriod when the checkout session metadata omits them (banner flow)", async () => {
    // GraceBanner POSTs `{ mode: "resubscribe" }` with no tier/period —
    // the reactivate route fills in defaults from the grace-state sub
    // row before creating Stripe Checkout. If, for any reason, tier/
    // billingPeriod are absent from the returned session metadata, the
    // orchestrator MUST still be able to resubscribe using the old sub
    // row's plan — otherwise a paid Checkout silently aborts and the
    // customer is charged without being re-provisioned.
    getSubscriptionMock.mockResolvedValue({
      id: "sub-row-grace",
      business_id: "biz-1",
      customer_profile_id: "prof-1",
      tier: "starter",
      billing_period: "monthly",
      status: "canceled",
      grace_ends_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      wiped_at: null
    });

    await runResubscribeFromCheckout(
      makeSession({
        metadata: {
          businessId: "biz-1",
          lifecycleAction: "resubscribe"
        }
      }),
      "evt_resub_banner"
    );

    expect(orchestrateProvisioningMock).toHaveBeenCalledWith(
      expect.objectContaining({ businessId: "biz-1", tier: "starter" })
    );
    expect(updateSubscriptionIfNotWipedMock).toHaveBeenCalledWith(
      "sub-row-grace",
      expect.objectContaining({
        status: "active",
        tier: "starter",
        billing_period: "monthly"
      })
    );
  });

  it("cancels the fresh Stripe sub when neither metadata nor old sub yields a supported tier", async () => {
    // If BOTH sources produce an unsupported tier (e.g. enterprise-only
    // old sub), bail — but cancel the just-minted Stripe subscription
    // so the customer isn't auto-renewed for a service we won't
    // provision. This is the defense-in-depth branch.
    getSubscriptionMock.mockResolvedValue({
      id: "sub-row-grace",
      business_id: "biz-1",
      customer_profile_id: "prof-1",
      tier: "enterprise",
      billing_period: "annual",
      status: "canceled",
      grace_ends_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      wiped_at: null
    });

    await runResubscribeFromCheckout(
      makeSession({
        subscription: "sub_new_unsupported",
        metadata: {
          businessId: "biz-1",
          lifecycleAction: "resubscribe"
        }
      }),
      "evt_resub_unsupported"
    );

    expect(orchestrateProvisioningMock).not.toHaveBeenCalled();
    expect(stripeCancelMock).toHaveBeenCalledWith("sub_new_unsupported", { prorate: false });
  });

  it("bails cleanly when tier is unresolvable AND no fresh Stripe sub id was issued", async () => {
    // Covers the false branch of the `if (stripeSubscriptionId)` guard
    // in the unresolvable-tier path — nothing to cancel, just log + return.
    getSubscriptionMock.mockResolvedValue({
      id: "sub-row-grace",
      business_id: "biz-1",
      customer_profile_id: "prof-1",
      tier: "enterprise",
      billing_period: "annual",
      status: "canceled",
      grace_ends_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      wiped_at: null
    });

    await runResubscribeFromCheckout(
      makeSession({
        subscription: null,
        metadata: {
          businessId: "biz-1",
          lifecycleAction: "resubscribe"
        }
      }),
      "evt_resub_unsupported_no_sub"
    );

    expect(orchestrateProvisioningMock).not.toHaveBeenCalled();
    expect(stripeCancelMock).not.toHaveBeenCalled();
  });

  it("aborts resubscribe cap-reject without Stripe cancel when no fresh sub id was issued", async () => {
    // Covers the false branch of the `if (stripeSubscriptionId)` guard
    // in the resubscribe cap-reject path.
    getSubscriptionMock.mockResolvedValue({
      id: "sub-row-grace",
      business_id: "biz-1",
      customer_profile_id: "prof-1",
      tier: "starter",
      billing_period: "monthly",
      status: "canceled",
      grace_ends_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      wiped_at: null
    });
    incrementLifetimeSubscriptionCountMock.mockRejectedValueOnce(new Error("cap reached"));

    await runResubscribeFromCheckout(
      makeSession({
        subscription: null,
        metadata: {
          businessId: "biz-1",
          tier: "starter",
          billingPeriod: "monthly",
          lifecycleAction: "resubscribe",
          customerProfileId: "prof-1"
        }
      }),
      "evt_resub_cap_no_sub"
    );

    expect(orchestrateProvisioningMock).not.toHaveBeenCalled();
    expect(stripeCancelMock).not.toHaveBeenCalled();
  });

  it("rejects invalid resubscribe metadata without provisioning", async () => {
    await runResubscribeFromCheckout(
      makeSession({
        metadata: {
          businessId: "biz-1",
          tier: "enterprise",
          billingPeriod: "annual",
          lifecycleAction: "resubscribe"
        }
      }),
      "evt_resub_bad_meta"
    );
    await runResubscribeFromCheckout(
      makeSession({
        metadata: {
          tier: "standard",
          billingPeriod: "annual",
          lifecycleAction: "resubscribe"
        }
      }),
      "evt_resub_missing_business"
    );
    await runResubscribeFromCheckout(
      makeSession({
        metadata: {
          businessId: "biz-1",
          billingPeriod: "annual",
          lifecycleAction: "resubscribe"
        }
      }),
      "evt_resub_missing_tier"
    );
    await runResubscribeFromCheckout(
      makeSession({
        metadata: {
          businessId: "biz-1",
          tier: "standard",
          lifecycleAction: "resubscribe"
        }
      }),
      "evt_resub_missing_period"
    );
    expect(orchestrateProvisioningMock).not.toHaveBeenCalled();
  });

  it("aborts resubscribe (fail-closed) when the new VPS host cannot be resolved (no IP) — prevents charging for unreachable workspace", async () => {
    // Same fail-closed reasoning as the restore-throw branch: the
    // customer can't be served from a VM we can't reach, so we must
    // not flip the row to active + bill them. Cancel the new Stripe
    // sub and roll back the lifetime slot.
    getSubscriptionMock.mockResolvedValue({
      id: "sub-row-grace",
      business_id: "biz-1",
      customer_profile_id: "prof-1",
      status: "canceled",
      grace_ends_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      wiped_at: null
    });
    hostingerGetVmMock.mockImplementation(async (id: number) => ({
      id,
      ipv4: []
    }));

    await runResubscribeFromCheckout(
      makeSession({
        metadata: {
          businessId: "biz-1",
          tier: "standard",
          billingPeriod: "annual",
          lifecycleAction: "resubscribe",
          customerProfileId: "prof-1"
        }
      }),
      "evt_resub_no_host"
    );

    expect(restoreBusinessDataMock).not.toHaveBeenCalled();
    expect(updateSubscriptionIfNotWipedMock).not.toHaveBeenCalled();
    expect(stripeCancelMock).toHaveBeenCalledWith("sub_new", { prorate: false });
    expect(decrementLifetimeSubscriptionCountMock).toHaveBeenCalledWith("prof-1");
  });

  it("aborts resubscribe (fail-closed) when the new provisioning id is not numeric — same prevent-silent-empty-workspace contract", async () => {
    getSubscriptionMock.mockResolvedValue({
      id: "sub-row-grace",
      business_id: "biz-1",
      customer_profile_id: "prof-1",
      status: "canceled",
      grace_ends_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      wiped_at: null
    });
    orchestrateProvisioningMock.mockResolvedValueOnce({
      vpsId: "not-a-number",
      tunnelUrl: "https://biz-1.example.com",
      hostingerBillingSubscriptionId: "billing_new"
    });

    await runResubscribeFromCheckout(
      makeSession({
        metadata: {
          businessId: "biz-1",
          tier: "standard",
          billingPeriod: "annual",
          lifecycleAction: "resubscribe",
          customerProfileId: "prof-1"
        }
      }),
      "evt_resub_new_vps_not_numeric"
    );

    expect(restoreBusinessDataMock).not.toHaveBeenCalled();
    expect(updateSubscriptionIfNotWipedMock).not.toHaveBeenCalled();
    expect(stripeCancelMock).toHaveBeenCalledWith("sub_new", { prorate: false });
    expect(decrementLifetimeSubscriptionCountMock).toHaveBeenCalledWith("prof-1");
  });

  it("is idempotent on webhook re-delivery: skips re-execution when an active row is already linked to the new Stripe sub", async () => {
    // Same regression as the changePlan idempotency test, applied to
    // the resubscribe orchestrator. After a successful first run the
    // grace row was flipped to `status: active` with
    // `stripe_subscription_id = stripeSubscriptionId`, so a re-entry
    // would observe `isCanceledInGrace(oldSub) === false` and cancel
    // the LIVE customer-paid Stripe sub via the `not in grace` abort
    // branch.
    getSubscriptionByStripeSubscriptionIdMock.mockResolvedValueOnce({
      id: "sub-row-grace",
      business_id: "biz-1",
      stripe_subscription_id: "sub_new",
      status: "active",
      tier: "standard",
      billing_period: "annual",
      customer_profile_id: "prof-1",
      created_at: "2026-01-01T00:00:00.000Z",
      cancel_at_period_end: false
    });

    await runResubscribeFromCheckout(
      makeSession({
        metadata: {
          businessId: "biz-1",
          tier: "standard",
          billingPeriod: "annual",
          lifecycleAction: "resubscribe",
          customerProfileId: "prof-1"
        }
      }),
      "evt_resub_redelivery"
    );

    // Critical: must NOT cancel the live, customer-paid Stripe sub.
    expect(stripeCancelMock).not.toHaveBeenCalled();
    expect(orchestrateProvisioningMock).not.toHaveBeenCalled();
    expect(restoreBusinessDataMock).not.toHaveBeenCalled();
    expect(updateSubscriptionMock).not.toHaveBeenCalled();
    expect(incrementLifetimeSubscriptionCountMock).not.toHaveBeenCalled();
  });

  it("aborts and rolls back when the grace-sweep wiped the row between orchestrator entry and final write", async () => {
    // Optimistic-concurrency race: the grace-sweep cron wiped the row
    // (stamped wiped_at, deleted backup, stopped VM, canceled
    // Hostinger billing) AFTER this orchestrator's getSubscription
    // read but BEFORE its conditional final write. The conditional
    // update returns null because `wiped_at IS NOT NULL` filtered out
    // the row. We must:
    //   * NOT silently resurrect the row (the data backup is gone, so
    //     the new VPS would come up empty).
    //   * Cancel the brand-new Stripe subscription so the customer
    //     isn't auto-renewed for service we'll never provision.
    //   * Roll back the lifetime counter so the customer doesn't lose
    //     a slot to a no-op resubscribe.
    getSubscriptionMock.mockResolvedValue({
      id: "sub-row-grace",
      business_id: "biz-1",
      stripe_subscription_id: "sub_old_canceled",
      hostinger_billing_subscription_id: "billing_old_canceled",
      customer_profile_id: "prof-1",
      tier: "starter",
      billing_period: "monthly",
      status: "canceled",
      grace_ends_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      wiped_at: null,
      created_at: "2026-01-01T00:00:00.000Z"
    });
    // Simulate the race: the conditional update misses because the
    // grace-sweep cron stamped wiped_at concurrently.
    updateSubscriptionIfNotWipedMock.mockResolvedValueOnce(null);

    await runResubscribeFromCheckout(
      makeSession({
        metadata: {
          businessId: "biz-1",
          tier: "standard",
          billingPeriod: "annual",
          lifecycleAction: "resubscribe",
          customerProfileId: "prof-1"
        }
      }),
      "evt_resub_grace_sweep_race"
    );

    // Conditional write was attempted (and returned null).
    expect(updateSubscriptionIfNotWipedMock).toHaveBeenCalledWith(
      "sub-row-grace",
      expect.objectContaining({ status: "active", wiped_at: null })
    );
    // Brand-new Stripe sub canceled to stop auto-renewal.
    expect(stripeCancelMock).toHaveBeenCalledWith("sub_new", { prorate: false });
    // Lifetime slot rolled back so the customer doesn't lose it.
    expect(decrementLifetimeSubscriptionCountMock).toHaveBeenCalledWith("prof-1");
  });

  it("aborts on grace-sweep race without Stripe cancel or rollback when neither is resolvable", async () => {
    // Branch coverage for the falsy paths inside the wiped-row guard:
    // when the session has no Stripe subscription id and we couldn't
    // resolve a customer_profile_id (no metadata, no oldSub link, no
    // business link, no session email to upsert from), the abort path
    // must short-circuit the inner `if (stripeSubscriptionId)` and
    // `if (customerProfileId)` guards rather than calling Stripe-cancel
    // / decrement on null inputs.
    getBusinessMock.mockResolvedValueOnce({
      id: "biz-1",
      owner_email: "owner@example.com",
      hostinger_vps_id: "1001",
      customer_profile_id: null,
      status: "online"
    });
    getSubscriptionMock.mockResolvedValue({
      id: "sub-row-grace",
      business_id: "biz-1",
      stripe_subscription_id: "sub_old_canceled",
      hostinger_billing_subscription_id: "billing_old_canceled",
      customer_profile_id: null,
      tier: "starter",
      billing_period: "monthly",
      status: "canceled",
      grace_ends_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      wiped_at: null,
      created_at: "2026-01-01T00:00:00.000Z"
    });
    updateSubscriptionIfNotWipedMock.mockResolvedValueOnce(null);

    await runResubscribeFromCheckout(
      makeSession({
        // subscription: null -> stripeSubscriptionId is null.
        subscription: null,
        // No email -> upsertCustomerProfile is skipped, leaving
        // customerProfileId null (no metadata.customerProfileId,
        // no oldSub link, no business link).
        customer_email: null,
        customer_details: { email: null } as NonNullable<Stripe.Checkout.Session["customer_details"]>,
        metadata: {
          businessId: "biz-1",
          tier: "standard",
          billingPeriod: "annual",
          lifecycleAction: "resubscribe"
        }
      }),
      "evt_resub_grace_sweep_race_no_ids"
    );

    expect(updateSubscriptionIfNotWipedMock).toHaveBeenCalledWith(
      "sub-row-grace",
      expect.objectContaining({ status: "active", wiped_at: null })
    );
    // Both guarded calls must NOT fire when their inputs are null.
    expect(stripeCancelMock).not.toHaveBeenCalledWith("sub_new", expect.anything());
    expect(decrementLifetimeSubscriptionCountMock).not.toHaveBeenCalled();
  });
});
