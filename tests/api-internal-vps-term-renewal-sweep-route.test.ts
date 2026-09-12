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
vi.mock("@/lib/vps/term-renewal-sweep", () => ({
  runTermRenewalSweep: vi.fn()
}));
vi.mock("@/lib/email/ops-notify", () => ({
  sendOpsHardwareMigrationEmail: vi.fn()
}));
vi.mock("@/lib/db/system-logs", () => ({
  recordFailure: vi.fn(async () => "warn")
}));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}));

import { POST } from "@/app/api/internal/vps-term-renewal-sweep/route";
import { assertCronAuth } from "@/lib/cron-auth";
import { runTermRenewalSweep } from "@/lib/vps/term-renewal-sweep";
import { recordFailure } from "@/lib/db/system-logs";
import { hostingerListFlakeLogEvent } from "@/lib/vps/hostinger-list-load";

function makeRequest(): Request {
  return new Request("http://localhost/api/internal/vps-term-renewal-sweep", {
    method: "POST",
    headers: { Authorization: "Bearer cron-secret" }
  });
}

describe("api/internal/vps-term-renewal-sweep route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(assertCronAuth).mockReturnValue(true);
    vi.mocked(runTermRenewalSweep).mockResolvedValue({
      checked: 3,
      skippedEconomics: 2,
      migrated: 0,
      findings: [], failures: []
    });
  });

  it("403s without a valid cron bearer", async () => {
    vi.mocked(assertCronAuth).mockReturnValue(false);
    const res = await POST(makeRequest());
    expect(res.status).toBe(403);
    expect(runTermRenewalSweep).not.toHaveBeenCalled();
  });

  it("runs the sweep and returns the summary", async () => {
    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toEqual({ checked: 3, skippedEconomics: 2, migrated: 0, findings: [], failures: [] });
    expect(runTermRenewalSweep).toHaveBeenCalledOnce();
  });

  it("surfaces unexpected failures via handleRouteError", async () => {
    vi.mocked(runTermRenewalSweep).mockRejectedValue(new Error("hostinger down"));
    const res = await POST(makeRequest());
    expect(res.status).toBe(500);
  });

  it("holds a first-day Hostinger list flake off failures[]", async () => {
    vi.mocked(runTermRenewalSweep).mockResolvedValue({
      checked: 0,
      skippedEconomics: 0,
      migrated: 0,
      findings: [],
      failures: [],
      hostingerUnavailable: "Hostinger API /x timed out after 30000ms"
    });
    vi.mocked(recordFailure).mockResolvedValue("warn");
    const res = await POST(makeRequest());
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.data.failures).toEqual([]);
    expect(recordFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        event: hostingerListFlakeLogEvent("vps-term-renewal-sweep"),
        source: "vps-term-renewal-sweep"
      }),
      expect.objectContaining({ windowMinutes: 48 * 60 })
    );
  });

  it("copies a repeat Hostinger list flake into failures[]", async () => {
    vi.mocked(runTermRenewalSweep).mockResolvedValue({
      checked: 0,
      skippedEconomics: 0,
      migrated: 0,
      findings: [],
      failures: [],
      hostingerUnavailable: "Hostinger API /x timed out after 30000ms"
    });
    vi.mocked(recordFailure).mockResolvedValue("error");
    const res = await POST(makeRequest());
    const json = await res.json();
    expect(json.data.failures).toEqual([
      "Hostinger list failed: Hostinger API /x timed out after 30000ms"
    ]);
  });
});
