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
const updateZoomConnectionIdentity = vi.fn();
vi.mock("@/lib/db/zoom-connections", () => ({
  getZoomConnection: (...args: unknown[]) => getZoomConnection(...args),
  setZoomConnectionActive: (...args: unknown[]) => setZoomConnectionActive(...args),
  updateZoomTokens: (...args: unknown[]) => updateZoomTokens(...args),
  updateZoomConnectionIdentity: (...args: unknown[]) => updateZoomConnectionIdentity(...args)
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
  backfillZoomIdentityIfMissing,
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
    oauth_client_env: "production",
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

  it("returns null for a wiped token pair (deauthorized row force-reactivated)", async () => {
    getZoomConnection.mockResolvedValueOnce(row({ accessToken: "", refreshToken: "" }));
    expect(await getZoomAccessToken(BIZ, NOW)).toBeNull();

    getZoomConnection.mockResolvedValueOnce(row({ refreshToken: "" }));
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

  it("refreshes when expiring, persisting the ROTATED pair (fenced) before returning", async () => {
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
      return true;
    });

    expect(await getZoomAccessToken(BIZ, NOW)).toBe("new-access");
    expect(refreshZoomTokens).toHaveBeenCalledWith("live-refresh", "production");
    expect(updateZoomTokens).toHaveBeenCalledWith(
      BIZ,
      {
        accessToken: "new-access",
        refreshToken: "new-refresh",
        expiresAt: new Date(NOW + 3_600_000)
      },
      "2026-07-01T00:00:00Z"
    );
    expect(order).toEqual(["refresh", "persist"]);
  });

  // A dev-minted grant must keep refreshing against the dev credentials for
  // the life of the connection: presenting the production pair gets an
  // invalid_client 401, which reads as a dead grant and soft-disables a
  // perfectly healthy connection.
  it("refreshes a development-minted row against the development client", async () => {
    getZoomConnection.mockResolvedValueOnce(
      row({
        oauth_client_env: "development",
        token_expires_at: new Date(NOW + 1000).toISOString()
      })
    );
    refreshZoomTokens.mockResolvedValueOnce({
      accessToken: "dev-access",
      refreshToken: "dev-refresh",
      expiresAt: new Date(NOW + 3_600_000)
    });
    updateZoomTokens.mockResolvedValueOnce(true);
    expect(await getZoomAccessToken(BIZ, NOW)).toBe("dev-access");
    expect(refreshZoomTokens).toHaveBeenCalledWith("live-refresh", "development");
  });

  it("treats an unparseable expiry as expired", async () => {
    getZoomConnection.mockResolvedValueOnce(row({ token_expires_at: "not-a-date" }));
    refreshZoomTokens.mockResolvedValueOnce({
      accessToken: "new-access",
      refreshToken: "new-refresh",
      expiresAt: new Date(NOW + 3_600_000)
    });
    updateZoomTokens.mockResolvedValueOnce(true);
    expect(await getZoomAccessToken(BIZ, NOW)).toBe("new-access");
  });

  it("adopts the newer rotation when the persist fence is lost to another instance", async () => {
    getZoomConnection.mockResolvedValueOnce(
      row({ token_expires_at: new Date(NOW + 1000).toISOString() })
    );
    refreshZoomTokens.mockResolvedValueOnce({
      accessToken: "loser-access",
      refreshToken: "loser-refresh",
      expiresAt: new Date(NOW + 3_600_000)
    });
    updateZoomTokens.mockResolvedValueOnce(false);
    getZoomConnection.mockResolvedValueOnce(
      row({ accessToken: "winner-access", updated_at: "2026-07-01T00:00:05Z" })
    );

    expect(await getZoomAccessToken(BIZ, NOW)).toBe("winner-access");
  });

  it("falls back to its own fresh pair when the fence is lost and the re-read is unusable", async () => {
    getZoomConnection.mockResolvedValueOnce(
      row({ token_expires_at: new Date(NOW + 1000).toISOString() })
    );
    refreshZoomTokens.mockResolvedValueOnce({
      accessToken: "fresh-access",
      refreshToken: "fresh-refresh",
      expiresAt: new Date(NOW + 3_600_000)
    });
    updateZoomTokens.mockResolvedValueOnce(false);
    getZoomConnection.mockResolvedValueOnce(null);

    expect(await getZoomAccessToken(BIZ, NOW)).toBe("fresh-access");
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
    updateZoomTokens.mockResolvedValue(true);

    const first = getZoomAccessToken(BIZ, NOW);
    // Give the first caller a tick to register the in-flight refresh.
    await new Promise((r) => setImmediate(r));
    const second = getZoomAccessToken(BIZ, NOW);
    release(undefined);

    expect(await first).toBe("new-access");
    expect(await second).toBe("new-access");
    expect(refreshZoomTokens).toHaveBeenCalledTimes(1);
  });

  it("deactivates the connection and returns null on a genuine invalid_grant", async () => {
    const stale = row({ token_expires_at: new Date(NOW - 1000).toISOString() });
    getZoomConnection.mockResolvedValueOnce(stale);
    refreshZoomTokens.mockRejectedValueOnce(
      new ZoomOAuthError("invalid_grant", "Zoom token endpoint failed (401)")
    );
    // Re-read shows the SAME row (no concurrent rotation happened), the
    // grant really is dead.
    getZoomConnection.mockResolvedValueOnce(stale);
    setZoomConnectionActive.mockResolvedValueOnce(undefined);

    expect(await getZoomAccessToken(BIZ, NOW)).toBeNull();
    expect(setZoomConnectionActive).toHaveBeenCalledWith(BIZ, false);
    expect(updateZoomTokens).not.toHaveBeenCalled();
  });

  it("adopts a concurrent instance's rotation instead of deactivating on invalid_grant", async () => {
    getZoomConnection.mockResolvedValueOnce(
      row({ token_expires_at: new Date(NOW - 1000).toISOString() })
    );
    // Another server consumed the single-use refresh token first…
    refreshZoomTokens.mockRejectedValueOnce(
      new ZoomOAuthError("invalid_grant", "Zoom token endpoint failed (401)")
    );
    // …and its rotation is already on the row.
    getZoomConnection.mockResolvedValueOnce(
      row({ accessToken: "winner-access", updated_at: "2026-07-01T00:00:05Z" })
    );

    expect(await getZoomAccessToken(BIZ, NOW)).toBe("winner-access");
    expect(setZoomConnectionActive).not.toHaveBeenCalled();
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
    updateZoomTokens.mockResolvedValueOnce(true);
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

describe("backfillZoomIdentityIfMissing", () => {
  const PROFILE = { zoomUserId: "zu-9", email: "o@a.com", displayName: "Acme Owner" };

  function backfillDeps(overrides: Record<string, unknown> = {}) {
    return {
      getConnection: vi.fn().mockResolvedValue(row({ zoom_user_id: null })),
      getToken: vi.fn().mockResolvedValue("tok-1"),
      fetchProfile: vi.fn().mockResolvedValue(PROFILE),
      persistIdentity: vi.fn().mockResolvedValue(undefined),
      ...overrides
    } as never;
  }

  it("repairs a null zoom_user_id row from users/me", async () => {
    const deps = backfillDeps();
    expect(await backfillZoomIdentityIfMissing(BIZ, deps)).toBe(true);
    const d = deps as { persistIdentity: ReturnType<typeof vi.fn> };
    expect(d.persistIdentity).toHaveBeenCalledWith(BIZ, {
      zoomUserId: "zu-9",
      email: "o@a.com",
      displayName: "Acme Owner"
    });
  });

  it("no-ops when there is no row, the row is inactive, or identity exists", async () => {
    const missing = backfillDeps({ getConnection: vi.fn().mockResolvedValue(null) });
    expect(await backfillZoomIdentityIfMissing(BIZ, missing)).toBe(false);

    const inactive = backfillDeps({
      getConnection: vi.fn().mockResolvedValue(row({ zoom_user_id: null, is_active: false }))
    });
    expect(await backfillZoomIdentityIfMissing(BIZ, inactive)).toBe(false);

    const healthy = backfillDeps({ getConnection: vi.fn().mockResolvedValue(row()) });
    expect(await backfillZoomIdentityIfMissing(BIZ, healthy)).toBe(false);
    const h = healthy as { getToken: ReturnType<typeof vi.fn> };
    expect(h.getToken).not.toHaveBeenCalled();
  });

  it("no-ops without a usable token or a usable profile", async () => {
    const noToken = backfillDeps({ getToken: vi.fn().mockResolvedValue(null) });
    expect(await backfillZoomIdentityIfMissing(BIZ, noToken)).toBe(false);

    const noProfile = backfillDeps({ fetchProfile: vi.fn().mockResolvedValue(null) });
    expect(await backfillZoomIdentityIfMissing(BIZ, noProfile)).toBe(false);

    const noId = backfillDeps({
      fetchProfile: vi.fn().mockResolvedValue({ ...PROFILE, zoomUserId: null })
    });
    expect(await backfillZoomIdentityIfMissing(BIZ, noId)).toBe(false);
  });

  it("swallows failures (Error and non-Error) and reports false", async () => {
    const throwing = backfillDeps({
      getConnection: vi.fn().mockRejectedValue(new Error("db down"))
    });
    expect(await backfillZoomIdentityIfMissing(BIZ, throwing)).toBe(false);

    const throwingString = backfillDeps({
      persistIdentity: vi.fn().mockRejectedValue("string down")
    });
    expect(await backfillZoomIdentityIfMissing(BIZ, throwingString)).toBe(false);
  });
});
