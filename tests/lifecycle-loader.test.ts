import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  getBusinessMock,
  getSubscriptionMock,
  getCustomerProfileByIdMock,
  getVirtualMachineMock,
  getTelnyxVoiceRouteForBusinessMock,
  getActiveVpsSshKeyForBusinessMock
} = vi.hoisted(() => ({
  getBusinessMock: vi.fn(),
  getSubscriptionMock: vi.fn(),
  getCustomerProfileByIdMock: vi.fn(),
  getVirtualMachineMock: vi.fn(),
  getTelnyxVoiceRouteForBusinessMock: vi.fn(),
  getActiveVpsSshKeyForBusinessMock: vi.fn()
}));

vi.mock("@/lib/db/telnyx-routes", () => ({
  getTelnyxVoiceRouteForBusiness: getTelnyxVoiceRouteForBusinessMock
}));

vi.mock("@/lib/db/vps-ssh-keys", () => ({
  getActiveVpsSshKeyForBusiness: getActiveVpsSshKeyForBusinessMock
}));

vi.mock("@/lib/db/businesses", () => ({
  getBusiness: getBusinessMock
}));

vi.mock("@/lib/db/subscriptions", () => ({
  getSubscription: getSubscriptionMock
}));

vi.mock("@/lib/db/customer-profiles", () => ({
  getCustomerProfileById: getCustomerProfileByIdMock
}));

vi.mock("@/lib/hostinger/client", () => {
  class HostingerClient {
    getVirtualMachine(id: number) {
      return getVirtualMachineMock(id);
    }
  }
  return {
    DEFAULT_HOSTINGER_BASE_URL: "https://hostinger.example",
    HostingerClient
  };
});

vi.mock("@/lib/logger", () => ({
  logger: {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  }
}));

import { loadLifecycleContextForBusiness } from "@/lib/billing/lifecycle-loader";

