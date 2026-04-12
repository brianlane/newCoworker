import { beforeEach, describe, expect, it, vi } from "vitest";

const mockList = vi.fn();
const mockGetByNangoIds = vi.fn();
const mockGetToken = vi.fn();
const mockProxy = vi.fn();

vi.mock("@/lib/db/workspace-oauth-connections", () => ({
  listWorkspaceOAuthConnections: (...a: unknown[]) => mockList(...a),
  getWorkspaceOAuthConnectionByNangoIds: (...a: unknown[]) => mockGetByNangoIds(...a)
}));

vi.mock("@/lib/nango/server", () => ({
  getNangoClient: () => ({
    getToken: mockGetToken,
    proxy: mockProxy
  })
}));

import {
  getNangoAccessTokenForBusiness,
  listNangoWorkspaceLinks,
  nangoProxyForBusiness
} from "@/lib/nango/workspace";

describe("lib/nango/workspace", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("listNangoWorkspaceLinks", () => {
    it("maps DB rows to links", async () => {
      mockList.mockResolvedValue([
        {
          id: "1",
          business_id: "biz",
          provider_config_key: "gmail",
          connection_id: "c1",
          metadata: {},
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z"
        }
      ]);
      await expect(listNangoWorkspaceLinks("biz")).resolves.toEqual([
        { connectionId: "c1", providerConfigKey: "gmail" }
      ]);
    });
  });

  describe("getNangoAccessTokenForBusiness", () => {
    it("returns null when link not verified", async () => {
      mockGetByNangoIds.mockResolvedValue(null);
      await expect(
        getNangoAccessTokenForBusiness("biz", { connectionId: "c", providerConfigKey: "p" })
      ).resolves.toBeNull();
    });

    it("returns string token when verified", async () => {
      mockGetByNangoIds.mockResolvedValue({
        connection_id: "c1",
        provider_config_key: "gmail"
      });
      mockGetToken.mockResolvedValue("tok");
      await expect(
        getNangoAccessTokenForBusiness("biz", { connectionId: "c1", providerConfigKey: "gmail" })
      ).resolves.toBe("tok");
    });

    it("returns null when getToken yields non-string", async () => {
      mockGetByNangoIds.mockResolvedValue({
        connection_id: "c1",
        provider_config_key: "gmail"
      });
      mockGetToken.mockResolvedValue({ oAuthToken: "x" });
      await expect(
        getNangoAccessTokenForBusiness("biz", { connectionId: "c1", providerConfigKey: "gmail" })
      ).resolves.toBeNull();
    });
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
