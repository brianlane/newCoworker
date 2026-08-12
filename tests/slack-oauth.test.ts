/**
 * Tests for the Slack OAuth module (src/lib/slack/oauth.ts).
 *
 * What matters: the signed state binds the authorize round-trip to one
 * business and expires (a tampered or stale state must verify to null, not
 * throw), the code exchange distinguishes a dead grant from our own config
 * mistakes, and revoke is best-effort by contract (never throws).
 */
import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildSlackAuthorizeUrl,
  createSlackOAuthState,
  exchangeSlackAuthCode,
  getSlackOAuthConfig,
  revokeSlackToken,
  SLACK_BOT_SCOPES,
  SLACK_REQUEST_TIMEOUT_MS,
  SLACK_STATE_TTL_MS,
  SlackOAuthError,
  verifySlackOAuthState
} from "@/lib/slack/oauth";

const BIZ = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  vi.stubEnv("SLACK_CLIENT_ID", "client-123");
  vi.stubEnv("SLACK_CLIENT_SECRET", "secret-456");
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.example.com/");
  vi.stubEnv("INTEGRATIONS_ENCRYPTION_KEY", "state-signing-key");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("getSlackOAuthConfig", () => {
  it("derives the callback from NEXT_PUBLIC_APP_URL without trailing slashes", () => {
    expect(getSlackOAuthConfig()).toEqual({
      clientId: "client-123",
      clientSecret: "secret-456",
      redirectUri: "https://app.example.com/api/integrations/slack/callback"
    });
  });

  it("throws not_configured when any of the three env vars is missing", () => {
    for (const key of ["SLACK_CLIENT_ID", "SLACK_CLIENT_SECRET", "NEXT_PUBLIC_APP_URL"]) {
      vi.stubEnv("SLACK_CLIENT_ID", "client-123");
      vi.stubEnv("SLACK_CLIENT_SECRET", "secret-456");
      vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.example.com");
      vi.stubEnv(key, "");
      try {
        getSlackOAuthConfig();
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(SlackOAuthError);
        expect((err as SlackOAuthError).code).toBe("not_configured");
      }
    }
  });
});

/**
 * Guards the migration onto the shared codec in `src/lib/oauth/state.ts`.
 *
 * Minting and verifying with the same code passes regardless of what the wire
 * format became, so it says nothing about an owner who is mid-install across a
 * deploy: their state was signed by the OLD build. This state was captured from
 * the implementation as it stood before the shared codec, with a known key at a
 * fixed timestamp, and pasted in verbatim. Nothing here can regenerate it, which
 * is exactly why it is worth having.
 */
describe("a state minted before the shared-codec migration still verifies", () => {
  const GOLDEN_KEY = "golden-state-key";
  const T0 = 1_770_000_000_000;
  const GOLDEN =
    "eyJiIjoiYml6LWdvbGRlbi0zIiwiZSI6MTc3MDAwMDYwMDAwMCwibiI6IkxQNVFCUFB5bFBFIn0.HqfqFDTyw0CEGNfOLVQ2Pr-Al4YzepPBkEeov9EtXKQ";

  beforeEach(() => {
    vi.stubEnv("INTEGRATIONS_ENCRYPTION_KEY", GOLDEN_KEY);
  });

  it("accepts it and returns the bound business", () => {
    expect(verifySlackOAuthState(GOLDEN, T0 + 1_000)).toEqual({ businessId: "biz-golden-3" });
  });

  it("still expires it on the original schedule", () => {
    expect(verifySlackOAuthState(GOLDEN, T0 + SLACK_STATE_TTL_MS + 1)).toBeNull();
  });

  it("refuses it under a different signing key", () => {
    vi.stubEnv("INTEGRATIONS_ENCRYPTION_KEY", "some-other-key");
    expect(verifySlackOAuthState(GOLDEN, T0 + 1_000)).toBeNull();
  });

  it("does not verify a Zoom-labelled state, so the domains stay separated", () => {
    // Both labels derive from the same platform secret. Without domain
    // separation a Zoom state would satisfy a Slack callback.
    const zoomGolden =
      "eyJiIjoiYml6LWdvbGRlbi0xIiwiZSI6MTc3MDAwMDYwMDAwMCwibiI6IjhlbmRhZGdSd2E4In0.2SNsAf9zkePnSkqrpgO2WC72glFZUViv2HUk6NEgV50";
    expect(verifySlackOAuthState(zoomGolden, T0 + 1_000)).toBeNull();
  });
});