describe("loadLifecycleContextForBusiness", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.HOSTINGER_API_BASE_URL = "https://hostinger.example";
    process.env.HOSTINGER_API_TOKEN = "token";
    getBusinessMock.mockResolvedValue({
      id: "biz-1",
      owner_email: "owner@example.com",
      owner_name: "Jane Doe",
      customer_profile_id: "prof-business",
      hostinger_vps_id: "42",
      timezone: "America/Phoenix"
    });
    getSubscriptionMock.mockResolvedValue({
      id: "sub-1",
      business_id: "biz-1",
      customer_profile_id: "prof-sub"
    });
    getCustomerProfileByIdMock.mockResolvedValue({ id: "prof-sub" });
    getVirtualMachineMock.mockResolvedValue({ id: 42, ipv4: [{ address: "1.2.3.4" }] });
    getTelnyxVoiceRouteForBusinessMock.mockResolvedValue({
      to_e164: "+16025550100",
      business_id: "biz-1"
    });
  });

  it("loads subscription, profile, VM id, public IP, and the tenant DID", async () => {
    const res = await loadLifecycleContextForBusiness("biz-1", { ownerAuthUserId: "auth-1" });
    expect(res).toEqual({
      ok: true,
      vpsHost: "1.2.3.4",
      context: expect.objectContaining({
        ownerEmail: "owner@example.com",
        ownerName: "Jane Doe",
        businessTimezone: "America/Phoenix",
        ownerAuthUserId: "auth-1",
        profile: { id: "prof-sub" },
        virtualMachineId: 42,
        vpsHost: "1.2.3.4",
        didE164: "+16025550100"
      })
    });
    expect(getCustomerProfileByIdMock).toHaveBeenCalledWith("prof-sub");
  });

  it("leaves didE164 null when no route exists or the lookup fails", async () => {
    getTelnyxVoiceRouteForBusinessMock.mockResolvedValueOnce(null);
    const noRoute = await loadLifecycleContextForBusiness("biz-1");
    expect(noRoute).toEqual({
      ok: true,
      vpsHost: "1.2.3.4",
      context: expect.objectContaining({ didE164: null })
    });

    // A DID-lookup failure must never block the cancel path: the release op
    // is best-effort cleanup, retried by the grace sweep.
    getTelnyxVoiceRouteForBusinessMock.mockRejectedValueOnce(new Error("supabase down"));
    const failed = await loadLifecycleContextForBusiness("biz-1");
    expect(failed).toEqual({
      ok: true,
      vpsHost: "1.2.3.4",
      context: expect.objectContaining({ didE164: null })
    });

    getTelnyxVoiceRouteForBusinessMock.mockRejectedValueOnce("string failure");
    const failedNonError = await loadLifecycleContextForBusiness("biz-1");
    expect(failedNonError).toEqual({
      ok: true,
      vpsHost: "1.2.3.4",
      context: expect.objectContaining({ didE164: null })
    });
  });

  it("returns typed failures for missing business/subscription", async () => {
    getBusinessMock.mockResolvedValueOnce(null);
    await expect(loadLifecycleContextForBusiness("missing")).resolves.toEqual({
      ok: false,
      reason: "business_not_found"
    });
    getBusinessMock.mockResolvedValueOnce({ id: "biz-1" });
    getSubscriptionMock.mockResolvedValueOnce(null);
    await expect(loadLifecycleContextForBusiness("biz-1")).resolves.toEqual({
      ok: false,
      reason: "subscription_not_found"
    });
  });

  it("falls back to business profile and tolerates nonnumeric/missing VM details", async () => {
    getSubscriptionMock.mockResolvedValueOnce({
      id: "sub-1",
      business_id: "biz-1",
      customer_profile_id: null
    });
    getBusinessMock.mockResolvedValueOnce({
      id: "biz-1",
      owner_email: "owner@example.com",
      customer_profile_id: "prof-business",
      hostinger_vps_id: "not-a-number"
    });
    getCustomerProfileByIdMock.mockResolvedValueOnce({ id: "prof-business" });
    const res = await loadLifecycleContextForBusiness("biz-1");
    expect(res).toEqual({
      ok: true,
      vpsHost: null,
      context: expect.objectContaining({
        profile: { id: "prof-business" },
        ownerName: null,
        virtualMachineId: null,
        vpsHost: null
      })
    });
  });

  it("continues without vpsHost when Hostinger lookup fails or has no address", async () => {
    getVirtualMachineMock.mockRejectedValueOnce(new Error("hostinger down"));
    const failed = await loadLifecycleContextForBusiness("biz-1");
    expect(failed).toEqual({
      ok: true,
      vpsHost: null,
      context: expect.objectContaining({ virtualMachineId: 42, vpsHost: null })
    });

    getVirtualMachineMock.mockResolvedValueOnce({ id: 42, ipv4: [] });
    const noIp = await loadLifecycleContextForBusiness("biz-1");
    expect(noIp).toEqual({
      ok: true,
      vpsHost: null,
      context: expect.objectContaining({ virtualMachineId: 42, vpsHost: null })
    });
  });

  it("byos: skips the Hostinger lookup entirely and reads the host from the active SSH key row", async () => {
    getBusinessMock.mockResolvedValueOnce({
      id: "biz-1",
      owner_email: "owner@example.com",
      customer_profile_id: null,
      // Defensive: even a numeric-looking box id must not be treated as a
      // Hostinger VM once the provider says otherwise.
      hostinger_vps_id: "42",
      vps_provider: "byos"
    });
    getActiveVpsSshKeyForBusinessMock.mockResolvedValueOnce({ host: "203.0.113.7" });

    const res = await loadLifecycleContextForBusiness("biz-1");
    expect(getVirtualMachineMock).not.toHaveBeenCalled();
    expect(res).toEqual({
      ok: true,
      vpsHost: "203.0.113.7",
      context: expect.objectContaining({
        virtualMachineId: null,
        vpsProvider: "byos",
        vpsHost: "203.0.113.7"
      })
    });
  });

  it("byos: tolerates a missing key row, a host-less row, and lookup failures (Error and non-Error)", async () => {
    const byosBusiness = {
      id: "biz-1",
      owner_email: "owner@example.com",
      customer_profile_id: null,
      hostinger_vps_id: "byos-biz-1",
      vps_provider: "ovh"
    };

    getBusinessMock.mockResolvedValueOnce(byosBusiness);
    getActiveVpsSshKeyForBusinessMock.mockResolvedValueOnce(null);
    const missingRow = await loadLifecycleContextForBusiness("biz-1");
    expect(missingRow).toEqual({
      ok: true,
      vpsHost: null,
      context: expect.objectContaining({ vpsHost: null, vpsProvider: "ovh" })
    });

    getBusinessMock.mockResolvedValueOnce(byosBusiness);
    getActiveVpsSshKeyForBusinessMock.mockResolvedValueOnce({ host: null });
    const hostlessRow = await loadLifecycleContextForBusiness("biz-1");
    expect(hostlessRow).toEqual({
      ok: true,
      vpsHost: null,
      context: expect.objectContaining({ vpsHost: null })
    });

    getBusinessMock.mockResolvedValueOnce(byosBusiness);
    getActiveVpsSshKeyForBusinessMock.mockRejectedValueOnce(new Error("supabase down"));
    const failed = await loadLifecycleContextForBusiness("biz-1");
    expect(failed).toEqual({
      ok: true,
      vpsHost: null,
      context: expect.objectContaining({ vpsHost: null })
    });

    getBusinessMock.mockResolvedValueOnce(byosBusiness);
    getActiveVpsSshKeyForBusinessMock.mockRejectedValueOnce("string failure");
    const failedNonError = await loadLifecycleContextForBusiness("biz-1");
    expect(failedNonError).toEqual({
      ok: true,
      vpsHost: null,
      context: expect.objectContaining({ vpsHost: null })
    });
  });

  it("uses subscription override, defaults env values, and handles non-Error Hostinger failures", async () => {
    delete process.env.HOSTINGER_API_BASE_URL;
    delete process.env.HOSTINGER_API_TOKEN;
    getBusinessMock.mockResolvedValueOnce({
      id: "biz-1",
      owner_email: "owner@example.com",
      customer_profile_id: null,
      hostinger_vps_id: "42"
    });
    getVirtualMachineMock.mockRejectedValueOnce("hostinger string failure");

    const override = {
      id: "sub-override",
      business_id: "biz-1",
      customer_profile_id: null
    };
    const res = await loadLifecycleContextForBusiness("biz-1", {
      subscription: override as never
    });

    expect(getSubscriptionMock).not.toHaveBeenCalled();
    expect(getCustomerProfileByIdMock).not.toHaveBeenCalled();
    expect(res).toEqual({
      ok: true,
      vpsHost: null,
      context: expect.objectContaining({
        subscription: override,
        profile: null,
        virtualMachineId: 42,
        vpsHost: null
      })
    });
  });
});
