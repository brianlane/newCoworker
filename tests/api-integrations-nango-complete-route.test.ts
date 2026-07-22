import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  getAuthUser: vi.fn(),
  requireBusinessRole: vi.fn()
}));

const mockGetConnection = vi.fn();
const mockDeleteConnection = vi.fn();
const mockPatchConnection = vi.fn();
vi.mock("@/lib/nango/server", () => ({
  getNangoClient: () => ({
    getConnection: mockGetConnection,
    deleteConnection: mockDeleteConnection,
    patchConnection: mockPatchConnection
  }),
  readConnectionEndUserId: vi.fn(),
  workspaceConnectionMetadataFromNangoConnection: vi.fn().mockReturnValue({
    connected_via: "connect_ui"
  })
}));

vi.mock("@/lib/db/workspace-oauth-connections", () => ({
  getWorkspaceOAuthConnectionByNangoIds: vi.fn(),
  upsertWorkspaceOAuthConnection: vi.fn()
}));

vi.mock("@/lib/nango/account-identity", () => ({
  fetchProviderAccountIdentity: vi.fn().mockResolvedValue(null),
  nangoIdentityPatchBody: vi.fn().mockReturnValue(null),
  providerAccountMetadata: vi.fn().mockReturnValue({})
}));

vi.mock("@/lib/nango/connection-cap", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/nango/connection-cap")>();
  return {
    ...actual,
    resolveWorkspaceConnectionCapState: vi.fn()
  };
});

vi.mock("@/lib/nango/account-usage", () => ({
  maybeSendNangoQuotaAlert: vi.fn()
}));

import { POST } from "@/app/api/integrations/nango/complete/route";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { readConnectionEndUserId } from "@/lib/nango/server";
import {
  getWorkspaceOAuthConnectionByNangoIds,
  upsertWorkspaceOAuthConnection
} from "@/lib/db/workspace-oauth-connections";
import { resolveWorkspaceConnectionCapState } from "@/lib/nango/connection-cap";
import { maybeSendNangoQuotaAlert } from "@/lib/nango/account-usage";

const businessId = "11111111-1111-4111-8111-111111111111";

function makeRequest() {
  return new Request("http://localhost/api/integrations/nango/complete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      businessId,
      connectionId: "conn-1",
      providerConfigKey: "google-mail"
    })
  });
}

describe("api/integrations/nango/complete", () => {
  const OLD_ENV = process.env;

  afterEach(() => {
    process.env = OLD_ENV;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...OLD_ENV, NANGO_SECRET_KEY: "nango-secret" };
    vi.mocked(getAuthUser).mockResolvedValue({
      userId: "u1",
      email: "owner@example.com",
      isAdmin: false
    } as never);
    vi.mocked(requireBusinessRole).mockResolvedValue(undefined as never);
    mockGetConnection.mockResolvedValue({ id: "nango-conn" });
    vi.mocked(readConnectionEndUserId).mockReturnValue(businessId);
    vi.mocked(getWorkspaceOAuthConnectionByNangoIds).mockResolvedValue(null);
    vi.mocked(upsertWorkspaceOAuthConnection).mockResolvedValue({} as never);
    vi.mocked(resolveWorkspaceConnectionCapState).mockResolvedValue({
      used: 0,
      max: 3,
      atCap: false
    });
    mockDeleteConnection.mockResolvedValue(undefined);
  });

  it("returns 401 when unauthenticated", async () => {
    vi.mocked(getAuthUser).mockResolvedValue(null);
    const res = await POST(makeRequest());
    expect(res.status).toBe(401);
  });

  it("returns 503 when NANGO_SECRET_KEY is missing", async () => {
    delete process.env.NANGO_SECRET_KEY;
    const res = await POST(makeRequest());
    expect(res.status).toBe(503);
  });

  it("refuses a connection whose end user is another workspace", async () => {
    vi.mocked(readConnectionEndUserId).mockReturnValue("other-business");
    const res = await POST(makeRequest());
    expect(res.status).toBe(403);
    expect(upsertWorkspaceOAuthConnection).not.toHaveBeenCalled();
  });

  it("saves a NEW connection below the cap and checks platform quota headroom", async () => {
    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    expect(upsertWorkspaceOAuthConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId,
        providerConfigKey: "google-mail",
        connectionId: "conn-1"
      })
    );
    expect(maybeSendNangoQuotaAlert).toHaveBeenCalled();
  });

  it("refuses a NEW over-cap connection and deletes it from Nango (quota reclaim)", async () => {
    vi.mocked(resolveWorkspaceConnectionCapState).mockResolvedValue({
      used: 3,
      max: 3,
      atCap: true
    });
    const res = await POST(makeRequest());
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("Your plan includes 3 workspace connections");
    expect(mockDeleteConnection).toHaveBeenCalledWith("google-mail", "conn-1");
    expect(upsertWorkspaceOAuthConnection).not.toHaveBeenCalled();
    expect(maybeSendNangoQuotaAlert).not.toHaveBeenCalled();
  });

  it("still refuses when the over-cap Nango delete fails (leak is logged, not fatal)", async () => {
    vi.mocked(resolveWorkspaceConnectionCapState).mockResolvedValue({
      used: 1,
      max: 1,
      atCap: true
    });
    mockDeleteConnection.mockRejectedValue(new Error("nango down"));
    const res = await POST(makeRequest());
    expect(res.status).toBe(403);
    expect(upsertWorkspaceOAuthConnection).not.toHaveBeenCalled();
  });

  it("always allows re-completing an EXISTING connection, even at the cap (reconnect path)", async () => {
    vi.mocked(getWorkspaceOAuthConnectionByNangoIds).mockResolvedValue({
      id: "row-1",
      business_id: businessId,
      provider_config_key: "google-mail",
      connection_id: "conn-1",
      metadata: { shared_calendar_id: "cal-1" },
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z"
    });
    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    // The cap is never consulted for a reconnect, and no quota was consumed.
    expect(resolveWorkspaceConnectionCapState).not.toHaveBeenCalled();
    expect(maybeSendNangoQuotaAlert).not.toHaveBeenCalled();
    // App-owned metadata (shared calendar id) survives the reconnect merge.
    expect(upsertWorkspaceOAuthConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ shared_calendar_id: "cal-1" })
      })
    );
  });
});
