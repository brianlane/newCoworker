import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  getBusinessMock,
  getSubscriptionMock,
  getCustomerProfileByIdMock,
  getVirtualMachineMock
} = vi.hoisted(() => ({
  getBusinessMock: vi.fn(),
  getSubscriptionMock: vi.fn(),
  getCustomerProfileByIdMock: vi.fn(),
  getVirtualMachineMock: vi.fn()
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
      customer_profile_id: "prof-business",
      hostinger_vps_id: "42"
    });
    getSubscriptionMock.mockResolvedValue({
      id: "sub-1",
      business_id: "biz-1",
      customer_profile_id: "prof-sub"
    });
    getCustomerProfileByIdMock.mockResolvedValue({ id: "prof-sub" });
    getVirtualMachineMock.mockResolvedValue({ id: 42, ipv4: [{ address: "1.2.3.4" }] });
  });

  it("loads subscription, profile, VM id and public IP", async () => {
    const res = await loadLifecycleContextForBusiness("biz-1", { ownerAuthUserId: "auth-1" });
    expect(res).toEqual({
      ok: true,
      vpsHost: "1.2.3.4",
      context: expect.objectContaining({
        ownerEmail: "owner@example.com",
        ownerAuthUserId: "auth-1",
        profile: { id: "prof-sub" },
        virtualMachineId: 42,
        vpsHost: "1.2.3.4"
      })
    });
    expect(getCustomerProfileByIdMock).toHaveBeenCalledWith("prof-sub");
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
