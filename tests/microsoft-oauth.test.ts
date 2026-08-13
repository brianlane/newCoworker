/**
 * First-party Microsoft OAuth: signed state, authorize URLs, token exchange,
 * and the Graph identity probe.
 *
 * The cases that matter most are the three deliberate divergences from the
 * Zoom template: the `common` authority, client_secret_post rather than Basic
 * auth, and the scope string carrying Calendars.Read.Shared (getSchedule is
 * NOT covered by Calendars.ReadWrite). Getting any of those wrong fails only
 * against the live provider, where it is expensive to notice.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildMicrosoftAdminConsentUrl,
  buildMicrosoftAuthorizeUrl,
  createMicrosoftOAuthState,
  exchangeMicrosoftAuthCode,
  fetchMicrosoftIdentity,
  getMicrosoftOAuthConfig,
  microsoftOAuthConfigured,
  MicrosoftOAuthError,
  MICROSOFT_REQUEST_TIMEOUT_MS,
  MICROSOFT_SCOPES,
  MICROSOFT_STATE_TTL_MS,
  refreshMicrosoftTokens,
  verifyMicrosoftOAuthState
} from "@/lib/microsoft/oauth";

const BIZ = "11111111-1111-4111-8111-111111111111";
const NOW = 1_760_000_000_000;

const ENV = {
  MICROSOFT_CLIENT_ID: "client-abc",
  MICROSOFT_CLIENT_SECRET: "secret-xyz",
  NEXT_PUBLIC_APP_URL: "https://newcoworker.com",
  INTEGRATIONS_ENCRYPTION_KEY: "unit-test-key"
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v);
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function tokenResponse(over: Record<string, unknown> = {}, status = 200) {
  return new Response(
    JSON.stringify({
      access_token: "at-1",
      refresh_token: "rt-1",
      expires_in: 3600,
      scope: "Mail.Send Mail.ReadWrite",
      ...over
    }),
    { status, headers: { "Content-Type": "application/json" } }
  );
}

/** A minimally valid unsigned id_token carrying the given claims. */
function idToken(claims: Record<string, string>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o), "utf8").toString("base64url");
  return `${b64({ alg: "none" })}.${b64(claims)}.sig`;
}

function formBody(): URLSearchParams {
  const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  return new URLSearchParams(init.body as string);
}

describe("getMicrosoftOAuthConfig", () => {
  it.each(["MICROSOFT_CLIENT_ID", "MICROSOFT_CLIENT_SECRET", "NEXT_PUBLIC_APP_URL"])(
    "throws not_configured without %s",
    (key) => {
      vi.stubEnv(key, "");
      expect(() => getMicrosoftOAuthConfig()).toThrow(MicrosoftOAuthError);
      expect(microsoftOAuthConfigured()).toBe(false);
    }
  );

  it("derives the callback from NEXT_PUBLIC_APP_URL and trims trailing slashes", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://newcoworker.com///");
    expect(getMicrosoftOAuthConfig().redirectUri).toBe(
      "https://newcoworker.com/api/integrations/microsoft/callback"
    );
    expect(microsoftOAuthConfigured()).toBe(true);
  });
});

