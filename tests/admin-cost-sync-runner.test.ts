import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/hostinger/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/hostinger/client")>();
  return {
    ...actual,
    HostingerClient: vi.fn().mockImplementation(function mockHostingerClient() {
      return {
        listBillingSubscriptions: vi.fn(async () => [
          { id: "sub-1", status: "active", name: "KVM 2" }
        ]),
        listVirtualMachines: vi.fn(async () => [
          {
            id: 1800980,
            subscription_id: "sub-1",
            hostname: "srv1800980.hstgr.cloud",
            state: "running"
          }
        ])
      };
    })
  };
});
vi.mock("@/lib/db/platform-costs", () => ({
  listTenantDids: vi.fn(async () => []),
  listBusinessVpsAssignments: vi.fn(async () => [{ businessId: "biz-1", vmId: 1800980 }]),
  replaceTelnyxCostWindow: vi.fn(async () => {}),
  replaceHostingerVpsCosts: vi.fn(async () => {}),
  listStripeCustomerBusinessIds: vi.fn(async () => [
    { businessId: "biz-1", stripeCustomerId: "cus_1" }
  ]),
  replaceStripeFeeWindow: vi.fn(async () => {})
}));
vi.mock("@/lib/stripe/client", () => ({
  getStripe: vi.fn(() => ({
    balanceTransactions: {
      list: vi.fn(() => ({
        async *[Symbol.asyncIterator]() {
          yield {
            type: "charge",
            amount: 28_399,
            fee: 1280,
            net: 27_119,
            created: Math.floor(Date.parse("2026-07-05T00:00:00Z") / 1000),
            source: { customer: "cus_1" }
          };
        }
      }))
    }
  }))
}));
vi.mock("@/lib/admin/platform-settings", () => ({
  upsertAdminPlatformSetting: vi.fn(async () => {})
}));

import { runProductionPlatformCostSync } from "@/lib/admin/cost-sync-runner";
import { PLATFORM_COST_SYNC_STATUS_KEY } from "@/lib/admin/cost-sync";
import { HostingerClient } from "@/lib/hostinger/client";
import {
  listTenantDids,
  replaceHostingerVpsCosts,
  replaceStripeFeeWindow,
  replaceTelnyxCostWindow
} from "@/lib/db/platform-costs";
import { upsertAdminPlatformSetting } from "@/lib/admin/platform-settings";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.TELNYX_API_KEY;
  process.env.HOSTINGER_API_TOKEN = "hostinger-token";
  process.env.STRIPE_SECRET_KEY = "sk_test";
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("runProductionPlatformCostSync", () => {
  it("wires the Hostinger client + db accessors and records the status", async () => {
    const status = await runProductionPlatformCostSync();
    expect(HostingerClient).toHaveBeenCalledWith(
      expect.objectContaining({ token: "hostinger-token" })
    );
    // No TELNYX_API_KEY in the test env → the Telnyx side is skipped.
    expect(status.telnyxError).toContain("TELNYX_API_KEY not set");
    expect(replaceTelnyxCostWindow).not.toHaveBeenCalled();
    // The Hostinger side ran end-to-end through the mocked client + accessors.
    expect(status.hostingerRows).toBe(1);
    expect(replaceHostingerVpsCosts).toHaveBeenCalledWith([
      expect.objectContaining({
        subscription_id: "sub-1",
        vm_id: 1800980,
        assigned_business_id: "biz-1"
      })
    ]);
    expect(upsertAdminPlatformSetting).toHaveBeenCalledWith(
      PLATFORM_COST_SYNC_STATUS_KEY,
      status
    );
  });

  it("defaults a missing Hostinger token to an empty string", async () => {
    delete process.env.HOSTINGER_API_TOKEN;
    await runProductionPlatformCostSync();
    expect(HostingerClient).toHaveBeenCalledWith(expect.objectContaining({ token: "" }));
  });

  it("passes the Telnyx key and range through", async () => {
    process.env.TELNYX_API_KEY = "  telnyx-key  ";
    // The key is present but the DID read fails, proving the Telnyx branch
    // engaged without needing a live HTTP mock.
    vi.mocked(listTenantDids).mockRejectedValueOnce(new Error("did read failed"));
    const status = await runProductionPlatformCostSync({ telnyxRange: "last_90_days" });
    expect(status.telnyxRange).toBe("last_90_days");
    expect(status.telnyxError).toBe("did read failed");
  });

  /**
   * The Stripe side pulls balance transactions, attributes them through the
   * customer map, and writes the fee window, the read that makes the
   * margin engine's fee rate observable rather than assumed.
   */
  it("pulls Stripe balance transactions and writes the attributed fee window", async () => {
    const status = await runProductionPlatformCostSync();
    expect(status.stripeError).toBeNull();
    expect(status.stripeRows).toBe(1);
    expect(replaceStripeFeeWindow).toHaveBeenCalledWith(
      expect.stringMatching(/^\d{4}-\d{2}-01$/),
      [
        expect.objectContaining({
          business_id: "biz-1",
          gross_cents: 28_399,
          fee_cents: 1280,
          net_cents: 27_119,
          charge_count: 1
        })
      ]
    );
  });

  it("skips the Stripe side when no secret key is configured", async () => {
    delete process.env.STRIPE_SECRET_KEY;
    const status = await runProductionPlatformCostSync();
    expect(status.stripeError).toContain("STRIPE_SECRET_KEY not set");
    expect(replaceStripeFeeWindow).not.toHaveBeenCalled();
  });
});