describe("state round-trip", () => {
  it("verifies a fresh state back to its business", () => {
    const state = createSlackOAuthState(BIZ);
    expect(verifySlackOAuthState(state)).toEqual({ businessId: BIZ });
  });

  it("expires after SLACK_STATE_TTL_MS", () => {
    const now = 1_700_000_000_000;
    const state = createSlackOAuthState(BIZ, now);
    expect(verifySlackOAuthState(state, now + SLACK_STATE_TTL_MS - 1)).toEqual({
      businessId: BIZ
    });
    expect(verifySlackOAuthState(state, now + SLACK_STATE_TTL_MS + 1)).toBeNull();
  });

  it("rejects tampered payloads and signatures", () => {
    const state = createSlackOAuthState(BIZ);
    const [payload, sig] = state.split(".");
    const otherPayload = Buffer.from(
      JSON.stringify({ b: "22222222-2222-4222-8222-222222222222", e: Date.now() + 60_000 }),
      "utf8"
    ).toString("base64url");
    expect(verifySlackOAuthState(`${otherPayload}.${sig}`)).toBeNull();
    // Same-length signature that is wrong (flip a char, keep the length).
    const flipped = sig.endsWith("A") ? `${sig.slice(0, -1)}B` : `${sig.slice(0, -1)}A`;
    expect(verifySlackOAuthState(`${payload}.${flipped}`)).toBeNull();
    // Different-length signature.
    expect(verifySlackOAuthState(`${payload}.short`)).toBeNull();
  });

  it("rejects malformed states", () => {
    expect(verifySlackOAuthState("no-dot-here")).toBeNull();
    expect(verifySlackOAuthState(".starts-with-dot")).toBeNull();
    expect(verifySlackOAuthState("ends-with-dot.")).toBeNull();
  });

  it("rejects a signed payload that is not the expected JSON shape", () => {
    // Sign arbitrary payloads with the real key by reusing create + surgery:
    // craft payloads through the same HMAC (copy the sig from a state whose
    // payload we replace won't verify, so instead sign via the module by
    // making the payload JSON but wrong-typed fields).
    const good = createSlackOAuthState(BIZ);
    // Recompute the HMAC exactly as the module does.
    const sigOf = (payload: string) => {
      const key = createHmac("sha256", "slack-oauth-state")
        .update("state-signing-key")
        .digest();
      return createHmac("sha256", key).update(payload).digest("base64url");
    };
    const notJson = Buffer.from("not json", "utf8").toString("base64url");
    expect(verifySlackOAuthState(`${notJson}.${sigOf(notJson)}`)).toBeNull();
    const wrongTypes = Buffer.from(JSON.stringify({ b: 7, e: "soon" }), "utf8").toString(
      "base64url"
    );
    expect(verifySlackOAuthState(`${wrongTypes}.${sigOf(wrongTypes)}`)).toBeNull();
    expect(verifySlackOAuthState(good)).not.toBeNull();
  });

  it("throws not_configured when no signing key source exists", () => {
    vi.stubEnv("INTEGRATIONS_ENCRYPTION_KEY", "");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    expect(() => createSlackOAuthState(BIZ)).toThrow(SlackOAuthError);
  });

  it("falls back to the service-role key when no dedicated key is set", () => {
    vi.stubEnv("INTEGRATIONS_ENCRYPTION_KEY", undefined);
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role-key");
    const state = createSlackOAuthState(BIZ);
    expect(verifySlackOAuthState(state)).toEqual({ businessId: BIZ });
  });
});

describe("buildSlackAuthorizeUrl", () => {
  it("carries client id, the full scope list, redirect and state", () => {
    const url = new URL(buildSlackAuthorizeUrl("the-state"));
    expect(url.origin + url.pathname).toBe("https://slack.com/oauth/v2/authorize");
    expect(url.searchParams.get("client_id")).toBe("client-123");
    expect(url.searchParams.get("scope")).toBe(SLACK_BOT_SCOPES.join(","));
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://app.example.com/api/integrations/slack/callback"
    );
    expect(url.searchParams.get("state")).toBe("the-state");
  });
});

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  } as Response;
}