describe("signed state", () => {
  it("round-trips the business id", () => {
    const state = createMicrosoftOAuthState(BIZ, NOW);
    expect(verifyMicrosoftOAuthState(state, NOW)).toEqual({ businessId: BIZ });
  });

  it("falls back to the service-role key when no dedicated key is set", () => {
    // Deleted, not blanked: the source uses `??`, so an empty string is a
    // present-but-empty key and deliberately does NOT fall back.
    vi.stubEnv("INTEGRATIONS_ENCRYPTION_KEY", undefined);
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role");
    const state = createMicrosoftOAuthState(BIZ, NOW);
    expect(verifyMicrosoftOAuthState(state, NOW)).toEqual({ businessId: BIZ });
  });

  it("throws not_configured when no key is available at all", () => {
    vi.stubEnv("INTEGRATIONS_ENCRYPTION_KEY", undefined);
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", undefined);
    expect(() => createMicrosoftOAuthState(BIZ, NOW)).toThrow(MicrosoftOAuthError);
  });

  it("rejects a state signed with a different key", () => {
    const state = createMicrosoftOAuthState(BIZ, NOW);
    vi.stubEnv("INTEGRATIONS_ENCRYPTION_KEY", "some-other-key");
    expect(verifyMicrosoftOAuthState(state, NOW)).toBeNull();
  });

  it("rejects a SAME-LENGTH bad signature (exercises the timingSafeEqual path)", () => {
    const state = createMicrosoftOAuthState(BIZ, NOW);
    const dot = state.indexOf(".");
    const sig = state.slice(dot + 1);
    // Flip one character, keeping the length identical so the length guard
    // cannot short-circuit and timingSafeEqual actually runs.
    const flipped = (sig[0] === "A" ? "B" : "A") + sig.slice(1);
    expect(verifyMicrosoftOAuthState(`${state.slice(0, dot)}.${flipped}`, NOW)).toBeNull();
  });

  it("rejects a different-length signature", () => {
    const state = createMicrosoftOAuthState(BIZ, NOW);
    expect(verifyMicrosoftOAuthState(`${state.slice(0, state.indexOf("."))}.short`, NOW)).toBeNull();
  });

  it.each([
    ["no dot", "abcdef"],
    ["leading dot", ".sig"],
    ["trailing dot", "payload."]
  ])("rejects a malformed state (%s)", (_label, state) => {
    expect(verifyMicrosoftOAuthState(state, NOW)).toBeNull();
  });

  it("rejects a payload that is not JSON", () => {
    const payload = Buffer.from("not json", "utf8").toString("base64url");
    const state = createMicrosoftOAuthState(BIZ, NOW);
    // Re-sign the bad payload with the real key so only the JSON parse fails.
    const { createHmac } = require("crypto") as typeof import("crypto");
    const key = createHmac("sha256", "microsoft-oauth-state").update(ENV.INTEGRATIONS_ENCRYPTION_KEY).digest();
    const sig = createHmac("sha256", key).update(payload).digest("base64url");
    expect(state).toContain(".");
    expect(verifyMicrosoftOAuthState(`${payload}.${sig}`, NOW)).toBeNull();
  });

  it("rejects a payload with wrong field types", () => {
    const { createHmac } = require("crypto") as typeof import("crypto");
    const key = createHmac("sha256", "microsoft-oauth-state").update(ENV.INTEGRATIONS_ENCRYPTION_KEY).digest();
    for (const bad of [{ b: 1, e: NOW + 1000 }, { b: BIZ, e: "soon" }]) {
      const payload = Buffer.from(JSON.stringify(bad), "utf8").toString("base64url");
      const sig = createHmac("sha256", key).update(payload).digest("base64url");
      expect(verifyMicrosoftOAuthState(`${payload}.${sig}`, NOW)).toBeNull();
    }
  });

  it("rejects an expired state", () => {
    const state = createMicrosoftOAuthState(BIZ, NOW);
    expect(verifyMicrosoftOAuthState(state, NOW + MICROSOFT_STATE_TTL_MS + 1)).toBeNull();
  });
});

