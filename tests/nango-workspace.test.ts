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

import { nangoProxyForBusiness } from "@/lib/nango/workspace";

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
  });
});
