import { beforeEach, describe, expect, it, vi } from "vitest";

const mockNangoProxy = vi.fn();

vi.mock("@/lib/nango/workspace", () => ({
  nangoProxyForBusiness: (...a: unknown[]) => mockNangoProxy(...a)
}));

import { workspaceProxyForBusiness } from "@/lib/workspace/proxy";

const LINK = { connectionId: "c1", providerConfigKey: "google" };

describe("lib/workspace/proxy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("workspaceProxyForBusiness", () => {
    it("passes the business, link, and config through to the transport unchanged", async () => {
      mockNangoProxy.mockResolvedValue({ status: 200, data: {} });
      const config = {
        endpoint: "/gmail/v1/users/me/messages",
        method: "GET" as const,
        params: { q: "in:inbox" },
        headers: { Prefer: 'outlook.timezone="UTC"' }
      };
      await workspaceProxyForBusiness("biz", LINK, config);
      expect(mockNangoProxy).toHaveBeenCalledWith("biz", LINK, config);
    });

    it("projects the transport response down to status and data", async () => {
      // An AxiosResponse carries headers/config/request too. Callers only ever
      // read status and data, and the narrow shape is what lets a non-axios
      // transport exist, so assert the extras are dropped rather than leaked.
      mockNangoProxy.mockResolvedValue({
        status: 204,
        data: { id: "m1" },
        headers: { "x-goog-quota": "1" },
        config: { url: "/gmail/v1/users/me/messages" },
        request: {}
      });
      const res = await workspaceProxyForBusiness("biz", LINK, { endpoint: "/x" });
      expect(res).toEqual({ status: 204, data: { id: "m1" } });
    });

    it("returns null when the business has no such connection", async () => {
      mockNangoProxy.mockResolvedValue(null);
      await expect(
        workspaceProxyForBusiness("biz", LINK, { endpoint: "/x" })
      ).resolves.toBeNull();
    });

    it("lets a provider rejection propagate instead of returning a status", async () => {
      // Fidelity to the transport: Nango's axios instance sets no
      // validateStatus, so anything outside 2xx rejects. If this seam swallowed
      // that into a returned 4xx it would silently activate caller branches
      // that have never run in production.
      mockNangoProxy.mockRejectedValue(new Error("Request failed with status code 403"));
      await expect(
        workspaceProxyForBusiness("biz", LINK, { endpoint: "/x" })
      ).rejects.toThrow("403");
    });
  });
});