describe("buildMicrosoftAuthorizeUrl", () => {
  it("targets the COMMON authority so personal and work accounts both work", () => {
    const url = new URL(buildMicrosoftAuthorizeUrl(createMicrosoftOAuthState(BIZ, NOW)));
    expect(url.origin + url.pathname).toBe(
      "https://login.microsoftonline.com/common/oauth2/v2.0/authorize"
    );
  });

  it("requests offline_access and Calendars.Read.Shared", () => {
    const url = new URL(buildMicrosoftAuthorizeUrl(createMicrosoftOAuthState(BIZ, NOW)));
    const scope = (url.searchParams.get("scope") ?? "").split(" ");
    // offline_access is what yields a refresh token at all; Calendars.Read.Shared
    // is what makes /me/calendar/getSchedule (free/busy) work.
    expect(scope).toContain("offline_access");
    expect(scope).toContain("Calendars.Read.Shared");
    expect(scope).toEqual([...MICROSOFT_SCOPES]);
  });

  it("carries client id, redirect, state and response_mode", () => {
    const state = createMicrosoftOAuthState(BIZ, NOW);
    const url = new URL(buildMicrosoftAuthorizeUrl(state));
    expect(url.searchParams.get("client_id")).toBe(ENV.MICROSOFT_CLIENT_ID);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("response_mode")).toBe("query");
    expect(url.searchParams.get("state")).toBe(state);
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://newcoworker.com/api/integrations/microsoft/callback"
    );
  });

  it("defaults to prompt=select_account so a second mailbox can be added", () => {
    const url = new URL(buildMicrosoftAuthorizeUrl(createMicrosoftOAuthState(BIZ, NOW)));
    expect(url.searchParams.get("prompt")).toBe("select_account");
  });

  it("uses prompt=consent when a reconnect forces a fresh refresh token", () => {
    const url = new URL(
      buildMicrosoftAuthorizeUrl(createMicrosoftOAuthState(BIZ, NOW), { forceConsent: true })
    );
    expect(url.searchParams.get("prompt")).toBe("consent");
  });
});

describe("buildMicrosoftAdminConsentUrl", () => {
  it("targets ORGANIZATIONS, since admin consent is a work/school concept", () => {
    const url = new URL(buildMicrosoftAdminConsentUrl(createMicrosoftOAuthState(BIZ, NOW)));
    expect(url.origin + url.pathname).toBe(
      "https://login.microsoftonline.com/organizations/adminconsent"
    );
    expect(url.searchParams.get("client_id")).toBe(ENV.MICROSOFT_CLIENT_ID);
  });
});

