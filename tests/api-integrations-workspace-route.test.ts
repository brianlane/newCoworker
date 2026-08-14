import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  getAuthUser: vi.fn(),
  requireBusinessRole: vi.fn()
}));

vi.mock("@/lib/db/workspace-oauth-connections", () => ({
  listWorkspaceOAuthConnections: vi.fn(),
  getWorkspaceOAuthConnection: vi.fn(),
  deleteWorkspaceOAuthConnection: vi.fn(),
  getWorkspaceConnectionSecrets: vi.fn()
}));

vi.mock("@/lib/nango/server", () => ({
  getNangoClient: vi.fn()
}));

vi.mock("@/lib/google/oauth", () => ({
  revokeGoogleToken: vi.fn()
}));

vi.mock("@/lib/ai-flows/mailbox-steps", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai-flows/mailbox-steps")>()),
  flowsReferencingWorkspaceConnection: vi.fn()
}));

import { DELETE, GET } from "@/app/api/integrations/workspace/route";
import { flowsReferencingWorkspaceConnection } from "@/lib/ai-flows/mailbox-steps";
import {
  deleteWorkspaceOAuthConnection,
  getWorkspaceConnectionSecrets,
  getWorkspaceOAuthConnection,
  listWorkspaceOAuthConnections
} from "@/lib/db/workspace-oauth-connections";
import { getNangoClient } from "@/lib/nango/server";
import { revokeGoogleToken } from "@/lib/google/oauth";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";

const businessId = "11111111-1111-4111-8111-111111111111";
const connectionRowId = "22222222-2222-4222-8222-222222222222";

/** A stored connection row, defaulted to the common Nango shape. */
function row(over: Partial<Awaited<ReturnType<typeof getWorkspaceOAuthConnection>>> = {}) {
  return {
    id: connectionRowId,
    business_id: businessId,
    provider_config_key: "gmail",
    connection_id: "c1",
    metadata: {},
    transport: "nango" as const,
    is_active: true,
    oauth_scope: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...over
  };
}

