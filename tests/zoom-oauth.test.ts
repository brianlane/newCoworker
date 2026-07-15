/**
 * Tests for the first-party Zoom OAuth module (src/lib/zoom/oauth.ts):
 * signed-state create/verify, authorize-URL building, code exchange and
 * refresh (rotating tokens), revoke, and the users/me profile fetch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";

import {
  buildZoomAuthorizeUrl,
  createZoomOAuthState,
  exchangeZoomAuthCode,
  fetchZoomUserProfile,
  getZoomOAuthConfig,
  refreshZoomTokens,
  revokeZoomToken,
  verifyZoomOAuthState,
  ZOOM_STATE_TTL_MS
} from "@/lib/zoom/oauth";

const fetchMock = vi.fn();

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body)
  } as never;
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  process.env.ZOOM_CLIENT_ID = "zoom-client-id";
  process.env.ZOOM_CLIENT_SECRET = "zoom-client-secret";
  process.env.NEXT_PUBLIC_APP_URL = "https://www.newcoworker.com/";
  process.env.INTEGRATIONS_ENCRYPTION_KEY = "test-signing-key";
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  delete process.env.ZOOM_CLIENT_ID;
  delete process.env.ZOOM_CLIENT_SECRET;
  delete process.env.NEXT_PUBLIC_APP_URL;
  delete process.env.INTEGRATIONS_ENCRYPTION_KEY;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
});

const BIZ = "11111111-1111-4111-8111-111111111111";

describe("getZoomOAuthConfig", () => {
  it("derives the callback from the app URL, trimming trailing slashes", () => {
    expect(getZoomOAuthConfig()).toEqual({
      clientId: "zoom-client-id",
      clientSecret: "zoom-client-secret",
      redirectUri: "https://www.newcoworker.com/api/integrations/zoom/callback"
    });
  });

  it.each(["ZOOM_CLIENT_ID", "ZOOM_CLIENT_SECRET", "NEXT_PUBLIC_APP_URL"])(
    "throws not_configured when %s is missing",
    (name) => {
      delete process.env[name];
      expect(() => getZoomOAuthConfig()).toThrowError(
        expect.objectContaining({ code: "not_configured" })
      );
    }
  );
});

describe("state signing", () => {
  it("round-trips a businessId", () => {
    const state = createZoomOAuthState(BIZ);
    expect(verifyZoomOAuthState(state)).toEqual({ businessId: BIZ });
  });

  it("rejects an expired state", () => {
    const state = createZoomOAuthState(BIZ, Date.now() - ZOOM_STATE_TTL_MS - 1000);
    expect(verifyZoomOAuthState(state)).toBeNull();
  });

  it("rejects tampered payloads (signature mismatch, same length)", () => {
    const state = createZoomOAuthState(BIZ);
    const [payload, sig] = state.split(".");
    const flipped = payload[0] === "A" ? "B" : "A";
    expect(verifyZoomOAuthState(`${flipped}${payload.slice(1)}.${sig}`)).toBeNull();
  });

  it("rejects a signature of the wrong length", () => {
    const state = createZoomOAuthState(BIZ);
    const [payload] = state.split(".");
    expect(verifyZoomOAuthState(`${payload}.short`)).toBeNull();
  });

  it("rejects malformed states (no dot, leading dot, trailing dot)", () => {
    expect(verifyZoomOAuthState("nodot")).toBeNull();
    expect(verifyZoomOAuthState(".sig")).toBeNull();
    expect(verifyZoomOAuthState("payload.")).toBeNull();
  });

  // Signs arbitrary payloads with the same derivation the module uses, so
  // the JSON/shape guards can be exercised past the signature check.
  function signPayload(payload: string): string {
    const key = createHmac("sha256", "zoom-oauth-state")
      .update("test-signing-key")
      .digest();
    return `${payload}.${createHmac("sha256", key).update(payload).digest("base64url")}`;
  }

  it("rejects a validly-signed payload that is not JSON", () => {
    const junk = Buffer.from("not json", "utf8").toString("base64url");
    expect(verifyZoomOAuthState(signPayload(junk))).toBeNull();
  });

  it("rejects payloads missing the expected fields", () => {
    const sign = signPayload;

    const noB = Buffer.from(JSON.stringify({ e: Date.now() + 60000 })).toString("base64url");
    expect(verifyZoomOAuthState(sign(noB))).toBeNull();

    const noE = Buffer.from(JSON.stringify({ b: BIZ })).toString("base64url");
    expect(verifyZoomOAuthState(sign(noE))).toBeNull();
  });

  it("falls back to the service-role key and throws when no key exists", () => {
    delete process.env.INTEGRATIONS_ENCRYPTION_KEY;
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
    const state = createZoomOAuthState(BIZ);
    expect(verifyZoomOAuthState(state)).toEqual({ businessId: BIZ });

    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    expect(() => createZoomOAuthState(BIZ)).toThrowError(
      expect.objectContaining({ code: "not_configured" })
    );
  });
});

describe("buildZoomAuthorizeUrl", () => {
  it("targets zoom.us/oauth/authorize with our client id, callback, and state", () => {
    const url = new URL(buildZoomAuthorizeUrl("the-state"));
    expect(url.origin + url.pathname).toBe("https://zoom.us/oauth/authorize");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("zoom-client-id");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://www.newcoworker.com/api/integrations/zoom/callback"
    );
    expect(url.searchParams.get("state")).toBe("the-state");
  });
});

describe("exchangeZoomAuthCode", () => {
  it("posts the code with Basic auth and returns the token set", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        access_token: "at-1",
        refresh_token: "rt-1",
        expires_in: 3600
      })
    );
    const now = Date.UTC(2026, 6, 15);
    const tokens = await exchangeZoomAuthCode("the-code", now);
    expect(tokens).toEqual({
      accessToken: "at-1",
      refreshToken: "rt-1",
      expiresAt: new Date(now + 3600 * 1000)
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://zoom.us/oauth/token");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(
      `Basic ${Buffer.from("zoom-client-id:zoom-client-secret").toString("base64")}`
    );
    const params = new URLSearchParams(init.body as string);
    expect(params.get("grant_type")).toBe("authorization_code");
    expect(params.get("code")).toBe("the-code");
    expect(params.get("redirect_uri")).toBe(
      "https://www.newcoworker.com/api/integrations/zoom/callback"
    );
  });

  it("defaults expiry to an hour when expires_in is missing", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { access_token: "at", refresh_token: "rt" })
    );
    const now = Date.UTC(2026, 6, 15);
    const tokens = await exchangeZoomAuthCode("c", now);
    expect(tokens.expiresAt).toEqual(new Date(now + 3600 * 1000));
  });

  it("maps 400/401 to invalid_grant (with Zoom's reason when present)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(400, { reason: "Invalid authorization code" }));
    await expect(exchangeZoomAuthCode("bad")).rejects.toMatchObject({
      code: "invalid_grant",
      message: expect.stringContaining("Invalid authorization code")
    });

    fetchMock.mockResolvedValueOnce(jsonResponse(401, {}));
    await expect(exchangeZoomAuthCode("bad")).rejects.toMatchObject({
      code: "invalid_grant"
    });
  });

  it("maps other failures to request_failed, tolerating a non-JSON body", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(500, { error: "boom" }));
    await expect(exchangeZoomAuthCode("c")).rejects.toMatchObject({
      code: "request_failed",
      status: 500
    });

    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("not json");
      }
    } as never);
    await expect(exchangeZoomAuthCode("c")).rejects.toMatchObject({
      code: "request_failed",
      status: 200
    });
  });

  it("maps aborts to upstream_timeout and network errors to upstream_unreachable", async () => {
    fetchMock.mockRejectedValueOnce(Object.assign(new Error("aborted"), { name: "AbortError" }));
    await expect(exchangeZoomAuthCode("c")).rejects.toMatchObject({
      code: "upstream_timeout"
    });

    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    await expect(exchangeZoomAuthCode("c")).rejects.toMatchObject({
      code: "upstream_unreachable"
    });
  });
});

/** A fetch that hangs until its abort signal fires with an AbortError. */
function hangingFetch() {
  return (_url: string, init: RequestInit) =>
    new Promise((_resolve, reject) => {
      (init.signal as AbortSignal).addEventListener("abort", () => {
        const err = new Error("aborted");
        err.name = "AbortError";
        reject(err);
      });
    });
}

