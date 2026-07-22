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
  upsertWorkspaceOAuthConnection: vi.fn(),
  deleteWorkspaceOAuthConnection: vi.fn()
}));

vi.mock("@/lib/nango/account-identity", () => ({
  fetchProviderAccountIdentity: vi.fn(),
  nangoIdentityPatchBody: vi.fn().mockReturnValue(null),
  providerAccountMetadata: vi.fn().mockReturnValue({})
}));

vi.mock("@/lib/nango/connection-cap", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/nango/connection-cap")>();
  return {
    ...actual,
    resolveWorkspaceConnectionCapState: vi.fn(),
    settleWorkspaceConnectionInsert: vi.fn()
  };
});

vi.mock("@/lib/nango/account-usage", () => ({
  maybeSendNangoQuotaAlert: vi.fn()
}));

vi.mock("@/lib/nango/connection-continuity", () => ({
  consolidateReconnectedWorkspaceConnection: vi.fn()
}));

import { POST } from "@/app/api/integrations/nango/complete/route";
import { consolidateReconnectedWorkspaceConnection } from "@/lib/nango/connection-continuity";
import { fetchProviderAccountIdentity } from "@/lib/nango/account-identity";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { readConnectionEndUserId } from "@/lib/nango/server";
import {
  deleteWorkspaceOAuthConnection,
  getWorkspaceOAuthConnectionByNangoIds,
  upsertWorkspaceOAuthConnection
} from "@/lib/db/workspace-oauth-connections";
import {
  resolveWorkspaceConnectionCapState,
  settleWorkspaceConnectionInsert
} from "@/lib/nango/connection-cap";
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
    vi.mocked(settleWorkspaceConnectionInsert).mockResolvedValue({
      state: { used: 1, max: 3, atCap: false },
      evictRowId: null
    });
    mockDeleteConnection.mockResolvedValue(undefined);
    // Real contract: the probe never resolves null — a failed probe is
    // { email: null, displayName: null }.
    vi.mocked(fetchProviderAccountIdentity).mockResolvedValue({
      email: null,
      displayName: null
    });
    vi.mocked(consolidateReconnectedWorkspaceConnection).mockResolvedValue({
      consolidated: false
    });
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
    expect(settleWorkspaceConnectionInsert).toHaveBeenCalledWith(businessId, {
      providerConfigKey: "google-mail",
      connectionId: "conn-1"
    });
    expect(maybeSendNangoQuotaAlert).toHaveBeenCalled();
  });

  it("refuses a NEW over-cap connection, evicting the tentative row + Nango grant", async () => {
    vi.mocked(resolveWorkspaceConnectionCapState).mockResolvedValue({
      used: 3,
      max: 3,
      atCap: true
    });
    // First read: the existing-row check (null = new). Second read: the
    // tentative-row lookup on the eviction path.
    vi.mocked(getWorkspaceOAuthConnectionByNangoIds)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: "row-tentative",
        business_id: businessId,
        provider_config_key: "google-mail",
        connection_id: "conn-1",
        metadata: {},
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z"
      });
    const res = await POST(makeRequest());
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("Your plan includes 3 workspace connections");
    // The row lands tentatively (the continuity check needs it to exist),
    // then is evicted along with the Nango grant when nothing consolidated.
    expect(upsertWorkspaceOAuthConnection).toHaveBeenCalled();
    expect(deleteWorkspaceOAuthConnection).toHaveBeenCalledWith(businessId, "row-tentative");
    expect(mockDeleteConnection).toHaveBeenCalledWith("google-mail", "conn-1");
    // The over-cap settle is deferred to the eviction path, never run.
    expect(settleWorkspaceConnectionInsert).not.toHaveBeenCalled();
    expect(maybeSendNangoQuotaAlert).not.toHaveBeenCalled();
  });

  it("still refuses when the over-cap Nango delete fails (leak is logged, not fatal)", async () => {
    vi.mocked(resolveWorkspaceConnectionCapState).mockResolvedValue({
      used: 1,
      max: 1,
      atCap: true
    });
    // Tentative row already raced away — the eviction path tolerates it.
    mockDeleteConnection.mockRejectedValue(new Error("nango down"));
    const res = await POST(makeRequest());
    expect(res.status).toBe(403);
    expect(deleteWorkspaceOAuthConnection).not.toHaveBeenCalled();
  });

  it("allows an AT-CAP reconnect of the same account (consolidation nets zero seats)", async () => {
    vi.mocked(resolveWorkspaceConnectionCapState).mockResolvedValue({
      used: 3,
      max: 3,
      atCap: true
    });
    vi.mocked(fetchProviderAccountIdentity).mockResolvedValue({
      email: "sam@example.com",
      displayName: "Sam"
    });
    vi.mocked(consolidateReconnectedWorkspaceConnection).mockResolvedValue({
      consolidated: true,
      keptRowId: "row-old",
      supersededNangoConnectionId: "conn-old"
    });
    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    // No eviction, no cap refusal, and no quota alert (net-zero reconnect).
    expect(deleteWorkspaceOAuthConnection).not.toHaveBeenCalled();
    expect(maybeSendNangoQuotaAlert).not.toHaveBeenCalled();
  });

  it("evicts its own row when a RACED insert landed past the cap (post-insert settle)", async () => {
    vi.mocked(settleWorkspaceConnectionInsert).mockResolvedValue({
      state: { used: 4, max: 3, atCap: true },
      evictRowId: "row-evict"
    });
    const res = await POST(makeRequest());
    expect(res.status).toBe(403);
    // The row was inserted first (both racers passed the pre-check), so the
    // upsert DID happen — the settle then rolled this one back.
    expect(upsertWorkspaceOAuthConnection).toHaveBeenCalled();
    expect(deleteWorkspaceOAuthConnection).toHaveBeenCalledWith(businessId, "row-evict");
    expect(mockDeleteConnection).toHaveBeenCalledWith("google-mail", "conn-1");
    expect(maybeSendNangoQuotaAlert).not.toHaveBeenCalled();
  });

  it("raced eviction still refuses when the Nango-side delete fails", async () => {
    vi.mocked(settleWorkspaceConnectionInsert).mockResolvedValue({
      state: { used: 2, max: 1, atCap: true },
      evictRowId: "row-evict"
    });
    mockDeleteConnection.mockRejectedValue(new Error("nango down"));
    const res = await POST(makeRequest());
    expect(res.status).toBe(403);
    expect(deleteWorkspaceOAuthConnection).toHaveBeenCalledWith(businessId, "row-evict");
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
    expect(settleWorkspaceConnectionInsert).not.toHaveBeenCalled();
    expect(maybeSendNangoQuotaAlert).not.toHaveBeenCalled();
    // App-owned metadata (shared calendar id) survives the reconnect merge.
    expect(upsertWorkspaceOAuthConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ shared_calendar_id: "cal-1" })
      })
    );
  });

  it("consolidates a NEW connection onto the older row for the same account email", async () => {
    vi.mocked(fetchProviderAccountIdentity).mockResolvedValue({
      email: "sam@example.com",
      displayName: "Sam"
    });
    vi.mocked(consolidateReconnectedWorkspaceConnection).mockResolvedValue({
      consolidated: true,
      keptRowId: "row-old",
      supersededNangoConnectionId: "conn-old"
    });
    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    expect(consolidateReconnectedWorkspaceConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId,
        providerConfigKey: "google-mail",
        newConnectionId: "conn-1",
        accountEmail: "sam@example.com"
      })
    );
    // The injected Nango delete is the route's own client method.
    const call = vi.mocked(consolidateReconnectedWorkspaceConnection).mock.calls[0][0];
    await call.deleteNangoConnection("google-mail", "conn-old");
    expect(mockDeleteConnection).toHaveBeenCalledWith("google-mail", "conn-old");
  });

  it("skips consolidation when the identity probe resolved no email", async () => {
    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    expect(consolidateReconnectedWorkspaceConnection).not.toHaveBeenCalled();
  });

  it("skips consolidation on a re-complete of an EXISTING connection", async () => {
    vi.mocked(fetchProviderAccountIdentity).mockResolvedValue({
      email: "sam@example.com",
      displayName: "Sam"
    });
    vi.mocked(getWorkspaceOAuthConnectionByNangoIds).mockResolvedValue({
      id: "row-1",
      business_id: businessId,
      provider_config_key: "google-mail",
      connection_id: "conn-1",
      metadata: {},
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z"
    });
    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    expect(consolidateReconnectedWorkspaceConnection).not.toHaveBeenCalled();
  });

  it("a consolidation failure is non-fatal (two working rows remain)", async () => {
    vi.mocked(fetchProviderAccountIdentity).mockResolvedValue({
      email: "sam@example.com",
      displayName: "Sam"
    });
    vi.mocked(consolidateReconnectedWorkspaceConnection).mockRejectedValue(
      new Error("db hiccup")
    );
    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
  });
});
