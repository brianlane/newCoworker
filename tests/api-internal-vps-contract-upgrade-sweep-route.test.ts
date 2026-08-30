import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/cron-auth", () => ({
  assertCronAuth: vi.fn()
}));
vi.mock("@/lib/db/businesses", () => ({
  listBusinesses: vi.fn(),
  getBusiness: vi.fn()
}));
vi.mock("@/lib/db/subscriptions", () => ({
  listBusinessIdsWithLiveSubscription: vi.fn(),
  listSubscriptionsByBusinessIds: vi.fn(),
  getSubscription: vi.fn(),
  updateSubscription: vi.fn()
}));
vi.mock("@/lib/db/customer-profiles", () => ({
  listCustomerProfilesByIds: vi.fn()
}));
vi.mock("@/lib/db/vps-inventory", () => ({
  listVpsInventory: vi.fn(),
  releaseVpsToPool: vi.fn(),
  markVpsNeverRenew: vi.fn()
}));
vi.mock("@/lib/db/vps-migration-locks", () => ({
  hasActiveVpsMigrationLock: vi.fn(),
  tryClaimVpsMigration: vi.fn(),
  releaseVpsMigrationLock: vi.fn()
}));
vi.mock("@/lib/db/vps-ssh-keys", () => ({
  getActiveVpsSshKey: vi.fn()
}));
vi.mock("@/lib/provisioning/jobs", () => ({
  getLastEnqueuedAtForPurpose: vi.fn()
}));
vi.mock("@/lib/hostinger/data-migration", () => ({
  backupBusinessData: vi.fn(),
  restoreBusinessData: vi.fn()
}));
vi.mock("@/lib/hostinger/client", () => ({
  DEFAULT_HOSTINGER_BASE_URL: "https://developers.hostinger.com",
  HostingerClient: class {
    listCatalog = vi.fn().mockResolvedValue([]);
    listBillingSubscriptions = vi.fn().mockResolvedValue([]);
    getVirtualMachine = vi.fn();
    createSnapshot = vi.fn();
    stopVirtualMachine = vi.fn();
    disableBillingAutoRenewal = vi.fn();
  }
}));
vi.mock("@/lib/provisioning/orchestrate", () => ({
  orchestrateProvisioning: vi.fn()
}));
vi.mock("@/lib/vps/contract-upgrade-sweep", () => ({
  runContractUpgradeSweep: vi.fn()
}));
vi.mock("@/lib/email/ops-notify", () => ({
  sendOpsHardwareMigrationEmail: vi.fn()
}));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}));

import { POST } from "@/app/api/internal/vps-contract-upgrade-sweep/route";
import { assertCronAuth } from "@/lib/cron-auth";
import { runContractUpgradeSweep } from "@/lib/vps/contract-upgrade-sweep";
import { getLastEnqueuedAtForPurpose } from "@/lib/provisioning/jobs";

function makeRequest(): Request {
  return new Request("http://localhost/api/internal/vps-contract-upgrade-sweep", {
    method: "POST",
    headers: { Authorization: "Bearer cron-secret" }
  });
}

describe("api/internal/vps-contract-upgrade-sweep route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(assertCronAuth).mockReturnValue(true);
    vi.mocked(runContractUpgradeSweep).mockResolvedValue({
      checked: 4,
      alreadyCovered: 3,
      migrated: 1,
      findings: [], failures: []
    });
  });

  it("403s without a valid cron bearer", async () => {
    vi.mocked(assertCronAuth).mockReturnValue(false);
    const res = await POST(makeRequest());
    expect(res.status).toBe(403);
    expect(runContractUpgradeSweep).not.toHaveBeenCalled();
  });

  it("runs the sweep and returns the summary", async () => {
    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toEqual({ checked: 4, alreadyCovered: 3, migrated: 1, findings: [], failures: [] });
    expect(runContractUpgradeSweep).toHaveBeenCalledOnce();
  });

  /**
   * The cooldown must read THIS sweep's own purchases. Wiring it to the
   * term-renewal purpose would make a renewal purchase suppress a contract
   * upgrade, parking a tenant whose box is genuinely about to lapse.
   */
  it("cools down on contract_upgrade purchases only", async () => {
    await POST(makeRequest());
    const deps = vi.mocked(runContractUpgradeSweep).mock.calls[0][0];
    await deps.getLastContractUpgradePurchaseAt("biz-1");
    expect(getLastEnqueuedAtForPurpose).toHaveBeenCalledWith("biz-1", "contract_upgrade");
  });

  it("surfaces unexpected failures via handleRouteError", async () => {
    vi.mocked(runContractUpgradeSweep).mockRejectedValue(new Error("hostinger down"));
    const res = await POST(makeRequest());
    expect(res.status).toBe(500);
  });
});