describe("request timeouts", () => {
  it("aborts a hung token exchange at the timeout", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementationOnce(hangingFetch());
    const pending = exchangeZoomAuthCode("c");
    const assertion = expect(pending).rejects.toMatchObject({ code: "upstream_timeout" });
    await vi.advanceTimersByTimeAsync(16_000);
    await assertion;
  });

  it("aborts a hung revoke at the timeout (reported as false)", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementationOnce(hangingFetch());
    const pending = revokeZoomToken("at");
    await vi.advanceTimersByTimeAsync(16_000);
    expect(await pending).toBe(false);
  });

  it("aborts a hung users/me at the timeout", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementationOnce(hangingFetch());
    const pending = fetchZoomUserProfile("at");
    const assertion = expect(pending).rejects.toMatchObject({ code: "upstream_timeout" });
    await vi.advanceTimersByTimeAsync(16_000);
    await assertion;
  });
});

describe("refreshZoomTokens", () => {
  it("posts the refresh grant and returns the ROTATED pair", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        access_token: "at-2",
        refresh_token: "rt-2-rotated",
        expires_in: 1800
      })
    );
    const now = Date.UTC(2026, 6, 15);
    const tokens = await refreshZoomTokens("rt-1", now);
    expect(tokens.refreshToken).toBe("rt-2-rotated");
    expect(tokens.expiresAt).toEqual(new Date(now + 1800 * 1000));

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const params = new URLSearchParams(init.body as string);
    expect(params.get("grant_type")).toBe("refresh_token");
    expect(params.get("refresh_token")).toBe("rt-1");
  });

  it("surfaces invalid_grant for a consumed/revoked refresh token", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(401, { reason: "Invalid Token!" }));
    await expect(refreshZoomTokens("dead")).rejects.toMatchObject({
      code: "invalid_grant"
    });
  });
});

