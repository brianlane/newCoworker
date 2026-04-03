import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  getAuthUser: vi.fn(),
  requireOwner: vi.fn()
}));

vi.mock("@/lib/db/integrations", () => ({
  INTEGRATION_PROVIDERS: [
    "google",
    "outlook",
    "slack",
    "zoom",
    "hubspot",
    "salesforce",
    "custom_crm",
    "twilio",
    "custom_tool"
  ],
  getIntegrations: vi.fn(),
  deleteIntegration: vi.fn()
}));

import { DELETE, GET } from "@/app/api/integrations/route";
import { deleteIntegration, getIntegrations } from "@/lib/db/integrations";
import { getAuthUser, requireOwner } from "@/lib/auth";

const OWNER = {
  userId: "user-1",
  email: "owner@example.com",
  isAdmin: false
};

describe("api/integrations route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getAuthUser).mockResolvedValue(OWNER as never);
    vi.mocked(requireOwner).mockResolvedValue(OWNER as never);
    vi.mocked(getIntegrations).mockResolvedValue([
      {
        id: "int-1",
        business_id: "11111111-1111-4111-8111-111111111111",
        provider: "google",
        auth_type: "oauth",
        status: "connected",
        token_expires_at: "2026-01-01T00:00:00Z",
        scopes: ["a"],
        metadata: {},
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z"
      }
    ] as never);
    vi.mocked(deleteIntegration).mockResolvedValue(undefined);
  });

  it("lists integrations for the owner business", async () => {
    const businessId = "11111111-1111-4111-8111-111111111111";
    const response = await GET(
      new Request(`http://localhost/api/integrations?businessId=${businessId}`)
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).not.toHaveProperty("access_token");
    expect(body.data[0]).not.toHaveProperty("refresh_token");
    expect(body.data[0]).not.toHaveProperty("api_key_encrypted");
    expect(requireOwner).toHaveBeenCalledWith(businessId);
    expect(getIntegrations).toHaveBeenCalledWith(businessId);
  });

  it("rejects GET without businessId", async () => {
    const response = await GET(new Request("http://localhost/api/integrations"));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });

  it("deletes an integration for the owner business", async () => {
    const businessId = "11111111-1111-4111-8111-111111111111";
    const response = await DELETE(
      new Request("http://localhost/api/integrations", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId, provider: "google" })
      })
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(requireOwner).toHaveBeenCalledWith(businessId);
    expect(deleteIntegration).toHaveBeenCalledWith(businessId, "google");
  });

  it("allows admins to delete without owner check", async () => {
    vi.mocked(getAuthUser).mockResolvedValue({
      userId: "admin-1",
      email: "admin@example.com",
      isAdmin: true
    } as never);

    const response = await DELETE(
      new Request("http://localhost/api/integrations", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessId: "11111111-1111-4111-8111-111111111111",
          provider: "google"
        })
      })
    );

    expect(response.status).toBe(200);
    expect(requireOwner).not.toHaveBeenCalled();
  });

  it("rejects unauthenticated DELETE", async () => {
    vi.mocked(getAuthUser).mockResolvedValue(null);

    const response = await DELETE(
      new Request("http://localhost/api/integrations", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessId: "11111111-1111-4111-8111-111111111111",
          provider: "google"
        })
      })
    );
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 400 for invalid DELETE payloads", async () => {
    const response = await DELETE(
      new Request("http://localhost/api/integrations", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessId: "not-a-uuid",
          provider: "google"
        })
      })
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });
});
