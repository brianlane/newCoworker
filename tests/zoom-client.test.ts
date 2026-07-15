/**
 * Tests for the direct Zoom API client (src/lib/zoom/client.ts): the
 * refresh-managing token accessor (rotation persistence, single-flight,
 * invalid_grant deactivation) and the resolver-compatible request contract.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

const getZoomConnection = vi.fn();
const setZoomConnectionActive = vi.fn();
const updateZoomTokens = vi.fn();
vi.mock("@/lib/db/zoom-connections", () => ({
  getZoomConnection: (...args: unknown[]) => getZoomConnection(...args),
  setZoomConnectionActive: (...args: unknown[]) => setZoomConnectionActive(...args),
  updateZoomTokens: (...args: unknown[]) => updateZoomTokens(...args)
}));

const refreshZoomTokens = vi.fn();
vi.mock("@/lib/zoom/oauth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/zoom/oauth")>();
  return {
    ...actual,
    refreshZoomTokens: (...args: unknown[]) => refreshZoomTokens(...args)
  };
});

import {
  getZoomAccessToken,
  resetZoomRefreshStateForTests,
  zoomApiRequest,
  zoomRequestForBusiness,
  ZOOM_TOKEN_REFRESH_MARGIN_MS
} from "@/lib/zoom/client";
import { ZoomOAuthError } from "@/lib/zoom/oauth";

const fetchMock = vi.fn();

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body)
  } as never;
}

const BIZ = "11111111-1111-4111-8111-111111111111";
const NOW = Date.UTC(2026, 6, 15);

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "zc-1",
    business_id: BIZ,
    accessToken: "live-access",
    refreshToken: "live-refresh",
    // Far future so tests that use the real clock (zoomRequestForBusiness)
    // never trip an unmocked refresh; near-expiry rows override this.
    token_expires_at: "2099-01-01T00:00:00.000Z",
    zoom_user_id: "zu-1",
    account_email: "o@a.com",
    account_name: "Acme",
    is_active: true,
    created_at: "2026-07-01T00:00:00Z",
    updated_at: "2026-07-01T00:00:00Z",
    ...overrides
  };
}

beforeEach(() => {
  fetchMock.mockReset();
  getZoomConnection.mockReset();
  setZoomConnectionActive.mockReset();
  updateZoomTokens.mockReset();
  refreshZoomTokens.mockReset();
  resetZoomRefreshStateForTests();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("getZoomAccessToken", () => {
  it("returns null when no connection exists or the row is soft-disabled", async () => {
    getZoomConnection.mockResolvedValueOnce(null);
    expect(await getZoomAccessToken(BIZ, NOW)).toBeNull();

    getZoomConnection.mockResolvedValueOnce(row({ is_active: false }));
    expect(await getZoomAccessToken(BIZ, NOW)).toBeNull();
    expect(refreshZoomTokens).not.toHaveBeenCalled();
  });

  it("returns the stored token while it has more than the refresh margin left", async () => {
    getZoomConnection.mockResolvedValueOnce(
      row({
        token_expires_at: new Date(NOW + 2 * ZOOM_TOKEN_REFRESH_MARGIN_MS).toISOString()
      })
    );
    expect(await getZoomAccessToken(BIZ, NOW)).toBe("live-access");
    expect(refreshZoomTokens).not.toHaveBeenCalled();
  });

  it("refreshes when expiring, persisting the ROTATED pair before returning", async () => {
    const order: string[] = [];
    getZoomConnection.mockResolvedValueOnce(
      row({ token_expires_at: new Date(NOW + 1000).toISOString() })
    );
    refreshZoomTokens.mockImplementationOnce(async () => {
      order.push("refresh");
      return {
        accessToken: "new-access",
        refreshToken: "new-refresh",
        expiresAt: new Date(NOW + 3_600_000)
      };
    });
    updateZoomTokens.mockImplementationOnce(async () => {
      order.push("persist");
    });

    expect(await getZoomAccessToken(BIZ, NOW)).toBe("new-access");
    expect(refreshZoomTokens).toHaveBeenCalledWith("live-refresh");
    expect(updateZoomTokens).toHaveBeenCalledWith(BIZ, {
      accessToken: "new-access",
      refreshToken: "new-refresh",
      expiresAt: new Date(NOW + 3_600_000)
    });
    expect(order).toEqual(["refresh", "persist"]);
  });

  it("treats an unparseable expiry as expired", async () => {
    getZoomConnection.mockResolvedValueOnce(row({ token_expires_at: "not-a-date" }));
    refreshZoomTokens.mockResolvedValueOnce({
      accessToken: "new-access",
      refreshToken: "new-refresh",
      expiresAt: new Date(NOW + 3_600_000)
    });
    updateZoomTokens.mockResolvedValueOnce(undefined);
    expect(await getZoomAccessToken(BIZ, NOW)).toBe("new-access");
  });

  it("single-flights concurrent refreshes for the same business", async () => {
    getZoomConnection.mockResolvedValue(
      row({ token_expires_at: new Date(NOW + 1000).toISOString() })
    );
    let release: (v: unknown) => void = () => {};
    refreshZoomTokens.mockImplementationOnce(
      () =>
        new Promise((r) => {
          release = () =>
            r({
              accessToken: "new-access",
              refreshToken: "new-refresh",
              expiresAt: new Date(NOW + 3_600_000)
            });
        })
    );
    updateZoomTokens.mockResolvedValue(undefined);

    const first = getZoomAccessToken(BIZ, NOW);
    // Give the first caller a tick to register the in-flight refresh.
    await new Promise((r) => setImmediate(r));
    const second = getZoomAccessToken(BIZ, NOW);
    release(undefined);

    expect(await first).toBe("new-access");
    expect(await second).toBe("new-access");
    expect(refreshZoomTokens).toHaveBeenCalledTimes(1);
  });

  it("deactivates the connection and returns null on invalid_grant", async () => {
    getZoomConnection.mockResolvedValueOnce(
      row({ token_expires_at: new Date(NOW - 1000).toISOString() })
    );
    refreshZoomTokens.mockRejectedValueOnce(
      new ZoomOAuthError("invalid_grant", "Zoom token endpoint failed (401)")
    );
    setZoomConnectionActive.mockResolvedValueOnce(undefined);

    expect(await getZoomAccessToken(BIZ, NOW)).toBeNull();
    expect(setZoomConnectionActive).toHaveBeenCalledWith(BIZ, false);
    expect(updateZoomTokens).not.toHaveBeenCalled();
  });

  it("rethrows transient refresh failures and clears the in-flight slot", async () => {
    getZoomConnection.mockResolvedValue(
      row({ token_expires_at: new Date(NOW - 1000).toISOString() })
    );
    refreshZoomTokens.mockRejectedValueOnce(
      new ZoomOAuthError("upstream_timeout", "Zoom OAuth timed out")
    );
    await expect(getZoomAccessToken(BIZ, NOW)).rejects.toMatchObject({
      code: "upstream_timeout"
    });

    // A later call must retry (the failed promise must not be cached).
    refreshZoomTokens.mockResolvedValueOnce({
      accessToken: "recovered",
      refreshToken: "recovered-refresh",
      expiresAt: new Date(NOW + 3_600_000)
    });
    updateZoomTokens.mockResolvedValueOnce(undefined);
    expect(await getZoomAccessToken(BIZ, NOW)).toBe("recovered");
  });
});

describe("zoomApiRequest", () => {
  it("sends the bearer + params and returns the JSON body", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { meetings: [] }));
    const res = await zoomApiRequest("at", {
      endpoint: "/users/me/meetings",
      method: "GET",
      params: { type: "upcoming" }
    });
    expect(res).toEqual({ data: { meetings: [] } });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.zoom.us/v2/users/me/meetings?type=upcoming");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer at");
    expect(init.body).toBeUndefined();
  });

  it("serializes a JSON body with content-type", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(201, { id: 123 }));
    await zoomApiRequest("at", {
      endpoint: "/users/me/meetings",
      method: "POST",
      data: { topic: "Appointment" }
    });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.body).toBe('{"topic":"Appointment"}');
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/json"
    );
  });

  it("returns null on 401/403 (revoked token)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(401, {}));
    expect(await zoomApiRequest("at", { endpoint: "/users/me", method: "GET" })).toBeNull();

    fetchMock.mockResolvedValueOnce(jsonResponse(403, {}));
    expect(await zoomApiRequest("at", { endpoint: "/users/me", method: "GET" })).toBeNull();
  });

  it("throws request_failed on other non-2xx statuses, tolerating a failed body read", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(429, { message: "rate limited" }));
    await expect(
      zoomApiRequest("at", { endpoint: "/users/me", method: "GET" })
    ).rejects.toMatchObject({ code: "request_failed", status: 429 });

    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 502,
      json: async () => ({}),
      text: async () => {
        throw new Error("stream died");
      }
    } as never);
    await expect(
      zoomApiRequest("at", { endpoint: "/users/me", method: "GET" })
    ).rejects.toMatchObject({ code: "request_failed", status: 502 });
  });

  it("resolves { data: null } for 204s and non-JSON success bodies", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 204,
      json: async () => {
        throw new Error("no body");
      },
      text: async () => ""
    } as never);
    expect(
      await zoomApiRequest("at", { endpoint: "/meetings/123", method: "DELETE" })
    ).toEqual({ data: null });

    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("not json");
      },
      text: async () => "plain"
    } as never);
    expect(await zoomApiRequest("at", { endpoint: "/users/me", method: "GET" })).toEqual({
      data: null
    });
  });

  it("maps aborts and network failures to typed errors", async () => {
    fetchMock.mockRejectedValueOnce(Object.assign(new Error("aborted"), { name: "AbortError" }));
    await expect(
      zoomApiRequest("at", { endpoint: "/users/me", method: "GET" })
    ).rejects.toMatchObject({ code: "upstream_timeout" });

    fetchMock.mockRejectedValueOnce(new Error("down"));
    await expect(
      zoomApiRequest("at", { endpoint: "/users/me", method: "GET" })
    ).rejects.toMatchObject({ code: "upstream_unreachable" });
  });

  it("aborts a hung request at the timeout", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementationOnce(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          (init.signal as AbortSignal).addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        })
    );
    const pending = zoomApiRequest("at", { endpoint: "/users/me", method: "GET" });
    const assertion = expect(pending).rejects.toMatchObject({ code: "upstream_timeout" });
    await vi.advanceTimersByTimeAsync(16_000);
    await assertion;
  });
});

describe("zoomRequestForBusiness", () => {
  it("returns null when the business has no usable connection", async () => {
    getZoomConnection.mockResolvedValueOnce(null);
    expect(
      await zoomRequestForBusiness(BIZ, { endpoint: "/users/me", method: "GET" })
    ).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("resolves the token and makes the call", async () => {
    getZoomConnection.mockResolvedValueOnce(row());
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { id: "zu-1" }));
    expect(
      await zoomRequestForBusiness(BIZ, { endpoint: "/users/me", method: "GET" })
    ).toEqual({ data: { id: "zu-1" } });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer live-access"
    );
  });
});
