import { beforeEach, describe, expect, it, vi } from "vitest";

const mockNangoProxy = vi.fn();
const mockNangoProxyStatus = vi.fn();
const mockGetByNangoIds = vi.fn();

vi.mock("@/lib/nango/workspace", () => ({
  nangoProxyForBusiness: (...a: unknown[]) => mockNangoProxy(...a),
  nangoProxyStatusForBusiness: (...a: unknown[]) => mockNangoProxyStatus(...a)
}));

// The resolver reads the row to learn which transport owns it. Every case in
// this file is a Nango row, so the direct arm falls straight through.
vi.mock("@/lib/db/workspace-oauth-connections", () => ({
  getWorkspaceOAuthConnectionByNangoIds: (...a: unknown[]) => mockGetByNangoIds(...a)
}));

import { workspaceProxyForBusiness, workspaceProxyStatusForBusiness } from "@/lib/workspace/proxy";

const LINK = { connectionId: "c1", providerConfigKey: "google" };

describe("lib/workspace/proxy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetByNangoIds.mockResolvedValue({
      id: "row-1",
      business_id: "biz",
      provider_config_key: "google",
      connection_id: "c1",
      metadata: {},
      transport: "nango",
      is_active: true,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z"
    });
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

  describe("workspaceProxyStatusForBusiness", () => {
    it("passes through to the status-normalizing transport", async () => {
      mockNangoProxyStatus.mockResolvedValue({ status: 200, data: { ok: true } });
      const config = { endpoint: "/gmail/v1/users/me/labels", method: "GET" as const };
      const res = await workspaceProxyStatusForBusiness("biz", LINK, config);
      expect(mockNangoProxyStatus).toHaveBeenCalledWith("biz", LINK, config);
      expect(res).toEqual({ status: 200, data: { ok: true } });
      // The throwing arm must not be involved: routing a status-branching caller
      // through it is what made organize.ts's error handling dead code.
      expect(mockNangoProxy).not.toHaveBeenCalled();
    });

    it("surfaces a provider error as a status rather than a throw", async () => {
      mockNangoProxyStatus.mockResolvedValue({ status: 403, data: { error: "denied" } });
      await expect(
        workspaceProxyStatusForBusiness("biz", LINK, { endpoint: "/x" })
      ).resolves.toEqual({ status: 403, data: { error: "denied" } });
    });

    it("returns null when the business has no such connection", async () => {
      mockNangoProxyStatus.mockResolvedValue(null);
      await expect(
        workspaceProxyStatusForBusiness("biz", LINK, { endpoint: "/x" })
      ).resolves.toBeNull();
    });

    it("still throws a transport failure that carries no status", async () => {
      mockNangoProxyStatus.mockRejectedValue(new Error("socket hang up"));
      await expect(
        workspaceProxyStatusForBusiness("biz", LINK, { endpoint: "/x" })
      ).rejects.toThrow("socket hang up");
    });
  });
});
