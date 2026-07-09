import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/cron-auth", () => ({
  assertCronAuth: vi.fn()
}));
vi.mock("@/lib/db/businesses", () => ({
  listBusinesses: vi.fn()
}));
vi.mock("@/lib/db/subscriptions", () => ({
  listBusinessIdsWithLiveSubscription: vi.fn()
}));
vi.mock("@/lib/db/vps-inventory", () => ({
  listVpsInventory: vi.fn()
}));
vi.mock("@/lib/hostinger/client", () => ({
  DEFAULT_HOSTINGER_BASE_URL: "https://developers.hostinger.com",
  HostingerClient: class {
    getVirtualMachine = vi.fn();
    listBillingSubscriptions = vi.fn().mockResolvedValue([]);
    enableBillingAutoRenewal = vi.fn();
  }
}));
vi.mock("@/lib/vps/billing-posture", () => ({
  checkVpsBillingPosture: vi.fn()
}));
vi.mock("@/lib/email/ops-notify", () => ({
  sendOpsBillingPostureEmail: vi.fn()
}));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}));

import { POST } from "@/app/api/internal/vps-billing-posture/route";
import { assertCronAuth } from "@/lib/cron-auth";
import { checkVpsBillingPosture } from "@/lib/vps/billing-posture";
import { sendOpsBillingPostureEmail } from "@/lib/email/ops-notify";

function makeRequest(): Request {
  return new Request("http://localhost/api/internal/vps-billing-posture", {
    method: "POST",
    headers: { Authorization: "Bearer cron-secret" }
  });
}

describe("api/internal/vps-billing-posture route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(assertCronAuth).mockReturnValue(true);
    vi.mocked(checkVpsBillingPosture).mockResolvedValue({
      checkedTenantVms: 2,
      checkedPoolBoxes: 1,
      findings: []
    });
  });

  it("403s without a valid cron bearer", async () => {
    vi.mocked(assertCronAuth).mockReturnValue(false);
    const res = await POST(makeRequest());
    expect(res.status).toBe(403);
    expect(checkVpsBillingPosture).not.toHaveBeenCalled();
  });

  it("runs the check and skips the ops email when the fleet is healthy", async () => {
    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toEqual({ checkedTenantVms: 2, checkedPoolBoxes: 1, findings: [] });
    expect(sendOpsBillingPostureEmail).not.toHaveBeenCalled();
  });

  it("emails ops when findings exist", async () => {
    const findings = [
      {
        kind: "tenant_auto_renew_off",
        vmId: 1800985,
        businessId: "biz-1",
        businessName: "Residency Pilot",
        hostingerBillingSubscriptionId: "hsub-1",
        expiresAt: "2026-08-02T00:00:00Z",
        autoHealed: true,
        detail: "auto-renew re-enabled by posture check"
      }
    ];
    vi.mocked(checkVpsBillingPosture).mockResolvedValue({
      checkedTenantVms: 3,
      checkedPoolBoxes: 0,
      findings
    } as never);

    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    expect(sendOpsBillingPostureEmail).toHaveBeenCalledWith({
      findings,
      checkedTenantVms: 3,
      checkedPoolBoxes: 0
    });
  });

  it("surfaces unexpected failures via handleRouteError", async () => {
    vi.mocked(checkVpsBillingPosture).mockRejectedValue(new Error("hostinger down"));
    const res = await POST(makeRequest());
    expect(res.status).toBe(500);
  });
});
