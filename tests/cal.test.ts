import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CalOAuthError,
  buildCalAuthorizeUrl,
  createCalOAuthState,
  exchangeCalAuthCode,
  refreshCalTokens,
  verifyCalOAuthState
} from "@/lib/cal/oauth";
import { selectCalEventType, verifyCalWebhookSignature } from "@/lib/cal/client";

describe("Cal.com OAuth", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("refuses to build a config when the client is missing", () => {
    vi.stubEnv("CAL_CO_CLIENT_ID", "");
    vi.stubEnv("CAL_CO_CLIENT_SECRET", "");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
    expect(() => buildCalAuthorizeUrl("state")).toThrow(CalOAuthError);
  });

  it("builds an authorize URL with the registered scopes and a round-trippable state", () => {
    vi.stubEnv("CAL_CO_CLIENT_ID", "client");
    vi.stubEnv("CAL_CO_CLIENT_SECRET", "secret");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://www.newcoworker.com/");
    vi.stubEnv("INTEGRATIONS_ENCRYPTION_KEY", "test-key");
    const state = createCalOAuthState("11111111-1111-4111-8111-111111111111", 1_700_000_000_000);
    const url = new URL(buildCalAuthorizeUrl(state));
    expect(url.origin + url.pathname).toBe("https://app.cal.com/auth/oauth2/authorize");
    expect(url.searchParams.get("client_id")).toBe("client");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://www.newcoworker.com/api/integrations/cal/callback"
    );
    expect(url.searchParams.get("scope")).toContain("BOOKING_READ");
    expect(url.searchParams.get("scope")).toContain("BOOKING_WRITE");
    expect(url.searchParams.get("scope")).not.toContain("CREDITS_WRITE");
    expect(verifyCalOAuthState(state, 1_700_000_000_000)?.businessId).toBe(
      "11111111-1111-4111-8111-111111111111"
    );
    expect(verifyCalOAuthState("nope")).toBeNull();
  });

  it("exchanges an auth code and refreshes", async () => {
    vi.stubEnv("CAL_CO_CLIENT_ID", "client");
    vi.stubEnv("CAL_CO_CLIENT_SECRET", "secret");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://www.newcoworker.com");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ access_token: "a", refresh_token: "r", expires_in: 30 }), { status: 200 }))
    );
    const tokens = await exchangeCalAuthCode("code", 1_700_000_000_000);
    expect(tokens.accessToken).toBe("a");
    const refreshed = await refreshCalTokens("r", 1_700_000_000_000);
    expect(refreshed.refreshToken).toBe("r");
  });

  it("maps a stuck token request to a timeout", async () => {
    vi.stubEnv("CAL_CO_CLIENT_ID", "client");
    vi.stubEnv("CAL_CO_CLIENT_SECRET", "secret");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://www.newcoworker.com");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw Object.assign(new Error("aborted"), { name: "AbortError" });
      })
    );
    await expect(exchangeCalAuthCode("code")).rejects.toMatchObject({ code: "upstream_timeout" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("down");
      })
    );
    await expect(exchangeCalAuthCode("code")).rejects.toMatchObject({ code: "upstream_unreachable" });
  });
});

describe("Cal.com payload parsers", () => {
  it("selects a pinned event type, else the only one, else the closest duration", () => {
    const types = [
      { id: "1", title: "Intro", lengthMinutes: 15 },
      { id: "2", title: "Deep", lengthMinutes: 60 }
    ];
    expect(selectCalEventType([], null, 30)).toBe("no_types");
    const pinned = selectCalEventType(types, "2", 15);
    const closest = selectCalEventType(types, "missing", 50);
    const only = selectCalEventType([types[0]], null, 90);
    if (pinned === "no_types" || closest === "no_types" || only === "no_types") {
      throw new Error("expected an event type");
    }
    expect(pinned.id).toBe("2");
    expect(closest.id).toBe("2");
    expect(only.id).toBe("1");
  });

  it("checks the webhook signature", () => {
    const body = JSON.stringify({
      triggerEvent: "BOOKING_CREATED",
      payload: {
        uid: "bk_1",
        title: "Intro",
        startTime: "2026-09-26T15:00:00.000Z",
        attendees: [{ name: "Ada", email: "a@b.co" }]
      }
    });
    const sig = createHmac("sha256", "secret").update(body).digest("hex");
    expect(verifyCalWebhookSignature(body, sig, "secret")).toBe(true);
    expect(verifyCalWebhookSignature(body, "nope", "secret")).toBe(false);
    expect(verifyCalWebhookSignature(body, null, "secret")).toBe(false);
    expect(verifyCalWebhookSignature(body, `sha256=${sig}`, "secret")).toBe(true);
  });
});
