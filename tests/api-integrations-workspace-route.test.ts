import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  getAuthUser: vi.fn(),
  requireOwner: vi.fn()
}));

vi.mock("@/lib/db/workspace-oauth-connections", () => ({
  listWorkspaceOAuthConnections: vi.fn(),
  getWorkspaceOAuthConnection: vi.fn(),
  deleteWorkspaceOAuthConnection: vi.fn()
}));

vi.mock("@/lib/nango/server", () => ({
  getNangoClient: vi.fn()
}));

import { DELETE, GET } from "@/app/api/integrations/workspace/route";
import {
  deleteWorkspaceOAuthConnection,
  getWorkspaceOAuthConnection,
  listWorkspaceOAuthConnections
} from "@/lib/db/workspace-oauth-connections";
import { getNangoClient } from "@/lib/nango/server";
import { getAuthUser, requireOwner } from "@/lib/auth";

const businessId = "11111111-1111-4111-8111-111111111111";
const connectionRowId = "22222222-2222-4222-8222-222222222222";

describe("api/integrations/workspace", () => {
  const OLD = process.env;

  afterEach(() => {
    process.env = OLD;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...OLD, NANGO_SECRET_KEY: "sec" };
    vi.mocked(getAuthUser).mockResolvedValue({
      userId: "u1",
      email: "owner@example.com",
      isAdmin: false
    } as never);
    vi.mocked(requireOwner).mockResolvedValue(undefined as never);
    vi.mocked(listWorkspaceOAuthConnections).mockResolvedValue([
      {
        id: connectionRowId,
        business_id: businessId,
        provider_config_key: "gmail",
        connection_id: "c1",
        metadata: {},
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z"
      }
    ]);
  });

  it("GET lists connections for owner", async () => {
    const res = await GET(
      new Request(`http://localhost/api/integrations/workspace?businessId=${businessId}`)
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.data).toHaveLength(1);
    expect(json.data[0].connectionId).toBe("c1");
  });

  it("DELETE revokes and removes row", async () => {
    vi.mocked(getWorkspaceOAuthConnection).mockResolvedValue({
      id: connectionRowId,
      business_id: businessId,
      provider_config_key: "gmail",
      connection_id: "c1",
      metadata: {},
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z"
    });
    const mockDeleteNango = vi.fn().mockResolvedValue(undefined);
    vi.mocked(getNangoClient).mockReturnValue({ deleteConnection: mockDeleteNango } as never);
    vi.mocked(deleteWorkspaceOAuthConnection).mockResolvedValue({
      id: connectionRowId,
      business_id: businessId,
      provider_config_key: "gmail",
      connection_id: "c1",
      metadata: {},
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z"
    });

    const res = await DELETE(
      new Request("http://localhost/api/integrations/workspace", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId, id: connectionRowId })
      })
    );
    expect(res.status).toBe(200);
    expect(mockDeleteNango).toHaveBeenCalledWith("gmail", "c1");
  });

  it("DELETE returns 404 when connection missing", async () => {
    vi.mocked(getWorkspaceOAuthConnection).mockResolvedValue(null);
    const res = await DELETE(
      new Request("http://localhost/api/integrations/workspace", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessId,
          id: "99999999-9999-4999-8999-999999999999"
        })
      })
    );
    expect(res.status).toBe(404);
  });

  it("DELETE skips provider revoke when NANGO_SECRET_KEY unset", async () => {
    delete process.env.NANGO_SECRET_KEY;
    vi.mocked(getWorkspaceOAuthConnection).mockResolvedValue({
      id: connectionRowId,
      business_id: businessId,
      provider_config_key: "gmail",
      connection_id: "c1",
      metadata: {},
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z"
    });
    vi.mocked(deleteWorkspaceOAuthConnection).mockResolvedValue({
      id: connectionRowId,
      business_id: businessId,
      provider_config_key: "gmail",
      connection_id: "c1",
      metadata: {},
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z"
    });

    const res = await DELETE(
      new Request("http://localhost/api/integrations/workspace", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId, id: connectionRowId })
      })
    );
    expect(res.status).toBe(200);
    expect(getNangoClient).not.toHaveBeenCalled();
  });

  it("DELETE returns 500 when provider revoke fails", async () => {
    vi.mocked(getWorkspaceOAuthConnection).mockResolvedValue({
      id: connectionRowId,
      business_id: businessId,
      provider_config_key: "gmail",
      connection_id: "c1",
      metadata: {},
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z"
    });
    vi.mocked(getNangoClient).mockReturnValue({
      deleteConnection: vi.fn().mockRejectedValue(new Error("nango down"))
    } as never);

    const res = await DELETE(
      new Request("http://localhost/api/integrations/workspace", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId, id: connectionRowId })
      })
    );
    expect(res.status).toBe(500);
  });
});