function deleteRequest() {
  return new Request("http://localhost/api/integrations/workspace", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ businessId, id: connectionRowId })
  });
}

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
    vi.mocked(requireBusinessRole).mockResolvedValue(undefined as never);
    vi.mocked(flowsReferencingWorkspaceConnection).mockResolvedValue([]);
    vi.mocked(getWorkspaceConnectionSecrets).mockResolvedValue(null);
    vi.mocked(revokeGoogleToken).mockResolvedValue(true);
    vi.mocked(listWorkspaceOAuthConnections).mockResolvedValue([
      {
        id: connectionRowId,
        business_id: businessId,
        provider_config_key: "gmail",
        connection_id: "c1",
        metadata: {},
        transport: "nango" as const,
        is_active: true,
        oauth_scope: null,
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
    expect(json.data[0].metadata).toEqual({});
  });

  it("DELETE revokes and removes row", async () => {
    vi.mocked(getWorkspaceOAuthConnection).mockResolvedValue({
      id: connectionRowId,
      business_id: businessId,
      provider_config_key: "gmail",
      connection_id: "c1",
      metadata: {},
      transport: "nango" as const,
      is_active: true,
      oauth_scope: null,
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
      transport: "nango" as const,
      is_active: true,
      oauth_scope: null,
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

  it("DELETE refuses (409) while flows still reference the connection", async () => {
    vi.mocked(getWorkspaceOAuthConnection).mockResolvedValue({
      id: connectionRowId,
      business_id: businessId,
      provider_config_key: "gmail",
      connection_id: "c1",
      metadata: {},
      transport: "nango" as const,
      is_active: true,
      oauth_scope: null,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z"
    });
    vi.mocked(flowsReferencingWorkspaceConnection).mockResolvedValue([
      { id: "f1", name: "Booking confirmation", enabled: true },
      { id: "f2", name: "Old outreach", enabled: false }
    ]);

    const res = await DELETE(
      new Request("http://localhost/api/integrations/workspace", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId, id: connectionRowId })
      })
    );
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error.message).toContain('"Booking confirmation"');
    expect(json.error.message).toContain('"Old outreach" (disabled)');
    // Fail closed BEFORE any provider revoke or row delete.
    expect(getNangoClient).not.toHaveBeenCalled();
    expect(deleteWorkspaceOAuthConnection).not.toHaveBeenCalled();
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
      transport: "nango" as const,
      is_active: true,
      oauth_scope: null,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z"
    });
    vi.mocked(deleteWorkspaceOAuthConnection).mockResolvedValue({
      id: connectionRowId,
      business_id: businessId,
      provider_config_key: "gmail",
      connection_id: "c1",
      metadata: {},
      transport: "nango" as const,
      is_active: true,
      oauth_scope: null,
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
      transport: "nango" as const,
      is_active: true,
      oauth_scope: null,
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

  it("does NOT call Nango when removing a DIRECT row", async () => {
    // A direct row's connection_id is a synthetic `direct:<uuid>` that Nango
    // has never seen. Calling deleteConnection with it fails, and before the
    // transport check that failure returned a 500, wedging every single direct
    // disconnect. The teardown for a direct row is deleting the ciphertext.
    process.env.NANGO_SECRET_KEY = "nango-secret";
    vi.mocked(getWorkspaceOAuthConnection).mockResolvedValue({
      id: connectionRowId,
      business_id: businessId,
      provider_config_key: "outlook",
      connection_id: "direct:abc",
      metadata: {},
      transport: "direct" as const,
      is_active: true,
      oauth_scope: null,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z"
    } as never);
    vi.mocked(flowsReferencingWorkspaceConnection).mockResolvedValue([]);
    vi.mocked(deleteWorkspaceOAuthConnection).mockResolvedValue({ id: connectionRowId } as never);
    const deleteNango = vi.fn().mockResolvedValue(undefined);
    vi.mocked(getNangoClient).mockReturnValue({ deleteConnection: deleteNango } as never);

    const res = await DELETE(
      new Request("http://localhost/api/integrations/workspace", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId, id: connectionRowId })
      })
    );

    expect(res.status).toBe(200);
    expect(deleteNango).not.toHaveBeenCalled();
    expect(deleteWorkspaceOAuthConnection).toHaveBeenCalled();
    // Microsoft publishes no scoped revoke endpoint, so there is nothing to
    // read the ciphertext FOR on an Outlook row.
    expect(getWorkspaceConnectionSecrets).not.toHaveBeenCalled();
    expect(revokeGoogleToken).not.toHaveBeenCalled();
  });

  describe("revoking a direct Google grant", () => {
    const googleRow = row({
      provider_config_key: "google",
      connection_id: "direct:abc",
      transport: "direct" as const
    });

    beforeEach(() => {
      vi.mocked(getWorkspaceOAuthConnection).mockResolvedValue(googleRow as never);
      vi.mocked(deleteWorkspaceOAuthConnection).mockResolvedValue(googleRow as never);
      vi.mocked(getWorkspaceConnectionSecrets).mockResolvedValue({
        id: connectionRowId,
        accessToken: "at",
        refreshToken: "rt",
        tokenExpiresAt: "2026-01-01T01:00:00Z",
        isActive: true,
        updatedAt: "2026-01-01T00:00:00Z"
      });
    });

    it("revokes at Google with the REFRESH token, which kills the whole grant", async () => {
      // Revoking the access token would leave the refresh token able to mint
      // more, so Disconnect would still not mean disconnected.
      const res = await DELETE(deleteRequest());

      expect(res.status).toBe(200);
      expect(revokeGoogleToken).toHaveBeenCalledWith("rt");
      expect(getNangoClient).not.toHaveBeenCalled();
    });

    it("revokes AFTER the row is deleted, never before", async () => {
      // Ordering contract, same as src/lib/nango/cleanup.ts: a failed delete
      // must leave the tenant intact rather than holding a row whose grant we
      // already killed. The read has to precede the delete, though, because
      // deleting the row destroys the only copy of the ciphertext.
      const order: string[] = [];
      vi.mocked(getWorkspaceConnectionSecrets).mockImplementation(async () => {
        order.push("read");
        return {
          id: connectionRowId,
          accessToken: "at",
          refreshToken: "rt",
          tokenExpiresAt: "2026-01-01T01:00:00Z",
          isActive: true,
          updatedAt: "2026-01-01T00:00:00Z"
        };
      });
      vi.mocked(deleteWorkspaceOAuthConnection).mockImplementation(async () => {
        order.push("delete");
        return googleRow as never;
      });
      vi.mocked(revokeGoogleToken).mockImplementation(async () => {
        order.push("revoke");
        return true;
      });

      await DELETE(deleteRequest());

      expect(order).toEqual(["read", "delete", "revoke"]);
    });

    it("does not revoke when the row delete found nothing", async () => {
      vi.mocked(deleteWorkspaceOAuthConnection).mockResolvedValue(null as never);

      const res = await DELETE(deleteRequest());

      expect(res.status).toBe(404);
      expect(revokeGoogleToken).not.toHaveBeenCalled();
    });

    it("still succeeds when Google refuses the revoke", async () => {
      // Best-effort by design: a Google outage must not stop an owner from
      // disconnecting. The row is already gone, so failing here would report an
      // error for a disconnect that DID happen.
      vi.mocked(revokeGoogleToken).mockResolvedValue(false);

      const res = await DELETE(deleteRequest());

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ data: { deleted: true } });
    });

    it("skips the revoke when the row carries no usable token pair", async () => {
      // A wiped or half-written pair reads as null. Passing an empty string to
      // the revoke endpoint would be a pointless round-trip.
      vi.mocked(getWorkspaceConnectionSecrets).mockResolvedValue(null);

      const res = await DELETE(deleteRequest());

      expect(res.status).toBe(200);
      expect(revokeGoogleToken).not.toHaveBeenCalled();
    });

    it("does not revoke for a Google row still on the Nango transport", async () => {
      // Nango holds those tokens; deleteConnection above is what revokes them.
      // We have no ciphertext of our own to present.
      vi.mocked(getWorkspaceOAuthConnection).mockResolvedValue(
        row({ provider_config_key: "google", transport: "nango" as const }) as never
      );
      vi.mocked(getNangoClient).mockReturnValue({
        deleteConnection: vi.fn().mockResolvedValue(undefined)
      } as never);

      const res = await DELETE(deleteRequest());

      expect(res.status).toBe(200);
      expect(revokeGoogleToken).not.toHaveBeenCalled();
      expect(getWorkspaceConnectionSecrets).not.toHaveBeenCalled();
    });
  });
});
