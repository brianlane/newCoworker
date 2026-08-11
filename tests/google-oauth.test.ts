import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildGoogleAuthorizeUrl,
  createGoogleOAuthState,
  exchangeGoogleAuthCode,
  getGoogleOAuthConfig,
  GOOGLE_REQUEST_TIMEOUT_MS,
  GOOGLE_REVOKE_URL,
  GOOGLE_TOKEN_URL,
  GoogleOAuthError,
  refreshGoogleTokens,
  revokeGoogleToken,
  verifyGoogleOAuthState
} from "@/lib/google/oauth";
import { GOOGLE_WORKSPACE_SCOPES } from "@/lib/google/workspace-scopes";

const ORIGINAL_ENV = { ...process.env };

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  } as unknown as Response;
}

function setEnv() {
  process.env.GOOGLE_WORKSPACE_CLIENT_ID = "354099628168-test.apps.googleusercontent.com";
  process.env.GOOGLE_WORKSPACE_CLIENT_SECRET = "test-secret";
  process.env.NEXT_PUBLIC_APP_URL = "https://www.newcoworker.com";
  process.env.INTEGRATIONS_ENCRYPTION_KEY = "test-signing-key";
}

describe("lib/google/oauth", () => {
  beforeEach(() => {
    setEnv();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  describe("state", () => {
    it("round-trips the business", () => {
      const state = createGoogleOAuthState("biz-1");
      expect(verifyGoogleOAuthState(state)).toEqual({ businessId: "biz-1" });
    });

    it("refuses a tampered or expired state", () => {
      expect(verifyGoogleOAuthState("garbage")).toBeNull();
      const t0 = 1_000_000;
      const state = createGoogleOAuthState("biz-1", t0);
      expect(verifyGoogleOAuthState(state, t0 + 11 * 60 * 1000)).toBeNull();
    });

    it("throws not_configured when there is no signing key", () => {
      delete process.env.INTEGRATIONS_ENCRYPTION_KEY;
      delete process.env.SUPABASE_SERVICE_ROLE_KEY;
      expect(() => createGoogleOAuthState("biz-1")).toThrow(GoogleOAuthError);
    });
  });

  describe("getGoogleOAuthConfig", () => {
    it("builds the redirect URI from the app URL", () => {
      expect(getGoogleOAuthConfig().redirectUri).toBe(
        "https://www.newcoworker.com/api/auth/callback/google"
      );
    });

    it("strips a trailing slash so the URI matches the registered one exactly", () => {
      // Google compares redirect URIs byte for byte; a double slash is a
      // redirect_uri_mismatch, not a warning.
      process.env.NEXT_PUBLIC_APP_URL = "https://www.newcoworker.com///";
      expect(getGoogleOAuthConfig().redirectUri).toBe(
        "https://www.newcoworker.com/api/auth/callback/google"
      );
    });

    it.each([
      ["client id", "GOOGLE_WORKSPACE_CLIENT_ID"],
      ["client secret", "GOOGLE_WORKSPACE_CLIENT_SECRET"],
      ["app url", "NEXT_PUBLIC_APP_URL"]
    ])("throws not_configured without the %s", (_label, key) => {
      delete process.env[key];
      expect(() => getGoogleOAuthConfig()).toThrow(GoogleOAuthError);
      try {
        getGoogleOAuthConfig();
      } catch (err) {
        expect((err as GoogleOAuthError).code).toBe("not_configured");
      }
    });

    it("treats whitespace-only credentials as absent", () => {
      process.env.GOOGLE_WORKSPACE_CLIENT_ID = "   ";
      expect(() => getGoogleOAuthConfig()).toThrow(GoogleOAuthError);
    });
  });

  describe("buildGoogleAuthorizeUrl", () => {
    it("requests exactly the frozen scope set", () => {
      const url = new URL(buildGoogleAuthorizeUrl("state-123"));
      expect(url.searchParams.get("scope")?.split(" ")).toEqual([...GOOGLE_WORKSPACE_SCOPES]);
    });

    it("asks for offline access and forces the consent screen", () => {
      // Without both, a re-authorization returns no refresh token and the
      // connection cannot survive its first hour.
      const url = new URL(buildGoogleAuthorizeUrl("state-123"));
      expect(url.searchParams.get("access_type")).toBe("offline");
      expect(url.searchParams.get("prompt")).toBe("consent");
    });

    it("disables incremental authorization", () => {
      // include_granted_scopes would let a grant accumulate scopes we never
      // declared, which verification cannot survive.
      const url = new URL(buildGoogleAuthorizeUrl("state-123"));
      expect(url.searchParams.get("include_granted_scopes")).toBe("false");
    });

    it("carries the client id, redirect URI, response type and state", () => {
      const url = new URL(buildGoogleAuthorizeUrl("state-123"));
      expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
      expect(url.searchParams.get("client_id")).toBe(
        "354099628168-test.apps.googleusercontent.com"
      );
      expect(url.searchParams.get("redirect_uri")).toBe(
        "https://www.newcoworker.com/api/auth/callback/google"
      );
      expect(url.searchParams.get("response_type")).toBe("code");
      expect(url.searchParams.get("state")).toBe("state-123");
    });
  });

  describe("exchangeGoogleAuthCode", () => {
    it("returns the token set and the GRANTED scope", () => {
      const granted = "openid https://www.googleapis.com/auth/gmail.modify";
      vi.spyOn(global, "fetch").mockResolvedValue(
        jsonResponse(200, {
          access_token: "at",
          refresh_token: "rt",
          expires_in: 3599,
          scope: granted
        })
      );
      return expect(exchangeGoogleAuthCode("code-1", 1_000_000)).resolves.toEqual({
        accessToken: "at",
        refreshToken: "rt",
        expiresAt: new Date(1_000_000 + 3599 * 1000),
        grantedScope: granted
      });
    });

    it("posts form-encoded credentials to the token endpoint", async () => {
      const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(
        jsonResponse(200, { access_token: "at", refresh_token: "rt" })
      );
      await exchangeGoogleAuthCode("code-1");
      const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(GOOGLE_TOKEN_URL);
      expect((init.headers as Record<string, string>)["Content-Type"]).toBe(
        "application/x-www-form-urlencoded"
      );
      const body = new URLSearchParams(init.body as string);
      expect(body.get("grant_type")).toBe("authorization_code");
      expect(body.get("code")).toBe("code-1");
      expect(body.get("client_secret")).toBe("test-secret");
      expect(body.get("redirect_uri")).toBe(
        "https://www.newcoworker.com/api/auth/callback/google"
      );
    });

    it("defaults the expiry when Google omits expires_in", async () => {
      vi.spyOn(global, "fetch").mockResolvedValue(
        jsonResponse(200, { access_token: "at", refresh_token: "rt" })
      );
      const set = await exchangeGoogleAuthCode("code-1", 1_000_000);
      expect(set.expiresAt).toEqual(new Date(1_000_000 + 3600 * 1000));
      expect(set.grantedScope).toBeNull();
    });

    it("refuses an exchange that returns no refresh token", async () => {
      // prompt=consent did not take. Storing this would create a connection
      // that dies within the hour with no recovery the owner could predict.
      vi.spyOn(global, "fetch").mockResolvedValue(jsonResponse(200, { access_token: "at" }));
      await expect(exchangeGoogleAuthCode("code-1")).rejects.toThrow(/no refresh token/);
    });
  });

  describe("refreshGoogleTokens", () => {
    it("returns a null refresh token, because Google does not rotate", async () => {
      vi.spyOn(global, "fetch").mockResolvedValue(
        jsonResponse(200, { access_token: "at2", expires_in: 3600 })
      );
      const set = await refreshGoogleTokens("rt", 2_000_000);
      expect(set.accessToken).toBe("at2");
      expect(set.refreshToken).toBeNull();
    });

    it("sends the refresh grant with the stored token", async () => {
      const fetchSpy = vi
        .spyOn(global, "fetch")
        .mockResolvedValue(jsonResponse(200, { access_token: "at2" }));
      await refreshGoogleTokens("rt-stored");
      const body = new URLSearchParams((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
      expect(body.get("grant_type")).toBe("refresh_token");
      expect(body.get("refresh_token")).toBe("rt-stored");
    });
  });

  describe("token endpoint failures", () => {
    it("classifies invalid_grant as invalid_grant, the only code that may deactivate", async () => {
      vi.spyOn(global, "fetch").mockResolvedValue(
        jsonResponse(400, { error: "invalid_grant", error_description: "Token has been expired" })
      );
      await expect(refreshGoogleTokens("rt")).rejects.toMatchObject({
        code: "invalid_grant",
        status: 400
      });
    });

    it("classifies invalid_client as request_failed, NOT invalid_grant", async () => {
      // invalid_client means OUR credentials are wrong, which is what a botched
      // secret rotation looks like. Treating it as invalid_grant would
      // soft-disable every tenant whose grant is perfectly healthy.
      vi.spyOn(global, "fetch").mockResolvedValue(
        jsonResponse(401, { error: "invalid_client", error_description: "Unauthorized" })
      );
      await expect(refreshGoogleTokens("rt")).rejects.toMatchObject({
        code: "request_failed",
        status: 401
      });
    });

    it("treats a 200 with no access token as request_failed", async () => {
      vi.spyOn(global, "fetch").mockResolvedValue(jsonResponse(200, { scope: "openid" }));
      await expect(refreshGoogleTokens("rt")).rejects.toMatchObject({ code: "request_failed" });
    });

    it("survives an unparseable body", async () => {
      vi.spyOn(global, "fetch").mockResolvedValue({
        ok: false,
        status: 502,
        json: async () => {
          throw new Error("not json");
        }
      } as unknown as Response);
      await expect(refreshGoogleTokens("rt")).rejects.toMatchObject({
        code: "request_failed",
        status: 502
      });
    });

    it("maps an abort to upstream_timeout", async () => {
      const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
      vi.spyOn(global, "fetch").mockRejectedValue(abort);
      await expect(refreshGoogleTokens("rt")).rejects.toMatchObject({ code: "upstream_timeout" });
    });

    it("actually aborts a hung request once the budget elapses", async () => {
      // Asserting that an AbortError maps to upstream_timeout only proves the
      // mapping. This proves the timer fires and aborts the signal, which is
      // what stops a stuck Google endpoint from holding a request open.
      vi.useFakeTimers();
      try {
        vi.spyOn(global, "fetch").mockImplementation(
          (_url, init) =>
            new Promise((_resolve, reject) => {
              (init as RequestInit).signal?.addEventListener("abort", () => {
                reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
              });
            })
        );
        const pending = refreshGoogleTokens("rt");
        const assertion = expect(pending).rejects.toMatchObject({ code: "upstream_timeout" });
        await vi.advanceTimersByTimeAsync(GOOGLE_REQUEST_TIMEOUT_MS + 1);
        await assertion;
      } finally {
        vi.useRealTimers();
      }
    });

    it("maps a network failure to upstream_unreachable", async () => {
      vi.spyOn(global, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));
      await expect(refreshGoogleTokens("rt")).rejects.toMatchObject({
        code: "upstream_unreachable"
      });
    });
  });

  describe("revokeGoogleToken", () => {
    it("posts the token to the revoke endpoint", async () => {
      const fetchSpy = vi
        .spyOn(global, "fetch")
        .mockResolvedValue(jsonResponse(200, {}));
      await expect(revokeGoogleToken("rt")).resolves.toBe(true);
      const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(GOOGLE_REVOKE_URL);
      expect(new URLSearchParams(init.body as string).get("token")).toBe("rt");
    });

    it("treats an already-revoked token as success", async () => {
      // 400/invalid_token means the desired end state already holds.
      vi.spyOn(global, "fetch").mockResolvedValue(jsonResponse(400, { error: "invalid_token" }));
      await expect(revokeGoogleToken("rt")).resolves.toBe(true);
    });

    it("reports failure for other errors without throwing", async () => {
      vi.spyOn(global, "fetch").mockResolvedValue(jsonResponse(500, {}));
      await expect(revokeGoogleToken("rt")).resolves.toBe(false);
    });

    it("never throws when Google is unreachable", async () => {
      // A disconnect has to succeed locally even during a Google outage, or an
      // owner cannot remove a connection.
      vi.spyOn(global, "fetch").mockRejectedValue(new Error("offline"));
      await expect(revokeGoogleToken("rt")).resolves.toBe(false);
    });

    it("gives up on a hung revoke instead of hanging the disconnect", async () => {
      vi.useFakeTimers();
      try {
        vi.spyOn(global, "fetch").mockImplementation(
          (_url, init) =>
            new Promise((_resolve, reject) => {
              (init as RequestInit).signal?.addEventListener("abort", () => {
                reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
              });
            })
        );
        const pending = revokeGoogleToken("rt");
        const assertion = expect(pending).resolves.toBe(false);
        await vi.advanceTimersByTimeAsync(GOOGLE_REQUEST_TIMEOUT_MS + 1);
        await assertion;
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
