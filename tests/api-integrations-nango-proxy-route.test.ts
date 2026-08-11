import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  getAuthUser: vi.fn(),
  requireBusinessRole: vi.fn()
}));

vi.mock("@/lib/workspace/proxy", () => ({
  workspaceProxyForBusiness: vi.fn()
}));

vi.mock("@/lib/rowboat/gateway-token", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rowboat/gateway-token")>();
  return {
    ...actual,
    verifyGatewayTokenForBusiness: vi.fn().mockResolvedValue(true)
  };
});

import { POST } from "@/app/api/integrations/nango/proxy/route";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { workspaceProxyForBusiness } from "@/lib/workspace/proxy";
import { verifyGatewayTokenForBusiness } from "@/lib/rowboat/gateway-token";

const businessId = "11111111-1111-4111-8111-111111111111";

describe("api/integrations/nango/proxy", () => {
  const OLD_ENV = process.env;

  afterEach(() => {
    process.env = OLD_ENV;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...OLD_ENV, NANGO_SECRET_KEY: "nango-secret", ROWBOAT_GATEWAY_TOKEN: "gw" };
    vi.mocked(getAuthUser).mockResolvedValue({
      userId: "u1",
      email: "owner@example.com",
      isAdmin: false
    } as never);
    vi.mocked(requireBusinessRole).mockResolvedValue(undefined as never);
    vi.mocked(verifyGatewayTokenForBusiness).mockResolvedValue(true);
  });

  it("does NOT pre-gate on NANGO_SECRET_KEY, so a direct connection still works", async () => {
    // This route used to refuse outright without a Nango key. Workspace
    // connections are no longer all Nango: a first-party Outlook connection
    // needs no Nango key at all, and a blanket 503 would take down a perfectly
    // good direct connection. The dispatcher decides per row now, and the
    // Nango branch still raises its own error from getNangoClient.
    delete process.env.NANGO_SECRET_KEY;
    vi.mocked(workspaceProxyForBusiness).mockResolvedValue({
      status: 200,
      data: { id: "m1" }
    } as never);

    const res = await POST(
      new Request("http://localhost/api/integrations/nango/proxy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessId,
          connectionId: "direct:abc",
          providerConfigKey: "outlook",
          endpoint: "/v1.0/me",
          method: "GET"
        })
      })
    );

    expect(res.status).toBe(200);
    expect(workspaceProxyForBusiness).toHaveBeenCalled();
  });

  it("returns 401 when unauthenticated", async () => {
    vi.mocked(getAuthUser).mockResolvedValue(null);
    const res = await POST(
      new Request("http://localhost/api/integrations/nango/proxy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessId,
          connectionId: "c1",
          providerConfigKey: "gmail",
          endpoint: "/v1/x",
          method: "GET"
        })
      })
    );
    expect(res.status).toBe(401);
  });

  it("proxies for session owner", async () => {
    vi.mocked(workspaceProxyForBusiness).mockResolvedValue({
      status: 200,
      data: { emailAddress: "a@b.com" }
    } as never);

    const res = await POST(
      new Request("http://localhost/api/integrations/nango/proxy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessId,
          connectionId: "conn-a",
          providerConfigKey: "gmail",
          endpoint: "/gmail/v1/users/me/profile",
          method: "GET"
        })
      })
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.data.status).toBe(200);
    expect(json.data.data.emailAddress).toBe("a@b.com");
    expect(requireBusinessRole).toHaveBeenCalledWith(businessId, "manage_settings");
    expect(workspaceProxyForBusiness).toHaveBeenCalledWith(
      businessId,
      { connectionId: "conn-a", providerConfigKey: "gmail" },
      expect.objectContaining({ endpoint: "/gmail/v1/users/me/profile", method: "GET" })
    );
  });

  it("proxies for Rowboat gateway token without session", async () => {
    vi.mocked(getAuthUser).mockResolvedValue(null);
    vi.mocked(verifyGatewayTokenForBusiness).mockResolvedValue(true);
    vi.mocked(workspaceProxyForBusiness).mockResolvedValue({ status: 204, data: null } as never);

    const res = await POST(
      new Request("http://localhost/api/integrations/nango/proxy", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer gw"
        },
        body: JSON.stringify({
          businessId,
          connectionId: "c2",
          providerConfigKey: "outlook",
          endpoint: "/me",
          method: "GET"
        })
      })
    );
    expect(res.status).toBe(200);
    expect(requireBusinessRole).not.toHaveBeenCalled();
  });

  it("returns 404 when no workspace connection", async () => {
    vi.mocked(workspaceProxyForBusiness).mockResolvedValue(null);
    const res = await POST(
      new Request("http://localhost/api/integrations/nango/proxy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessId,
          connectionId: "c3",
          providerConfigKey: "gmail",
          endpoint: "/x",
          method: "GET"
        })
      })
    );
    expect(res.status).toBe(404);
  });
});
