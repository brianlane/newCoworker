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
  createSubscriptionMock,
  updateSubscriptionMock
} = vi.hoisted(() => ({
  getSubscriptionMock: vi.fn(),
  createSubscriptionMock: vi.fn(),
  updateSubscriptionMock: vi.fn()
}));

const {
  upsertCustomerProfileMock,
  incrementLifetimeSubscriptionCountMock
} = vi.hoisted(() => ({
  upsertCustomerProfileMock: vi.fn(),
  incrementLifetimeSubscriptionCountMock: vi.fn()
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
    createSubscription: createSubscriptionMock,
    updateSubscription: updateSubscriptionMock,
    stripeSubscriptionPeriodCache: vi.fn().mockReturnValue({})
  };
});

vi.mock("@/lib/db/customer-profiles", () => ({
  upsertCustomerProfile: upsertCustomerProfileMock,
  incrementLifetimeSubscriptionCount: incrementLifetimeSubscriptionCountMock
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
    customer_details: { email: "owner@example.com" } as Stripe.Checkout.Session.CustomerDetails,
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
  upsertCustomerProfileMock.mockResolvedValue("prof-1");
  createSubscriptionMock.mockResolvedValue({});
  updateSubscriptionMock.mockResolvedValue({});
  incrementLifetimeSubscriptionCountMock.mockResolvedValue(undefined);
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

  it("aborts if the business is missing", async () => {
    getBusinessMock.mockResolvedValueOnce(null);
    await runChangePlanFromCheckout(makeSession(), "evt_2");
    expect(orchestrateProvisioningMock).not.toHaveBeenCalled();
    expect(backupBusinessDataMock).not.toHaveBeenCalled();
  });

  it("aborts if previousSubscriptionId does not match the current subscription", async () => {
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
  });

  it("skips session without required metadata", async () => {
    await runChangePlanFromCheckout(
      makeSession({ metadata: { lifecycleAction: "changePlan" } }),
      "evt_4"
    );
    expect(getBusinessMock).not.toHaveBeenCalled();
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

  it("aborts cleanly if new provisioning throws (does not touch old subscription)", async () => {
    orchestrateProvisioningMock.mockRejectedValueOnce(new Error("provision boom"));

    await runChangePlanFromCheckout(makeSession(), "evt_7");

    expect(createSubscriptionMock).not.toHaveBeenCalled();
    expect(stripeCancelMock).not.toHaveBeenCalled();
    expect(hostingerCancelBillingSubscriptionMock).not.toHaveBeenCalled();
    expect(updateSubscriptionMock).not.toHaveBeenCalled();
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
    expect(updateSubscriptionMock).toHaveBeenCalledWith(
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
});