describe("exchangeSlackAuthCode", () => {
  it("returns the install on success and posts the code form-encoded", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        ok: true,
        access_token: "xoxb-abc",
        scope: "chat:write,im:history",
        bot_user_id: "U-BOT",
        app_id: "A-1",
        team: { id: "T-1", name: "Acme" },
        enterprise: null
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const install = await exchangeSlackAuthCode("code-1");
    expect(install).toEqual({
      accessToken: "xoxb-abc",
      teamId: "T-1",
      teamName: "Acme",
      enterpriseId: null,
      botUserId: "U-BOT",
      appId: "A-1",
      scopes: "chat:write,im:history"
    });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://slack.com/api/oauth.v2.access");
    const params = new URLSearchParams(String(init.body));
    expect(params.get("code")).toBe("code-1");
    expect(params.get("client_id")).toBe("client-123");
    expect(params.get("client_secret")).toBe("secret-456");
    expect(params.get("redirect_uri")).toBe(
      "https://app.example.com/api/integrations/slack/callback"
    );
  });

  it("keeps an enterprise id and blanks an empty team name / missing scope", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          ok: true,
          access_token: "xoxb-abc",
          bot_user_id: "U-BOT",
          app_id: "A-1",
          team: { id: "T-1", name: "" },
          enterprise: { id: "E-9", name: "Grid" }
        })
      )
    );
    const install = await exchangeSlackAuthCode("code-1");
    expect(install.teamName).toBeNull();
    expect(install.enterpriseId).toBe("E-9");
    expect(install.scopes).toBe("");
  });

  it.each(["invalid_code", "code_already_used"])(
    "maps %s to invalid_grant",
    async (error) => {
      vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ ok: false, error })));
      await expect(exchangeSlackAuthCode("dead")).rejects.toMatchObject({
        name: "SlackOAuthError",
        code: "invalid_grant"
      });
    }
  );

  it("maps other refusals and malformed bodies to request_failed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ ok: false, error: "invalid_client_id" }, 200))
    );
    await expect(exchangeSlackAuthCode("c")).rejects.toMatchObject({ code: "request_failed" });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ ok: true, access_token: "xoxb", bot_user_id: "U" }))
    );
    await expect(exchangeSlackAuthCode("c")).rejects.toMatchObject({ code: "request_failed" });

    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => {
        throw new Error("not json");
      }
    }) as unknown as Response));
    await expect(exchangeSlackAuthCode("c")).rejects.toMatchObject({ code: "request_failed" });
  });

  it("maps an abort to upstream_timeout and a network error to upstream_unreachable", async () => {
    const abortErr = new Error("aborted");
    abortErr.name = "AbortError";
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(abortErr)));
    await expect(exchangeSlackAuthCode("c")).rejects.toMatchObject({
      code: "upstream_timeout"
    });

    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("ECONNREFUSED"))));
    await expect(exchangeSlackAuthCode("c")).rejects.toMatchObject({
      code: "upstream_unreachable"
    });
  });

  it("aborts a hung exchange when the timeout fires", async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal(
        "fetch",
        vi.fn(
          (_url: unknown, init?: RequestInit) =>
            new Promise((_resolve, reject) => {
              init?.signal?.addEventListener("abort", () => {
                const e = new Error("aborted");
                e.name = "AbortError";
                reject(e);
              });
            })
        )
      );
      const pending = exchangeSlackAuthCode("c");
      const assertion = expect(pending).rejects.toMatchObject({ code: "upstream_timeout" });
      await vi.advanceTimersByTimeAsync(SLACK_REQUEST_TIMEOUT_MS + 5);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("revokeSlackToken", () => {
  it("returns true only when Slack says ok", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ ok: true, revoked: true })));
    expect(await revokeSlackToken("xoxb-1")).toBe(true);

    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ ok: false, error: "token_revoked" })));
    expect(await revokeSlackToken("xoxb-1")).toBe(false);

    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("not json");
      }
    }) as unknown as Response));
    expect(await revokeSlackToken("xoxb-1")).toBe(false);
  });

  it("never throws on network failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("down"))));
    expect(await revokeSlackToken("xoxb-1")).toBe(false);
  });

  it("gives up quietly when a hung revoke times out", async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal(
        "fetch",
        vi.fn(
          (_url: unknown, init?: RequestInit) =>
            new Promise((_resolve, reject) => {
              init?.signal?.addEventListener("abort", () => {
                const e = new Error("aborted");
                e.name = "AbortError";
                reject(e);
              });
            })
        )
      );
      const pending = revokeSlackToken("xoxb-1");
      await vi.advanceTimersByTimeAsync(SLACK_REQUEST_TIMEOUT_MS + 5);
      expect(await pending).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
