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
  listVpsInventory: vi.fn().mockResolvedValue([]),
  refreshVpsInventoryExpiresAt: vi.fn().mockResolvedValue(0)
}));
vi.mock("@/lib/hostinger/client", () => ({
  DEFAULT_HOSTINGER_BASE_URL: "https://developers.hostinger.com",
  HostingerClient: class {
    getVirtualMachine = vi.fn();
    listBillingSubscriptions = vi.fn().mockResolvedValue([]);
    enableBillingAutoRenewal = vi.fn();
  }
}));
vi.mock("@/lib/vps/billing-posture", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/vps/billing-posture")>()),
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
import { refreshVpsInventoryExpiresAt } from "@/lib/db/vps-inventory";

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
    vi.mocked(refreshVpsInventoryExpiresAt).mockResolvedValue(0);
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
    expect(json.data).toEqual({
      checkedTenantVms: 2,
      checkedPoolBoxes: 1,
      findings: [],
      expiresRefreshed: 0
    });
    expect(refreshVpsInventoryExpiresAt).toHaveBeenCalled();
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

  // The pool reaper doing its ordinary job is not news: a box nobody was using
  // reached the end of a period it was already paid through, and the check
  // retired its row. Mailing that trains the operator to skim the digest that
  // matters. KIN's old box 1864812 was about to generate exactly this, Aug 2026.
  it("stays quiet when the only finding is a pool box the reaper already retired", async () => {
    vi.mocked(checkVpsBillingPosture).mockResolvedValue({
      checkedTenantVms: 5,
      checkedPoolBoxes: 1,
      findings: [
        {
          kind: "pool_box_lapsed_retired",
          vmId: 1864812,
          businessId: null,
          businessName: null,
          hostingerBillingSubscriptionId: "AzysZ0VQl6mkfw7i",
          expiresAt: "2026-08-29T11:01:01Z",
          autoHealed: true,
          detail: "pooled box lapsed; its vps_inventory row was retired"
        }
      ]
    } as never);

    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    expect(sendOpsBillingPostureEmail).not.toHaveBeenCalled();
    // Suppressed from mail, NOT from the record: the route still reports it.
    const json = await res.json();
    expect(json.data.findings).toHaveLength(1);
  });

  // Same kind, but the retire FAILED, so the row still reads `available` and
  // overstates the pool. That is why the gate keys on autoHealed, not on kind.
  it("emails when a lapsed pool box could NOT be retired", async () => {
    vi.mocked(checkVpsBillingPosture).mockResolvedValue({
      checkedTenantVms: 5,
      checkedPoolBoxes: 1,
      findings: [
        {
          kind: "pool_box_lapsed_retired",
          vmId: 1864812,
          businessId: null,
          businessName: null,
          hostingerBillingSubscriptionId: "AzysZ0VQl6mkfw7i",
          expiresAt: "2026-08-29T11:01:01Z",
          autoHealed: false,
          detail: "retiring its vps_inventory row FAILED, retire it by hand"
        }
      ]
    } as never);

    const res = await POST(makeRequest());
    expect(sendOpsBillingPostureEmail).toHaveBeenCalledTimes(1);
  });

  it("includes the routine reaped boxes in the email when something else earns it", async () => {
    const findings = [
      {
        kind: "pool_box_lapsed_retired",
        vmId: 1864812,
        businessId: null,
        businessName: null,
        hostingerBillingSubscriptionId: "AzysZ0VQl6mkfw7i",
        expiresAt: "2026-08-29T11:01:01Z",
        autoHealed: true,
        detail: "pooled box lapsed; its vps_inventory row was retired"
      },
      {
        kind: "untracked_vm",
        vmId: 1936826,
        businessId: null,
        businessName: null,
        hostingerBillingSubscriptionId: "Azyp34VTaWZDIBG8",
        expiresAt: null,
        autoHealed: false,
        detail: "absent from vps_inventory and no business points at it"
      }
    ];
    vi.mocked(checkVpsBillingPosture).mockResolvedValue({
      checkedTenantVms: 5,
      checkedPoolBoxes: 1,
      findings
    } as never);

    await POST(makeRequest());
    // The whole list, not just the earning finding: a reaped box is useful
    // context next to a real one, it just is not a reason to write alone.
    expect(sendOpsBillingPostureEmail).toHaveBeenCalledWith({
      findings,
      checkedTenantVms: 5,
      checkedPoolBoxes: 1
    });
  });

  it("continues the posture check when expires_at refresh fails", async () => {
    vi.mocked(refreshVpsInventoryExpiresAt).mockRejectedValue(new Error("db down"));
    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    expect(checkVpsBillingPosture).toHaveBeenCalled();
  });

  it("surfaces unexpected failures via handleRouteError", async () => {
    vi.mocked(checkVpsBillingPosture).mockRejectedValue(new Error("hostinger down"));
    const res = await POST(makeRequest());
    expect(res.status).toBe(500);
  });
});
