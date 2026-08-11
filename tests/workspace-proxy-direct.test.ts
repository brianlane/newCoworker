/**
 * The transport dispatcher's DIRECT arm.
 *
 * The Nango arm is covered by tests/nango-workspace.test.ts through the
 * compatibility re-export. What matters here is that a direct row behaves
 * identically from the caller's side: same `null` semantics for "no usable
 * connection", same throw-on-non-2xx, and the same `{status, data}`
 * normalization through the status wrapper.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetByNangoIds = vi.fn();
const mockProxy = vi.fn();
const mockProxyStatus = vi.fn();
const mockGetMicrosoftAccessToken = vi.fn();

vi.mock("@/lib/db/workspace-oauth-connections", () => ({
  getWorkspaceOAuthConnectionByNangoIds: (...a: unknown[]) => mockGetByNangoIds(...a)
}));
vi.mock("@/lib/nango/workspace", () => ({
  nangoProxyForBusiness: (...a: unknown[]) => mockProxy(...a),
  nangoProxyStatusForBusiness: (...a: unknown[]) => mockProxyStatus(...a)
}));
vi.mock("@/lib/microsoft/client", () => ({
  getMicrosoftAccessToken: (...a: unknown[]) => mockGetMicrosoftAccessToken(...a)
}));

import {
  workspaceProxyForBusiness,
  workspaceProxyStatusForBusiness
} from "@/lib/workspace/proxy";

const ROW_ID = "44444444-4444-4444-8444-444444444444";
const link = { connectionId: "direct:abc", providerConfigKey: "outlook" };

const directRow = (over: Record<string, unknown> = {}) => ({
  id: ROW_ID,
  business_id: "biz",
  provider_config_key: "outlook",
  connection_id: "direct:abc",
  metadata: {},
  transport: "direct",
  is_active: true,
  created_at: "2026-08-01T00:00:00Z",
  updated_at: "2026-08-01T00:00:00Z",
  ...over
});

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

function graph(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

describe("workspaceProxyForBusiness (direct transport)", () => {
  it("calls Graph with the connection's own bearer, never Nango", async () => {
    mockGetByNangoIds.mockResolvedValue(directRow());
    mockGetMicrosoftAccessToken.mockResolvedValue("at-live");
    fetchMock.mockResolvedValue(graph({ id: "u1" }));

    const res = await workspaceProxyForBusiness("biz", link, {
      endpoint: "/v1.0/me",
      method: "GET"
    });

    expect(res).toEqual({ status: 200, data: { id: "u1" } });
    expect(mockProxy).not.toHaveBeenCalled();
    // The token manager is keyed by ROW id, not the synthetic connection id.
    expect(mockGetMicrosoftAccessToken).toHaveBeenCalledWith(ROW_ID);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://graph.microsoft.com/v1.0/me");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer at-live");
  });

  it("forwards method, body, params and headers to the provider", async () => {
    mockGetByNangoIds.mockResolvedValue(directRow());
    mockGetMicrosoftAccessToken.mockResolvedValue("at-live");
    fetchMock.mockResolvedValue(graph({}, 202));

    await workspaceProxyForBusiness("biz", link, {
      endpoint: "/v1.0/me/calendarView",
      method: "POST",
      data: { a: 1 },
      params: { startDateTime: "2026-08-01" },
      headers: { Prefer: 'outlook.timezone="UTC"' }
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new URL(url).searchParams.get("startDateTime")).toBe("2026-08-01");
    expect(init.method).toBe("POST");
    expect(init.body).toBe('{"a":1}');
    expect((init.headers as Record<string, string>).Prefer).toBe('outlook.timezone="UTC"');
  });

  it("returns null when the row does not belong to the business", async () => {
    mockGetByNangoIds.mockResolvedValue(null);
    await expect(
      workspaceProxyForBusiness("biz", link, { endpoint: "/v1.0/me" })
    ).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns null when the grant is dead (no usable token)", async () => {
    // The direct analogue of "not connected": the token manager already
    // deactivated the row, so this must NOT look like a provider error.
    mockGetByNangoIds.mockResolvedValue(directRow());
    mockGetMicrosoftAccessToken.mockResolvedValue(null);

    await expect(
      workspaceProxyForBusiness("biz", link, { endpoint: "/v1.0/me" })
    ).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns null (and does not throw) for a direct row of a provider with no client", async () => {
    // Google has no direct client yet. A row like this is a data problem, not
    // a request problem, so it degrades to "not connected".
    mockGetByNangoIds.mockResolvedValue(
      directRow({ provider_config_key: "gmail", connection_id: "direct:g" })
    );

    await expect(
      workspaceProxyForBusiness(
        "biz",
        { connectionId: "direct:g", providerConfigKey: "gmail" },
        { endpoint: "/gmail/v1/users/me/profile" }
      )
    ).resolves.toBeNull();
    expect(mockGetMicrosoftAccessToken).not.toHaveBeenCalled();
  });

  it("throws on a non-2xx, matching the Nango arm", async () => {
    mockGetByNangoIds.mockResolvedValue(directRow());
    mockGetMicrosoftAccessToken.mockResolvedValue("at-live");
    fetchMock.mockResolvedValue(graph({ error: { code: "ErrorItemNotFound" } }, 404));

    await expect(
      workspaceProxyForBusiness("biz", link, { endpoint: "/v1.0/me/messages/x" })
    ).rejects.toMatchObject({ response: { status: 404 } });
  });

  it("still routes a NANGO row through Nango", async () => {
    mockGetByNangoIds.mockResolvedValue(directRow({ transport: "nango", connection_id: "nango-1" }));
    mockProxy.mockResolvedValue({ status: 200, data: { ok: true } });

    await workspaceProxyForBusiness("biz", link, { endpoint: "/v1.0/me" });

    // Falls through to the Nango transport untouched, with the caller's own
    // args: the direct arm must not rewrite the request on its way past.
    expect(mockProxy).toHaveBeenCalledWith("biz", link, { endpoint: "/v1.0/me" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("workspaceProxyStatusForBusiness (direct transport)", () => {
  beforeEach(() => {
    mockGetByNangoIds.mockResolvedValue(directRow());
    mockGetMicrosoftAccessToken.mockResolvedValue("at-live");
  });

  it("normalizes a direct 403 into a returned status, exactly like the Nango arm", async () => {
    // This is the contract email/organize.ts depends on to emit its reconnect
    // hint; it must not care which transport served the request.
    fetchMock.mockResolvedValue(graph({ error: { code: "ErrorAccessDenied" } }, 403));

    await expect(
      workspaceProxyStatusForBusiness("biz", link, { endpoint: "/v1.0/me/messages/x" })
    ).resolves.toEqual({ status: 403, data: { error: { code: "ErrorAccessDenied" } } });
  });

  it("passes a direct success through as status and data", async () => {
    fetchMock.mockResolvedValue(graph({ id: "m1" }));
    await expect(
      workspaceProxyStatusForBusiness("biz", link, { endpoint: "/v1.0/me" })
    ).resolves.toEqual({ status: 200, data: { id: "m1" } });
  });

  it("returns null for a dead grant rather than inventing a status", async () => {
    mockGetMicrosoftAccessToken.mockResolvedValue(null);
    await expect(
      workspaceProxyStatusForBusiness("biz", link, { endpoint: "/v1.0/me" })
    ).resolves.toBeNull();
  });

  it("rethrows a direct transport failure, which carries no status", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(
      workspaceProxyStatusForBusiness("biz", link, { endpoint: "/v1.0/me" })
    ).rejects.toThrow("Provider unreachable");
  });

  it("rethrows a non-object direct rejection", async () => {
    mockGetMicrosoftAccessToken.mockRejectedValue("weird failure");
    await expect(
      workspaceProxyStatusForBusiness("biz", link, { endpoint: "/v1.0/me" })
    ).rejects.toBe("weird failure");
  });

  it("rethrows when the direct error carries no response object", async () => {
    mockGetMicrosoftAccessToken.mockRejectedValue(new Error("token store down"));
    await expect(
      workspaceProxyStatusForBusiness("biz", link, { endpoint: "/v1.0/me" })
    ).rejects.toThrow("token store down");
  });

  it("rethrows when the direct error status is out of the HTTP range or not a number", async () => {
    // A `status` field on some unrelated object is not a provider response;
    // normalizing it would hand the caller a status nothing actually returned.
    for (const response of [{ status: 42 }, { status: Number.NaN }, { status: "403" }]) {
      mockGetMicrosoftAccessToken.mockRejectedValue(
        Object.assign(new Error("nope"), { response })
      );
      await expect(
        workspaceProxyStatusForBusiness("biz", link, { endpoint: "/v1.0/me" })
      ).rejects.toThrow("nope");
    }
  });

});
