import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetByNangoIds = vi.fn();
const mockProxy = vi.fn();

vi.mock("@/lib/db/workspace-oauth-connections", () => ({
  getWorkspaceOAuthConnectionByNangoIds: (...a: unknown[]) => mockGetByNangoIds(...a)
}));

vi.mock("@/lib/nango/server", () => ({
  getNangoClient: () => ({
    proxy: mockProxy
  })
}));

import { nangoProxyForBusiness, nangoProxyStatusForBusiness } from "@/lib/nango/workspace";

/**
 * Shaped like what Nango's axios instance actually rejects with. Nango builds
 * it via axios.create() with no validateStatus override, so axios's 2xx-only
 * default applies and every non-2xx provider response arrives as a rejection
 * carrying `response`, never as a resolved value.
 */
function axiosError(status: number, data: unknown = {}) {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    isAxiosError: true,
    response: { status, data }
  });
}

describe("lib/nango/workspace", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("nangoProxyForBusiness", () => {
    it("returns null when link not verified", async () => {
      mockGetByNangoIds.mockResolvedValue(null);
      await expect(
        nangoProxyForBusiness("biz", { connectionId: "c", providerConfigKey: "p" }, { endpoint: "/x" })
      ).resolves.toBeNull();
    });

    it("calls proxy when verified", async () => {
      mockGetByNangoIds.mockResolvedValue({
        connection_id: "c1",
        provider_config_key: "gmail"
      });
      mockProxy.mockResolvedValue({ status: 200, data: {} });
      const res = await nangoProxyForBusiness(
        "biz",
        { connectionId: "c1", providerConfigKey: "gmail" },
        { endpoint: "/gmail/v1/foo", method: "GET" }
      );
      expect(mockProxy).toHaveBeenCalledWith({
        endpoint: "/gmail/v1/foo",
        method: "GET",
        providerConfigKey: "gmail",
        connectionId: "c1"
      });
      expect(res?.status).toBe(200);
    });

    it("throws the provider error through, rather than returning a status", async () => {
      mockGetByNangoIds.mockResolvedValue({ connection_id: "c1", provider_config_key: "gmail" });
      mockProxy.mockRejectedValue(axiosError(403, { error: { message: "Insufficient" } }));
      await expect(
        nangoProxyForBusiness("biz", { connectionId: "c1", providerConfigKey: "gmail" }, { endpoint: "/x" })
      ).rejects.toMatchObject({ response: { status: 403 } });
    });
  });

  describe("nangoProxyStatusForBusiness", () => {
    const link = { connectionId: "c1", providerConfigKey: "gmail" };

    beforeEach(() => {
      mockGetByNangoIds.mockResolvedValue({ connection_id: "c1", provider_config_key: "gmail" });
    });

    it("returns null when the link is not verified", async () => {
      mockGetByNangoIds.mockResolvedValue(null);
      await expect(
        nangoProxyStatusForBusiness("biz", link, { endpoint: "/x" })
      ).resolves.toBeNull();
    });

    it("passes a success response through as status and data", async () => {
      mockProxy.mockResolvedValue({ status: 200, data: { id: "m1" }, headers: {} });
      await expect(nangoProxyStatusForBusiness("biz", link, { endpoint: "/x" })).resolves.toEqual({
        status: 200,
        data: { id: "m1" }
      });
    });

    it("normalizes a rejected provider error into a returned status", async () => {
      mockProxy.mockRejectedValue(axiosError(403, { error: { message: "Insufficient Permission" } }));
      await expect(nangoProxyStatusForBusiness("biz", link, { endpoint: "/x" })).resolves.toEqual({
        status: 403,
        data: { error: { message: "Insufficient Permission" } }
      });
    });

    it("normalizes a rate limit the same way", async () => {
      mockProxy.mockRejectedValue(axiosError(429));
      await expect(nangoProxyStatusForBusiness("biz", link, { endpoint: "/x" })).resolves.toEqual({
        status: 429,
        data: {}
      });
    });

    it("accepts a bare status on the error, for a client that reports it directly", async () => {
      mockProxy.mockRejectedValue(Object.assign(new Error("nope"), { status: 404 }));
      await expect(nangoProxyStatusForBusiness("biz", link, { endpoint: "/x" })).resolves.toEqual({
        status: 404,
        data: undefined
      });
    });

    it("rethrows a transport failure, which carries no response at all", async () => {
      mockProxy.mockRejectedValue(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }));
      await expect(
        nangoProxyStatusForBusiness("biz", link, { endpoint: "/x" })
      ).rejects.toThrow("socket hang up");
    });

    it("rethrows a non-object rejection", async () => {
      mockProxy.mockRejectedValue("weird failure");
      await expect(nangoProxyStatusForBusiness("biz", link, { endpoint: "/x" })).rejects.toBe(
        "weird failure"
      );
    });

    it("rethrows when the status is out of the HTTP range or not finite", async () => {
      mockProxy.mockRejectedValue(Object.assign(new Error("bad"), { status: 42 }));
      await expect(nangoProxyStatusForBusiness("biz", link, { endpoint: "/x" })).rejects.toThrow("bad");

      mockProxy.mockRejectedValue(Object.assign(new Error("nan"), { status: Number.NaN }));
      await expect(nangoProxyStatusForBusiness("biz", link, { endpoint: "/x" })).rejects.toThrow("nan");

      mockProxy.mockRejectedValue(Object.assign(new Error("nested"), { response: { status: "403" } }));
      await expect(
        nangoProxyStatusForBusiness("biz", link, { endpoint: "/x" })
      ).rejects.toThrow("nested");
    });
  });
});
