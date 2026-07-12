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
  replaceHostingerVpsCosts: vi.fn(async () => {})
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
  replaceTelnyxCostWindow
} from "@/lib/db/platform-costs";
import { upsertAdminPlatformSetting } from "@/lib/admin/platform-settings";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.TELNYX_API_KEY;
  process.env.HOSTINGER_API_TOKEN = "hostinger-token";
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
});