describe("revokeZoomToken", () => {
  it("returns true on a 2xx revoke", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { status: "success" }));
    expect(await revokeZoomToken("at")).toBe(true);
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe("https://zoom.us/oauth/revoke");
  });

  it("returns false on a non-2xx revoke, a network error, or missing config", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(400, {}));
    expect(await revokeZoomToken("at")).toBe(false);

    fetchMock.mockRejectedValueOnce(new Error("down"));
    expect(await revokeZoomToken("at")).toBe(false);

    delete process.env.ZOOM_CLIENT_ID;
    expect(await revokeZoomToken("at")).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("fetchZoomUserProfile", () => {
  it("returns the profile, preferring display_name", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        id: "zu-1",
        email: "owner@acme.com",
        display_name: "Acme Owner",
        first_name: "Ac",
        last_name: "Me"
      })
    );
    expect(await fetchZoomUserProfile("at")).toEqual({
      zoomUserId: "zu-1",
      email: "owner@acme.com",
      displayName: "Acme Owner"
    });
  });

  it("assembles first/last name when display_name is absent or empty", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { id: "zu-1", email: "o@a.com", display_name: "", first_name: "Ac", last_name: "Me" })
    );
    expect((await fetchZoomUserProfile("at"))?.displayName).toBe("Ac Me");
  });

  it("returns null identity fields for an empty/odd body", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { id: 5, email: 7 }));
    expect(await fetchZoomUserProfile("at")).toEqual({
      zoomUserId: null,
      email: null,
      displayName: null
    });

    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("not json");
      }
    } as never);
    expect(await fetchZoomUserProfile("at")).toEqual({
      zoomUserId: null,
      email: null,
      displayName: null
    });
  });

  it("returns null on 401/403 and throws request_failed on other statuses", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(401, {}));
    expect(await fetchZoomUserProfile("at")).toBeNull();

    fetchMock.mockResolvedValueOnce(jsonResponse(403, {}));
    expect(await fetchZoomUserProfile("at")).toBeNull();

    fetchMock.mockResolvedValueOnce(jsonResponse(500, {}));
    await expect(fetchZoomUserProfile("at")).rejects.toMatchObject({
      code: "request_failed",
      status: 500
    });
  });

  it("maps aborts and network failures to typed errors", async () => {
    fetchMock.mockRejectedValueOnce(Object.assign(new Error("aborted"), { name: "AbortError" }));
    await expect(fetchZoomUserProfile("at")).rejects.toMatchObject({
      code: "upstream_timeout"
    });

    fetchMock.mockRejectedValueOnce(new Error("down"));
    await expect(fetchZoomUserProfile("at")).rejects.toMatchObject({
      code: "upstream_unreachable"
    });
  });
});
