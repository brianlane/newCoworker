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
const mockGetGoogleAccessToken = vi.fn();

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
vi.mock("@/lib/google/client", () => ({
  getGoogleAccessToken: (...a: unknown[]) => mockGetGoogleAccessToken(...a)
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

  it("routes every Google-family provider key to the Google client", async () => {
    // Replaces a case that asserted a direct row for a client-less provider
    // degraded to null. Once Google landed there was no client-less provider
    // left (providerFromKey answers only google or microsoft), so that branch
    // became unreachable and DIRECT_CLIENTS became a total Record. The case
    // was still passing, but only because the unconfigured Google mock returned
    // undefined, which is not what it claimed to prove.
    //
    // What is worth pinning instead is the aliasing: several legacy keys all
    // mean Google, and each must reach the Google client rather than falling
    // through to Microsoft.
    for (const key of ["google", "gmail", "google-mail", "google-calendar"]) {
      vi.clearAllMocks();
      mockGetByNangoIds.mockResolvedValue(
        directRow({ provider_config_key: key, connection_id: "direct:g" })
      );
      mockGetGoogleAccessToken.mockResolvedValue("at-google");
      fetchMock.mockResolvedValue(graph({ ok: true }));

      await workspaceProxyForBusiness(
        "biz",
        { connectionId: "direct:g", providerConfigKey: key },
        { endpoint: "/gmail/v1/users/me/profile" }
      );

      expect(mockGetGoogleAccessToken, key).toHaveBeenCalledWith(ROW_ID);
      expect(mockGetMicrosoftAccessToken, key).not.toHaveBeenCalled();
      const [url] = fetchMock.mock.calls[0] as [string];
      expect(url, key).toBe("https://www.googleapis.com/gmail/v1/users/me/profile");
    }
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

/**
 * Google's direct arm.
 *
 * The point of the registry design is that adding a provider is one entry and
 * changes nothing else, so these assert the two things that could still be wrong
 * for Google specifically: that it dispatches on the row's transport rather than
 * on the provider key, and that it targets googleapis.com rather than Graph.
 */
describe("workspaceProxyForBusiness (direct transport, Google)", () => {
  const googleLink = { connectionId: "direct:goog", providerConfigKey: "google" };
  const googleRow = (over: Record<string, unknown> = {}) =>
    directRow({ provider_config_key: "google", connection_id: "direct:goog", ...over });

  it("calls googleapis.com with the bearer from the Google token manager", async () => {
    mockGetByNangoIds.mockResolvedValue(googleRow());
    mockGetGoogleAccessToken.mockResolvedValue("at-google");
    fetchMock.mockResolvedValue(graph({ messages: [] }));

    const res = await workspaceProxyForBusiness("biz", googleLink, {
      endpoint: "/gmail/v1/users/me/messages",
      method: "GET"
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://www.googleapis.com/gmail/v1/users/me/messages");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer at-google");
    expect(res).toEqual({ status: 200, data: { messages: [] } });
    // The Nango arm must not be consulted for a direct row.
    expect(mockProxy).not.toHaveBeenCalled();
  });

  it("keys the token lookup on the connection ROW id, not the business", async () => {
    // A business can hold several Google accounts; keying on the business would
    // hand one mailbox another's token.
    mockGetByNangoIds.mockResolvedValue(googleRow());
    mockGetGoogleAccessToken.mockResolvedValue("at-google");
    fetchMock.mockResolvedValue(graph({}));
    await workspaceProxyForBusiness("biz", googleLink, { endpoint: "/gmail/v1/users/me/profile" });
    expect(mockGetGoogleAccessToken).toHaveBeenCalledWith(ROW_ID);
  });

  it("returns null when the grant is dead, so callers report not-connected", async () => {
    mockGetByNangoIds.mockResolvedValue(googleRow());
    mockGetGoogleAccessToken.mockResolvedValue(null);
    await expect(
      workspaceProxyForBusiness("biz", googleLink, { endpoint: "/gmail/v1/users/me/profile" })
    ).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still routes a Nango-transport google row through Nango", async () => {
    // The provider key is identical across transports, which is what keeps every
    // resolver transport-blind. Only the column decides.
    mockGetByNangoIds.mockResolvedValue(
      googleRow({ transport: "nango", connection_id: "nango-conn" })
    );
    mockProxy.mockResolvedValue({ status: 200, data: { ok: true } });
    const res = await workspaceProxyForBusiness(
      "biz",
      { connectionId: "nango-conn", providerConfigKey: "google" },
      { endpoint: "/gmail/v1/users/me/profile" }
    );
    expect(res).toEqual({ status: 200, data: { ok: true } });
    expect(mockGetGoogleAccessToken).not.toHaveBeenCalled();
  });

  it("normalizes a Google error response through the status wrapper", async () => {
    mockGetByNangoIds.mockResolvedValue(googleRow());
    mockGetGoogleAccessToken.mockResolvedValue("at-google");
    fetchMock.mockResolvedValue(graph({ error: { message: "Insufficient Permission" } }, 403));
    await expect(
      workspaceProxyStatusForBusiness("biz", googleLink, {
        endpoint: "/gmail/v1/users/me/messages/x/modify",
        method: "POST",
        data: {}
      })
    ).resolves.toEqual({ status: 403, data: { error: { message: "Insufficient Permission" } } });
  });

  it("throws a Google error through the plain proxy, matching the Nango arm", async () => {
    mockGetByNangoIds.mockResolvedValue(googleRow());
    mockGetGoogleAccessToken.mockResolvedValue("at-google");
    fetchMock.mockResolvedValue(graph({ error: { message: "Insufficient Permission" } }, 403));
    await expect(
      workspaceProxyForBusiness("biz", googleLink, { endpoint: "/gmail/v1/users/me/profile" })
    ).rejects.toThrow();
  });
});
