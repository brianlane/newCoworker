import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  getAuthUser: vi.fn(),
  requireOwner: vi.fn()
}));

vi.mock("@/lib/nango/workspace", () => ({
  nangoProxyForBusiness: vi.fn()
}));

vi.mock("@/lib/rowboat/gateway-token", () => ({
  verifyRowboatGatewayToken: vi.fn()
}));

import { POST } from "@/app/api/integrations/nango/proxy/route";
import { getAuthUser, requireOwner } from "@/lib/auth";
import { nangoProxyForBusiness } from "@/lib/nango/workspace";
import { verifyRowboatGatewayToken } from "@/lib/rowboat/gateway-token";

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
    vi.mocked(requireOwner).mockResolvedValue(undefined as never);
    vi.mocked(verifyRowboatGatewayToken).mockReturnValue(false);
  });

  it("returns 503 when NANGO_SECRET_KEY is missing", async () => {
    delete process.env.NANGO_SECRET_KEY;
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
    expect(res.status).toBe(503);
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
    vi.mocked(nangoProxyForBusiness).mockResolvedValue({
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
    expect(requireOwner).toHaveBeenCalledWith(businessId);
    expect(nangoProxyForBusiness).toHaveBeenCalledWith(
      businessId,
      { connectionId: "conn-a", providerConfigKey: "gmail" },
      expect.objectContaining({ endpoint: "/gmail/v1/users/me/profile", method: "GET" })
    );
  });

  it("proxies for Rowboat gateway token without session", async () => {
    vi.mocked(getAuthUser).mockResolvedValue(null);
    vi.mocked(verifyRowboatGatewayToken).mockReturnValue(true);
    vi.mocked(nangoProxyForBusiness).mockResolvedValue({ status: 204, data: null } as never);

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
    expect(requireOwner).not.toHaveBeenCalled();
  });

  it("returns 404 when no workspace connection", async () => {
    vi.mocked(nangoProxyForBusiness).mockResolvedValue(null);
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