describe("token endpoint", () => {
  it("authenticates with client_secret_post, NOT HTTP Basic", async () => {
    fetchMock.mockResolvedValue(tokenResponse());

    await exchangeMicrosoftAuthCode("code-1", NOW);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://login.microsoftonline.com/common/oauth2/v2.0/token");
    // Copying Zoom's Basic header here yields invalid_client.
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
    const body = formBody();
    expect(body.get("client_id")).toBe(ENV.MICROSOFT_CLIENT_ID);
    expect(body.get("client_secret")).toBe(ENV.MICROSOFT_CLIENT_SECRET);
  });

  it("exchanges an auth code with the redirect uri", async () => {
    fetchMock.mockResolvedValue(tokenResponse());

    const tokens = await exchangeMicrosoftAuthCode("code-1", NOW);

    const body = formBody();
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("code-1");
    expect(body.get("redirect_uri")).toBe(
      "https://newcoworker.com/api/integrations/microsoft/callback"
    );
    expect(tokens).toEqual({
      accessToken: "at-1",
      refreshToken: "rt-1",
      expiresAt: new Date(NOW + 3600 * 1000),
      scope: "Mail.Send Mail.ReadWrite",
      idTokenEmail: null
    });
  });

  it("refreshes with the rotated token and re-sends the scope", async () => {
    fetchMock.mockResolvedValue(tokenResponse({ refresh_token: "rt-2" }));

    const tokens = await refreshMicrosoftTokens("rt-1", NOW);

    const body = formBody();
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("rt-1");
    expect(body.get("scope")).toBe(MICROSOFT_SCOPES.join(" "));
    // Microsoft rotates: the caller must persist the NEW one.
    expect(tokens.refreshToken).toBe("rt-2");
  });

  it("defaults the expiry to an hour when expires_in is absent", async () => {
    fetchMock.mockResolvedValue(tokenResponse({ expires_in: undefined }));
    const tokens = await exchangeMicrosoftAuthCode("c", NOW);
    expect(tokens.expiresAt).toEqual(new Date(NOW + 3600 * 1000));
  });

  it("stores an empty scope when the provider omits it", async () => {
    fetchMock.mockResolvedValue(tokenResponse({ scope: undefined }));
    expect((await exchangeMicrosoftAuthCode("c", NOW)).scope).toBe("");
  });

  it("maps error invalid_grant to invalid_grant (the only deactivating code)", async () => {
    fetchMock.mockResolvedValue(
      tokenResponse({ access_token: undefined, error: "invalid_grant" }, 400)
    );

    const err = await refreshMicrosoftTokens("rt-1", NOW).catch((e: unknown) => e);
    expect((err as MicrosoftOAuthError).code).toBe("invalid_grant");
  });

  it.each(["consent_required", "interaction_required"])(
    "maps %s to consent_required",
    async (error) => {
      fetchMock.mockResolvedValue(tokenResponse({ access_token: undefined, error }, 400));
      const err = await refreshMicrosoftTokens("rt-1", NOW).catch((e: unknown) => e);
      expect((err as MicrosoftOAuthError).code).toBe("consent_required");
    }
  );

  it("keeps invalid_client as request_failed so OUR misconfig never deactivates tenants", async () => {
    fetchMock.mockResolvedValue(
      tokenResponse(
        { access_token: undefined, error: "invalid_client", error_description: "bad secret" },
        401
      )
    );

    const err = await refreshMicrosoftTokens("rt-1", NOW).catch((e: unknown) => e);
    expect((err as MicrosoftOAuthError).code).toBe("request_failed");
    expect((err as MicrosoftOAuthError).status).toBe(401);
    expect((err as Error).message).toContain("bad secret");
  });

  it.each([
    ["access_token", { access_token: undefined }],
    ["refresh_token", { refresh_token: undefined }]
  ])("treats a 200 missing %s as request_failed", async (_label, over) => {
    fetchMock.mockResolvedValue(tokenResponse(over));
    const err = await exchangeMicrosoftAuthCode("c", NOW).catch((e: unknown) => e);
    expect((err as MicrosoftOAuthError).code).toBe("request_failed");
  });

  it("treats an unparseable body as request_failed", async () => {
    fetchMock.mockResolvedValue(new Response("<html>", { status: 500 }));
    const err = await exchangeMicrosoftAuthCode("c", NOW).catch((e: unknown) => e);
    expect((err as MicrosoftOAuthError).code).toBe("request_failed");
  });

  it("maps an abort to upstream_timeout", async () => {
    const abort = new Error("aborted");
    abort.name = "AbortError";
    fetchMock.mockRejectedValue(abort);
    const err = await exchangeMicrosoftAuthCode("c", NOW).catch((e: unknown) => e);
    expect((err as MicrosoftOAuthError).code).toBe("upstream_timeout");
  });

  it("maps a network failure to upstream_unreachable", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    const err = await exchangeMicrosoftAuthCode("c", NOW).catch((e: unknown) => e);
    expect((err as MicrosoftOAuthError).code).toBe("upstream_unreachable");
  });

  it("aborts a hung token request once the budget elapses", async () => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      fetchMock.mockImplementation((_url: string, init: RequestInit) => {
        signal = init.signal as AbortSignal;
        return new Promise(() => {});
      });

      void exchangeMicrosoftAuthCode("c", NOW).catch(() => {});
      await Promise.resolve();
      expect(signal?.aborted).toBe(false);

      vi.advanceTimersByTime(MICROSOFT_REQUEST_TIMEOUT_MS);
      expect(signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("fetchMicrosoftIdentity", () => {
  function graph(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" }
    });
  }

  it("prefers mail and carries id + displayName", async () => {
    fetchMock.mockResolvedValue(
      graph({ id: "u1", mail: "sam@acme.com", userPrincipalName: "sam@acme.onmicrosoft.com", displayName: "Sam" })
    );

    await expect(fetchMicrosoftIdentity("at")).resolves.toEqual({
      accountId: "u1",
      email: "sam@acme.com",
      displayName: "Sam"
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    // $select is explicit so otherMails comes back; personal accounts need it.
    expect(url).toContain("https://graph.microsoft.com/v1.0/me?$select=");
    expect(url).toContain("otherMails");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer at");
  });

  it("falls back to userPrincipalName when mail is null", async () => {
    // Accounts with no Exchange mailbox report mail: null.
    fetchMock.mockResolvedValue(graph({ id: "u1", mail: null, userPrincipalName: "sam@acme.onmicrosoft.com" }));
    const identity = await fetchMicrosoftIdentity("at");
    expect(identity?.email).toBe("sam@acme.onmicrosoft.com");
    expect(identity?.displayName).toBeNull();
  });

  it("returns a null email when neither field is present", async () => {
    fetchMock.mockResolvedValue(graph({ id: "u1" }));
    await expect(fetchMicrosoftIdentity("at")).resolves.toEqual({
      accountId: "u1",
      email: null,
      displayName: null
    });
  });

  it("ignores empty-string fields", async () => {
    fetchMock.mockResolvedValue(graph({ id: "u1", mail: "", userPrincipalName: "", displayName: "" }));
    const identity = await fetchMicrosoftIdentity("at");
    expect(identity?.email).toBeNull();
    expect(identity?.displayName).toBeNull();
  });

  it("returns null shape fields for an unparseable body", async () => {
    fetchMock.mockResolvedValue(new Response("nope", { status: 200 }));
    await expect(fetchMicrosoftIdentity("at")).resolves.toEqual({
      accountId: null,
      email: null,
      displayName: null
    });
  });

  it.each([401, 403])("returns null on %i (token rejected)", async (status) => {
    fetchMock.mockResolvedValue(graph({}, status));
    await expect(fetchMicrosoftIdentity("at")).resolves.toBeNull();
  });

  it("throws request_failed on other errors", async () => {
    fetchMock.mockResolvedValue(graph({}, 500));
    const err = await fetchMicrosoftIdentity("at").catch((e: unknown) => e);
    expect((err as MicrosoftOAuthError).code).toBe("request_failed");
  });

  it("maps an abort to upstream_timeout", async () => {
    const abort = new Error("aborted");
    abort.name = "AbortError";
    fetchMock.mockRejectedValue(abort);
    const err = await fetchMicrosoftIdentity("at").catch((e: unknown) => e);
    expect((err as MicrosoftOAuthError).code).toBe("upstream_timeout");
  });

  it("maps a network failure to upstream_unreachable", async () => {
    fetchMock.mockRejectedValue(new Error("boom"));
    const err = await fetchMicrosoftIdentity("at").catch((e: unknown) => e);
    expect((err as MicrosoftOAuthError).code).toBe("upstream_unreachable");
  });

  it("aborts a hung identity probe once the budget elapses", async () => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      fetchMock.mockImplementation((_url: string, init: RequestInit) => {
        signal = init.signal as AbortSignal;
        return new Promise(() => {});
      });

      void fetchMicrosoftIdentity("at").catch(() => {});
      await Promise.resolve();
      expect(signal?.aborted).toBe(false);

      vi.advanceTimersByTime(MICROSOFT_REQUEST_TIMEOUT_MS);
      expect(signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

describe("personal Microsoft accounts (the synthetic UPN)", () => {
  // A personal account comes back with mail: null and a synthetic
  // userPrincipalName of the form outlook_<CID>@outlook.com. It is unique and
  // stable, so it works as an identifier, but showing it on the integrations
  // page tells the owner nothing: they expect the address they signed in with.
  const SYNTHETIC = "outlook_5C3966BE918A1C30@outlook.com";

  function graph(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" }
    });
  }

  it("prefers the id_token email over the synthetic UPN", async () => {
    fetchMock.mockResolvedValue(
      graph({ id: "u1", mail: null, userPrincipalName: SYNTHETIC, displayName: "Brian" })
    );

    const identity = await fetchMicrosoftIdentity("at", "team@newcoworker.com");

    expect(identity?.email).toBe("team@newcoworker.com");
    expect(identity?.accountId).toBe("u1");
  });

  it("falls back to otherMails when there is no id_token email", async () => {
    fetchMock.mockResolvedValue(
      graph({ id: "u1", mail: null, userPrincipalName: SYNTHETIC, otherMails: ["team@newcoworker.com"] })
    );
    await expect(fetchMicrosoftIdentity("at")).resolves.toMatchObject({
      email: "team@newcoworker.com"
    });
  });

  it("still returns the synthetic UPN as a LAST resort rather than nothing", async () => {
    // The callback refuses to store a connection without an identity, so an
    // ugly address beats no address.
    fetchMock.mockResolvedValue(graph({ id: "u1", mail: null, userPrincipalName: SYNTHETIC }));
    await expect(fetchMicrosoftIdentity("at")).resolves.toMatchObject({ email: SYNTHETIC });
  });

  it("keeps Graph mail ahead of the id_token, for work accounts", async () => {
    fetchMock.mockResolvedValue(graph({ id: "u1", mail: "sam@acme.com", userPrincipalName: "sam@acme.onmicrosoft.com" }));
    await expect(fetchMicrosoftIdentity("at", "stale@acme.com")).resolves.toMatchObject({
      email: "sam@acme.com"
    });
  });

  it("ignores a malformed otherMails rather than throwing", async () => {
    fetchMock.mockResolvedValue(
      graph({ id: "u1", mail: null, userPrincipalName: SYNTHETIC, otherMails: [42, ""] })
    );
    await expect(fetchMicrosoftIdentity("at")).resolves.toMatchObject({ email: SYNTHETIC });
  });

  it("asks Graph for otherMails explicitly", async () => {
    fetchMock.mockResolvedValue(graph({ id: "u1", mail: "a@b.com" }));
    await fetchMicrosoftIdentity("at");
    expect((fetchMock.mock.calls[0] as [string, RequestInit])[0]).toContain("otherMails");
  });
});

describe("id_token email extraction", () => {
  it("carries the email claim through the token exchange", async () => {
    fetchMock.mockResolvedValue(
      tokenResponse({ id_token: idToken({ email: "team@newcoworker.com" }) })
    );
    const tokens = await exchangeMicrosoftAuthCode("c", NOW);
    expect(tokens.idTokenEmail).toBe("team@newcoworker.com");
  });

  it("falls back to preferred_username, which work tokens tend to carry", async () => {
    fetchMock.mockResolvedValue(
      tokenResponse({ id_token: idToken({ preferred_username: "sam@acme.com" }) })
    );
    await expect(exchangeMicrosoftAuthCode("c", NOW)).resolves.toMatchObject({
      idTokenEmail: "sam@acme.com"
    });
  });

  it.each([
    ["absent", undefined],
    ["not a JWT", "garbage"],
    ["undecodable payload", "aaa.!!!not-base64!!!.sig"],
    ["no email claims", `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from('{"sub":"x"}').toString("base64url")}.sig`]
  ])("degrades to null when the id_token is %s", async (_label, token) => {
    // Only ever used to LABEL a mailbox, never to authorize, so a bad token
    // must not fail the connect.
    fetchMock.mockResolvedValue(tokenResponse({ id_token: token }));
    await expect(exchangeMicrosoftAuthCode("c", NOW)).resolves.toMatchObject({
      idTokenEmail: null
    });
  });
});

});
