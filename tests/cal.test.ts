import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CAL_OAUTH_SCOPES,
  CalOAuthError,
  buildCalAuthorizeUrl,
  createCalOAuthState,
  exchangeCalAuthCode,
  getCalOAuthConfig,
  parseCalTokenResponse,
  refreshCalTokens,
  verifyCalOAuthState
} from "@/lib/cal/oauth";
import {
  parseCalBookingId,
  parseCalEventTypes,
  parseCalProfile,
  parseCalSlots,
  selectCalEventType,
  verifyCalWebhookSignature
} from "@/lib/cal/client";
import {
  calBookingEmail
} from "@/lib/calendar-tools/cal";
import {
  calWebhookAccepted,
  parseCalWebhookPayload
} from "@/lib/cal/webhook";

describe("Cal.com OAuth", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("refuses to build a config when the client is missing", () => {
    vi.stubEnv("CAL_CO_CLIENT_ID", "");
    vi.stubEnv("CAL_CO_CLIENT_SECRET", "");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
    expect(() => getCalOAuthConfig()).toThrow(CalOAuthError);
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
    expect(url.searchParams.get("scope")).toBe(CAL_OAUTH_SCOPES.join(" "));
    expect(verifyCalOAuthState(state, 1_700_000_000_000)?.businessId).toBe(
      "11111111-1111-4111-8111-111111111111"
    );
    expect(verifyCalOAuthState("nope")).toBeNull();
  });

  it("parses a token response and keeps the previous refresh token when omitted", () => {
    const now = 1_700_000_000_000;
    expect(parseCalTokenResponse(200, { access_token: "a", refresh_token: "r", expires_in: 10 }, null, now)).toEqual({
      accessToken: "a",
      refreshToken: "r",
      expiresAt: new Date(now + 10_000)
    });
    expect(parseCalTokenResponse(200, { access_token: "a" }, "old", now).refreshToken).toBe("old");
    expect(parseCalTokenResponse(200, { access_token: "a", refresh_token: "r" }, null, now).expiresAt.getTime()).toBe(
      now + 1_800_000
    );
    expect(() => parseCalTokenResponse(400, { error: "invalid_grant" }, null, now)).toThrow(CalOAuthError);
    expect(() => parseCalTokenResponse(200, { access_token: "a" }, null, now)).toThrow(/refresh token/);
  });

  it("exchanges an auth code", async () => {
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

  it("parses event types, profile, slots, and booking ids", () => {
    expect(parseCalEventTypes({ data: [{ id: 9, title: "Intro", lengthInMinutes: 20 }] })).toEqual([
      { id: "9", title: "Intro", lengthMinutes: 20 }
    ]);
    expect(parseCalEventTypes({ data: { eventTypes: [{ id: "4", slug: "chat", length: 45 }] } })[0].title).toBe("chat");
    expect(parseCalProfile({ data: { id: 3, email: "a@b.co", name: "Ada", username: "ada", timeZone: "America/New_York" } })).toMatchObject({
      id: "3",
      email: "a@b.co",
      timeZone: "America/New_York"
    });
    expect(parseCalSlots({ data: { "2026-09-26": [{ start: "2026-09-26T15:00:00.000Z" }] } })).toEqual([
      "2026-09-26T15:00:00.000Z"
    ]);
    expect(parseCalBookingId({ data: { uid: "bk_1" } })).toBe("bk_1");
    expect(parseCalBookingId({})).toBeNull();
  });

  it("checks the webhook signature and parses a booking payload", () => {
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
    const parsed = parseCalWebhookPayload(body);
    expect(parsed?.bookingUid).toBe("bk_1");
    expect(parsed && calWebhookAccepted(parsed)).toBe(true);
    expect(parseCalWebhookPayload("not json")).toBeNull();
    expect(calBookingEmail(null, "+1 (555) 111-2222")).toBe("no-reply+15551112222@example.com");
    expect(calBookingEmail("a@b.co", null)).toBe("a@b.co");
  });
});
