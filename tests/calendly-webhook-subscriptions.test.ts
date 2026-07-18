/**
 * Calendly webhook subscription lifecycle
 * (src/lib/calendly/webhook-subscriptions.ts): callback URL shape, status
 * extraction across transports, ensure (active short-circuit, cooldown,
 * plan gating, 409 recovery, signing-key contract) and best-effort
 * teardown.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServiceClient: vi.fn() }));
vi.mock("@/lib/voice-tools/connections", () => ({
  resolveCalendarConnection: vi.fn()
}));
vi.mock("@/lib/calendar-tools/calendly", () => ({ calendlyRequest: vi.fn() }));
vi.mock("@/lib/db/calendly-webhook-subscriptions", () => ({
  getCalendlyWebhookSubscription: vi.fn(),
  upsertCalendlyWebhookSubscription: vi.fn(),
  deleteCalendlyWebhookSubscription: vi.fn()
}));

import {
  CALENDLY_WEBHOOK_RETRY_COOLDOWN_MS,
  calendlyWebhookCallbackUrl,
  ensureCalendlyWebhookSubscription,
  httpStatusOf,
  teardownCalendlyWebhookSubscription
} from "@/lib/calendly/webhook-subscriptions";
import {
  deleteCalendlyWebhookSubscription,
  getCalendlyWebhookSubscription,
  upsertCalendlyWebhookSubscription
} from "@/lib/db/calendly-webhook-subscriptions";
import { resolveCalendarConnection } from "@/lib/voice-tools/connections";
import { calendlyRequest } from "@/lib/calendar-tools/calendly";
import { logger } from "@/lib/logger";

const BIZ = "11111111-1111-4111-8111-111111111111";
const CONN = {
  provider: "calendly" as const,
  providerConfigKey: "calendly-direct",
  connectionId: "cx-1"
};
const NOW = Date.parse("2026-07-18T12:00:00Z");
const USER_RES = {
  data: {
    resource: {
      uri: "https://api.calendly.com/users/U1",
      current_organization: "https://api.calendly.com/organizations/O1"
    }
  }
};
const CREATED_RES = {
  data: {
    resource: {
      uri: "https://api.calendly.com/webhook_subscriptions/WH1",
      signing_key: "sk-secret"
    }
  }
};

const savedAppUrl = process.env.NEXT_PUBLIC_APP_URL;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.NEXT_PUBLIC_APP_URL = "https://app.newcoworker.com/";
});

afterEach(() => {
  if (savedAppUrl === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
  else process.env.NEXT_PUBLIC_APP_URL = savedAppUrl;
});

describe("calendlyWebhookCallbackUrl", () => {
  it("builds the tenant callback off NEXT_PUBLIC_APP_URL (trailing slash stripped)", () => {
    expect(calendlyWebhookCallbackUrl(BIZ)).toBe(
      `https://app.newcoworker.com/api/webhooks/calendly?business=${BIZ}`
    );
  });

  it("falls back to localhost when the env is unset", () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    expect(calendlyWebhookCallbackUrl(BIZ)).toBe(
      `http://localhost:3000/api/webhooks/calendly?business=${BIZ}`
    );
  });
});

describe("httpStatusOf", () => {
  it("reads CalendlyApiError-style .status and axios-style .response.status", () => {
    expect(httpStatusOf({ status: 403 })).toBe(403);
    expect(httpStatusOf({ response: { status: 409 } })).toBe(409);
    expect(httpStatusOf({ status: "403" })).toBeUndefined();
    expect(httpStatusOf(new Error("plain"))).toBeUndefined();
    expect(httpStatusOf(null)).toBeUndefined();
  });
});

describe("ensureCalendlyWebhookSubscription", () => {
  const db = {} as never;

  function row(
    status: "active" | "unsupported" | "error",
    lastAttemptMs: number,
    overrides: Record<string, unknown> = {}
  ) {
    return {
      id: "cws-1",
      business_id: BIZ,
      status,
      subscription_uri: status === "active" ? "https://api.calendly.com/webhook_subscriptions/WH1" : null,
      signingKey: status === "active" ? "sk-secret" : null,
      user_uri: status === "active" ? "https://api.calendly.com/users/U1" : null,
      connection_key: `${CONN.providerConfigKey}:${CONN.connectionId}`,
      last_attempt_at: new Date(lastAttemptMs).toISOString(),
      ...overrides
    };
  }

  it("short-circuits on an active row for the SAME connection without calling Calendly", async () => {
    vi.mocked(getCalendlyWebhookSubscription).mockResolvedValue(row("active", NOW - 1) as never);
    const request = vi.fn();
    const out = await ensureCalendlyWebhookSubscription(BIZ, CONN, { request, nowMs: NOW }, db);
    expect(out).toEqual({ status: "active", attempted: false });
    expect(request).not.toHaveBeenCalled();
  });

  it("re-stamps (keeps) an active subscription when a NEW connection serves the same account", async () => {
    vi.mocked(getCalendlyWebhookSubscription).mockResolvedValue(
      row("active", NOW - 1, { connection_key: "calendly:old-nango-conn" }) as never
    );
    const request = vi.fn().mockResolvedValueOnce(USER_RES); // same user U1
    const out = await ensureCalendlyWebhookSubscription(BIZ, CONN, { request, nowMs: NOW }, db);
    expect(out).toEqual({ status: "active", attempted: true });
    // No delete, no create — one identity probe, then the row is re-stamped
    // under the new connection key.
    expect(request).toHaveBeenCalledTimes(1);
    expect(upsertCalendlyWebhookSubscription).toHaveBeenCalledWith(
      {
        businessId: BIZ,
        status: "active",
        subscriptionUri: "https://api.calendly.com/webhook_subscriptions/WH1",
        signingKey: "sk-secret",
        userUri: "https://api.calendly.com/users/U1",
        connectionKey: `${CONN.providerConfigKey}:${CONN.connectionId}`
      },
      db
    );
  });

  it("replaces the subscription when the connection now serves a DIFFERENT account", async () => {
    vi.mocked(getCalendlyWebhookSubscription).mockResolvedValue(
      row("active", NOW - 1, {
        connection_key: "calendly:old-nango-conn",
        user_uri: "https://api.calendly.com/users/OLD"
      }) as never
    );
    const request = vi
      .fn()
      .mockResolvedValueOnce(USER_RES) // current account is U1, row says OLD
      .mockResolvedValueOnce({ data: null }) // DELETE stale subscription
      .mockResolvedValueOnce(CREATED_RES); // fresh create under U1
    const out = await ensureCalendlyWebhookSubscription(BIZ, CONN, { request, nowMs: NOW }, db);
    expect(out).toEqual({ status: "active", attempted: true });
    expect(request).toHaveBeenNthCalledWith(2, BIZ, CONN, {
      endpoint: "/webhook_subscriptions/WH1",
      method: "DELETE"
    });
    expect(upsertCalendlyWebhookSubscription).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "active",
        userUri: "https://api.calendly.com/users/U1",
        connectionKey: `${CONN.providerConfigKey}:${CONN.connectionId}`
      }),
      db
    );
  });

  it("still replaces when the stale-subscription delete fails (warn only)", async () => {
    vi.mocked(getCalendlyWebhookSubscription).mockResolvedValue(
      row("active", NOW - 1, {
        connection_key: "calendly:old-nango-conn",
        user_uri: "https://api.calendly.com/users/OLD"
      }) as never
    );
    const request = vi
      .fn()
      .mockResolvedValueOnce(USER_RES)
      .mockRejectedValueOnce("revoked") // stale delete refused (non-Error arm)
      .mockResolvedValueOnce(CREATED_RES);
    const out = await ensureCalendlyWebhookSubscription(BIZ, CONN, { request, nowMs: NOW }, db);
    expect(out).toEqual({ status: "active", attempted: true });
    expect(logger.warn).toHaveBeenCalledWith(
      "calendly webhook stale-subscription delete failed",
      expect.objectContaining({ businessId: BIZ, error: "revoked" })
    );

    // Error-shaped failures report their message; an active row WITHOUT a
    // stored uri skips the remote hop entirely.
    vi.mocked(getCalendlyWebhookSubscription).mockResolvedValue(
      row("active", NOW - 1, {
        connection_key: "calendly:old-nango-conn",
        user_uri: "https://api.calendly.com/users/OLD"
      }) as never
    );
    const requestErr = vi
      .fn()
      .mockResolvedValueOnce(USER_RES)
      .mockRejectedValueOnce(new Error("gone"))
      .mockResolvedValueOnce(CREATED_RES);
    await ensureCalendlyWebhookSubscription(BIZ, CONN, { request: requestErr, nowMs: NOW }, db);
    expect(logger.warn).toHaveBeenCalledWith(
      "calendly webhook stale-subscription delete failed",
      expect.objectContaining({ error: "gone" })
    );

    vi.mocked(getCalendlyWebhookSubscription).mockResolvedValue(
      row("active", NOW - 1, {
        connection_key: "calendly:old-nango-conn",
        user_uri: "https://api.calendly.com/users/OLD",
        subscription_uri: null
      }) as never
    );
    const requestNoUri = vi
      .fn()
      .mockResolvedValueOnce(USER_RES)
      .mockResolvedValueOnce(CREATED_RES); // straight to create
    await ensureCalendlyWebhookSubscription(BIZ, CONN, { request: requestNoUri, nowMs: NOW }, db);
    expect(requestNoUri).toHaveBeenCalledTimes(2);
  });

  it("leaves an active row untouched when the identity probe fails on a changed connection", async () => {
    vi.mocked(getCalendlyWebhookSubscription).mockResolvedValue(
      row("active", NOW - 1, { connection_key: "calendly:old-nango-conn" }) as never
    );
    const request = vi.fn().mockResolvedValueOnce(null); // /users/me refused
    const out = await ensureCalendlyWebhookSubscription(BIZ, CONN, { request, nowMs: NOW }, db);
    expect(out).toEqual({ status: "error", attempted: true });
    // No record: a flaky probe must not destroy a working subscription.
    expect(upsertCalendlyWebhookSubscription).not.toHaveBeenCalled();
  });

  it("bypasses a refused row's cooldown when the connection changed (new account may be paid)", async () => {
    vi.mocked(getCalendlyWebhookSubscription).mockResolvedValue(
      row("unsupported", NOW, { connection_key: "calendly:old-nango-conn" }) as never
    );
    const request = vi
      .fn()
      .mockResolvedValueOnce(USER_RES)
      .mockResolvedValueOnce(CREATED_RES);
    const out = await ensureCalendlyWebhookSubscription(BIZ, CONN, { request, nowMs: NOW }, db);
    expect(out).toEqual({ status: "active", attempted: true });
  });

  it("respects the retry cooldown for refused attempts", async () => {
    vi.mocked(getCalendlyWebhookSubscription).mockResolvedValue(
      row("unsupported", NOW - CALENDLY_WEBHOOK_RETRY_COOLDOWN_MS + 60_000) as never
    );
    const request = vi.fn();
    const out = await ensureCalendlyWebhookSubscription(BIZ, CONN, { request, nowMs: NOW }, db);
    expect(out).toEqual({ status: "unsupported", attempted: false });
    expect(request).not.toHaveBeenCalled();
  });

  it("creates a user-scoped invitee.created subscription and stores the signing key", async () => {
    vi.mocked(getCalendlyWebhookSubscription).mockResolvedValue(null);
    const request = vi
      .fn()
      .mockResolvedValueOnce(USER_RES)
      .mockResolvedValueOnce(CREATED_RES);
    const out = await ensureCalendlyWebhookSubscription(BIZ, CONN, { request, nowMs: NOW }, db);
    expect(out).toEqual({ status: "active", attempted: true });
    expect(request).toHaveBeenNthCalledWith(2, BIZ, CONN, {
      endpoint: "/webhook_subscriptions",
      method: "POST",
      data: {
        url: `https://app.newcoworker.com/api/webhooks/calendly?business=${BIZ}`,
        events: ["invitee.created"],
        organization: "https://api.calendly.com/organizations/O1",
        user: "https://api.calendly.com/users/U1",
        scope: "user"
      }
    });
    expect(upsertCalendlyWebhookSubscription).toHaveBeenCalledWith(
      {
        businessId: BIZ,
        status: "active",
        subscriptionUri: "https://api.calendly.com/webhook_subscriptions/WH1",
        signingKey: "sk-secret",
        userUri: "https://api.calendly.com/users/U1",
        connectionKey: `${CONN.providerConfigKey}:${CONN.connectionId}`
      },
      db
    );
  });

  it("re-attempts once a refused row's cooldown has fully elapsed", async () => {
    vi.mocked(getCalendlyWebhookSubscription).mockResolvedValue(
      row("error", NOW - CALENDLY_WEBHOOK_RETRY_COOLDOWN_MS - 1) as never
    );
    const request = vi
      .fn()
      .mockResolvedValueOnce(USER_RES)
      .mockResolvedValueOnce(CREATED_RES);
    const out = await ensureCalendlyWebhookSubscription(BIZ, CONN, { request, nowMs: NOW }, db);
    expect(out).toEqual({ status: "active", attempted: true });
  });

  it("records error when /users/me refuses or lacks uri/organization", async () => {
    vi.mocked(getCalendlyWebhookSubscription).mockResolvedValue(null);
    for (const userRes of [null, { data: { resource: { uri: "https://api.calendly.com/users/U1" } } }]) {
      vi.mocked(upsertCalendlyWebhookSubscription).mockClear();
      const request = vi.fn().mockResolvedValue(userRes);
      const out = await ensureCalendlyWebhookSubscription(BIZ, CONN, { request, nowMs: NOW }, db);
      expect(out).toEqual({ status: "error", attempted: true });
      expect(upsertCalendlyWebhookSubscription).toHaveBeenCalledWith(
        {
          businessId: BIZ,
          status: "error",
          subscriptionUri: undefined,
          signingKey: undefined,
          userUri: undefined,
          connectionKey: `${CONN.providerConfigKey}:${CONN.connectionId}`
        },
        db
      );
    }
  });

  it("records unsupported when the create is refused (null) or plan-gated (402/403)", async () => {
    vi.mocked(getCalendlyWebhookSubscription).mockResolvedValue(null);
    for (const failure of [
      async () => null, // direct transport maps 403 → null
      async () => {
        throw { status: 402 };
      },
      async () => {
        throw { response: { status: 403 } };
      }
    ]) {
      vi.mocked(upsertCalendlyWebhookSubscription).mockClear();
      const request = vi.fn().mockResolvedValueOnce(USER_RES).mockImplementationOnce(failure);
      const out = await ensureCalendlyWebhookSubscription(BIZ, CONN, { request, nowMs: NOW }, db);
      expect(out).toEqual({ status: "unsupported", attempted: true });
    }
  });

  it("records error (with a warn) on unexpected create failures", async () => {
    vi.mocked(getCalendlyWebhookSubscription).mockResolvedValue(null);
    const request = vi
      .fn()
      .mockResolvedValueOnce(USER_RES)
      .mockRejectedValueOnce(new Error("calendly 500"));
    const out = await ensureCalendlyWebhookSubscription(BIZ, CONN, { request, nowMs: NOW }, db);
    expect(out).toEqual({ status: "error", attempted: true });
    expect(logger.warn).toHaveBeenCalledWith(
      "calendly webhook subscribe failed",
      expect.objectContaining({ businessId: BIZ, error: "calendly 500" })
    );

    // Non-Error throws are stringified in the same warn.
    const requestStr = vi
      .fn()
      .mockResolvedValueOnce(USER_RES)
      .mockRejectedValueOnce("socket weirdness");
    expect(
      await ensureCalendlyWebhookSubscription(BIZ, CONN, { request: requestStr, nowMs: NOW }, db)
    ).toEqual({ status: "error", attempted: true });
    expect(logger.warn).toHaveBeenCalledWith(
      "calendly webhook subscribe failed",
      expect.objectContaining({ error: "socket weirdness" })
    );
  });

  it("records error when the creation response has no signing key", async () => {
    vi.mocked(getCalendlyWebhookSubscription).mockResolvedValue(null);
    const request = vi
      .fn()
      .mockResolvedValueOnce(USER_RES)
      .mockResolvedValueOnce({
        data: { resource: { uri: "https://api.calendly.com/webhook_subscriptions/WH1" } }
      });
    const out = await ensureCalendlyWebhookSubscription(BIZ, CONN, { request, nowMs: NOW }, db);
    expect(out).toEqual({ status: "error", attempted: true });
  });

  it("recovers a 409 conflict by deleting the stale subscription and re-creating", async () => {
    vi.mocked(getCalendlyWebhookSubscription).mockResolvedValue(null);
    const callback = calendlyWebhookCallbackUrl(BIZ);
    const request = vi
      .fn()
      .mockResolvedValueOnce(USER_RES)
      .mockRejectedValueOnce({ status: 409 }) // first create
      .mockResolvedValueOnce({
        data: {
          collection: [
            { uri: "https://api.calendly.com/webhook_subscriptions/OTHER", callback_url: "https://elsewhere" },
            { uri: "https://api.calendly.com/webhook_subscriptions/STALE", callback_url: callback }
          ]
        }
      })
      .mockResolvedValueOnce({ data: null }) // DELETE stale
      .mockResolvedValueOnce(CREATED_RES); // second create
    const out = await ensureCalendlyWebhookSubscription(BIZ, CONN, { request, nowMs: NOW }, db);
    expect(out).toEqual({ status: "active", attempted: true });
    expect(request).toHaveBeenNthCalledWith(4, BIZ, CONN, {
      endpoint: "/webhook_subscriptions/STALE",
      method: "DELETE"
    });
  });

  it("recovers a same-org account switch: the stale hook only shows in the ORG listing", async () => {
    vi.mocked(getCalendlyWebhookSubscription).mockResolvedValue(null);
    const callback = calendlyWebhookCallbackUrl(BIZ);
    const request = vi
      .fn()
      .mockResolvedValueOnce(USER_RES)
      .mockRejectedValueOnce({ status: 409 }) // first create
      .mockResolvedValueOnce({ data: { collection: [] } }) // user listing: miss
      .mockResolvedValueOnce({
        // org listing: the previous user's hook holds our callback
        data: {
          collection: [
            { uri: "https://api.calendly.com/webhook_subscriptions/OLDUSER", callback_url: callback }
          ]
        }
      })
      .mockResolvedValueOnce({ data: null }) // DELETE stale
      .mockResolvedValueOnce(CREATED_RES); // second create
    const out = await ensureCalendlyWebhookSubscription(BIZ, CONN, { request, nowMs: NOW }, db);
    expect(out).toEqual({ status: "active", attempted: true });
    expect(request).toHaveBeenNthCalledWith(4, BIZ, CONN, {
      endpoint: "/webhook_subscriptions",
      method: "GET",
      params: {
        organization: "https://api.calendly.com/organizations/O1",
        count: "100",
        scope: "organization"
      }
    });
    expect(request).toHaveBeenNthCalledWith(5, BIZ, CONN, {
      endpoint: "/webhook_subscriptions/OLDUSER",
      method: "DELETE"
    });
  });

  it("records error when the conflict recovery cannot find or re-create the hook", async () => {
    vi.mocked(getCalendlyWebhookSubscription).mockResolvedValue(null);
    // Neither listing has a matching callback.
    const requestNoMatch = vi
      .fn()
      .mockResolvedValueOnce(USER_RES)
      .mockRejectedValueOnce({ status: 409 })
      .mockResolvedValueOnce({ data: { collection: [{ callback_url: "https://elsewhere", uri: "https://api.calendly.com/webhook_subscriptions/X" }] } })
      .mockResolvedValueOnce({ data: { collection: [] } });
    expect(
      await ensureCalendlyWebhookSubscription(BIZ, CONN, { request: requestNoMatch, nowMs: NOW }, db)
    ).toEqual({ status: "error", attempted: true });

    // Listings refused (null) / throwing (permission-gated org scope) →
    // nothing to recover, warn only.
    const requestNullList = vi
      .fn()
      .mockResolvedValueOnce(USER_RES)
      .mockRejectedValueOnce({ status: 409 })
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error("org listing forbidden"));
    expect(
      await ensureCalendlyWebhookSubscription(BIZ, CONN, { request: requestNullList, nowMs: NOW }, db)
    ).toEqual({ status: "error", attempted: true });
    expect(logger.warn).toHaveBeenCalledWith(
      "calendly webhook conflict listing failed",
      expect.objectContaining({ businessId: BIZ, scope: "organization", error: "org listing forbidden" })
    );

    // Non-Error listing failures are stringified in the same warn.
    const requestStrThrow = vi
      .fn()
      .mockResolvedValueOnce(USER_RES)
      .mockRejectedValueOnce({ status: 409 })
      .mockRejectedValueOnce("user listing sad")
      .mockResolvedValueOnce({ data: { collection: [] } });
    expect(
      await ensureCalendlyWebhookSubscription(BIZ, CONN, { request: requestStrThrow, nowMs: NOW }, db)
    ).toEqual({ status: "error", attempted: true });
    expect(logger.warn).toHaveBeenCalledWith(
      "calendly webhook conflict listing failed",
      expect.objectContaining({ scope: "user", error: "user listing sad" })
    );

    // The stale-hook DELETE failing still RECORDS the attempt (the
    // cooldown must advance so the sweep does not repeat the whole cycle
    // every tick). Error and non-Error shapes both stringify into the warn.
    const callback2 = calendlyWebhookCallbackUrl(BIZ);
    const staleListing = {
      data: {
        collection: [
          { uri: "https://api.calendly.com/webhook_subscriptions/STALE", callback_url: callback2 }
        ]
      }
    };
    for (const [failure, expected] of [
      [new Error("delete refused"), "delete refused"],
      ["delete sad", "delete sad"]
    ] as const) {
      vi.mocked(upsertCalendlyWebhookSubscription).mockClear();
      const requestDeleteFail = vi
        .fn()
        .mockResolvedValueOnce(USER_RES)
        .mockRejectedValueOnce({ status: 409 })
        .mockResolvedValueOnce(staleListing)
        .mockRejectedValueOnce(failure);
      expect(
        await ensureCalendlyWebhookSubscription(
          BIZ,
          CONN,
          { request: requestDeleteFail, nowMs: NOW },
          db
        )
      ).toEqual({ status: "error", attempted: true });
      expect(logger.warn).toHaveBeenCalledWith(
        "calendly webhook conflict delete failed",
        expect.objectContaining({ businessId: BIZ, error: expected })
      );
      expect(upsertCalendlyWebhookSubscription).toHaveBeenCalledWith(
        expect.objectContaining({ status: "error" }),
        db
      );
    }

    // Second create conflicts again.
    const callback = calendlyWebhookCallbackUrl(BIZ);
    const requestReconflict = vi
      .fn()
      .mockResolvedValueOnce(USER_RES)
      .mockRejectedValueOnce({ status: 409 })
      .mockResolvedValueOnce({
        data: { collection: [{ uri: "https://api.calendly.com/webhook_subscriptions/STALE", callback_url: callback }] }
      })
      .mockResolvedValueOnce({ data: null })
      .mockRejectedValueOnce({ status: 409 });
    expect(
      await ensureCalendlyWebhookSubscription(BIZ, CONN, { request: requestReconflict, nowMs: NOW }, db)
    ).toEqual({ status: "error", attempted: true });
  });

  it("never throws: a persistence failure degrades to an error result", async () => {
    vi.mocked(getCalendlyWebhookSubscription).mockRejectedValue(new Error("db down"));
    const out = await ensureCalendlyWebhookSubscription(BIZ, CONN, { nowMs: NOW }, db);
    expect(out).toEqual({ status: "error", attempted: false });
    expect(logger.warn).toHaveBeenCalledWith(
      "calendly webhook ensure failed",
      expect.objectContaining({ businessId: BIZ, error: "db down" })
    );
    // The default transport (module calendlyRequest) was never reached.
    expect(calendlyRequest).not.toHaveBeenCalled();

    // Non-Error failures are stringified.
    vi.mocked(getCalendlyWebhookSubscription).mockRejectedValue("db string down");
    await ensureCalendlyWebhookSubscription(BIZ, CONN, { nowMs: NOW }, db);
    expect(logger.warn).toHaveBeenCalledWith(
      "calendly webhook ensure failed",
      expect.objectContaining({ error: "db string down" })
    );
  });

  it("uses the wall clock and module transport by default", async () => {
    vi.mocked(getCalendlyWebhookSubscription).mockResolvedValue(
      // Attempted "now" per the real clock → cooldown suppresses.
      row("unsupported", Date.now()) as never
    );
    const out = await ensureCalendlyWebhookSubscription(BIZ, CONN, {}, db);
    expect(out).toEqual({ status: "unsupported", attempted: false });
  });
});

describe("teardownCalendlyWebhookSubscription", () => {
  const db = {} as never;

  it("is a no-op when no row exists", async () => {
    vi.mocked(getCalendlyWebhookSubscription).mockResolvedValue(null);
    await teardownCalendlyWebhookSubscription(BIZ, {}, db);
    expect(deleteCalendlyWebhookSubscription).not.toHaveBeenCalled();
  });

  it("deletes the remote subscription (Calendly connection) then the row", async () => {
    vi.mocked(getCalendlyWebhookSubscription).mockResolvedValue({
      id: "cws-1",
      business_id: BIZ,
      status: "active",
      subscription_uri: "https://api.calendly.com/webhook_subscriptions/WH1",
      signingKey: "sk-secret",
      last_attempt_at: new Date(NOW).toISOString()
    } as never);
    const request = vi.fn().mockResolvedValue({ data: null });
    const resolveConnection = vi.fn().mockResolvedValue(CONN);
    await teardownCalendlyWebhookSubscription(BIZ, { request, resolveConnection }, db);
    expect(request).toHaveBeenCalledWith(BIZ, CONN, {
      endpoint: "/webhook_subscriptions/WH1",
      method: "DELETE"
    });
    expect(deleteCalendlyWebhookSubscription).toHaveBeenCalledWith(BIZ, db);
  });

  it("skips the remote delete when the calendar no longer resolves to Calendly", async () => {
    vi.mocked(getCalendlyWebhookSubscription).mockResolvedValue({
      id: "cws-1",
      business_id: BIZ,
      status: "active",
      subscription_uri: "https://api.calendly.com/webhook_subscriptions/WH1",
      signingKey: "sk-secret",
      last_attempt_at: new Date(NOW).toISOString()
    } as never);
    const request = vi.fn();
    const resolveConnection = vi.fn().mockResolvedValue(null);
    await teardownCalendlyWebhookSubscription(BIZ, { request, resolveConnection }, db);
    expect(request).not.toHaveBeenCalled();
    expect(deleteCalendlyWebhookSubscription).toHaveBeenCalledWith(BIZ, db);
  });

  it("still drops the row when the remote delete fails (warn only)", async () => {
    vi.mocked(getCalendlyWebhookSubscription).mockResolvedValue({
      id: "cws-1",
      business_id: BIZ,
      status: "active",
      // A bare (slash-less) stored uri is used verbatim as the uuid.
      subscription_uri: "WH1",
      signingKey: "sk-secret",
      last_attempt_at: new Date(NOW).toISOString()
    } as never);
    const request = vi.fn().mockRejectedValue(new Error("api down"));
    const resolveConnection = vi.fn().mockResolvedValue(CONN);
    await teardownCalendlyWebhookSubscription(BIZ, { request, resolveConnection }, db);
    expect(request).toHaveBeenCalledWith(BIZ, CONN, {
      endpoint: "/webhook_subscriptions/WH1",
      method: "DELETE"
    });
    expect(logger.warn).toHaveBeenCalledWith(
      "calendly webhook remote delete failed",
      expect.objectContaining({ businessId: BIZ, error: "api down" })
    );
    expect(deleteCalendlyWebhookSubscription).toHaveBeenCalledWith(BIZ, db);

    // Non-Error remote failures are stringified in the same warn.
    const requestStr = vi.fn().mockRejectedValue("flaky");
    await teardownCalendlyWebhookSubscription(BIZ, { request: requestStr, resolveConnection }, db);
    expect(logger.warn).toHaveBeenCalledWith(
      "calendly webhook remote delete failed",
      expect.objectContaining({ error: "flaky" })
    );
  });

  it("skips the remote hop for rows without a subscription uri", async () => {
    vi.mocked(getCalendlyWebhookSubscription).mockResolvedValue({
      id: "cws-1",
      business_id: BIZ,
      status: "unsupported",
      subscription_uri: null,
      signingKey: null,
      last_attempt_at: new Date(NOW).toISOString()
    } as never);
    const request = vi.fn();
    await teardownCalendlyWebhookSubscription(BIZ, { request }, db);
    expect(request).not.toHaveBeenCalled();
    expect(deleteCalendlyWebhookSubscription).toHaveBeenCalledWith(BIZ, db);
  });

  it("never throws (uses default deps): a read failure only warns", async () => {
    vi.mocked(getCalendlyWebhookSubscription).mockRejectedValue("string down");
    await teardownCalendlyWebhookSubscription(BIZ, undefined, db);
    expect(logger.warn).toHaveBeenCalledWith(
      "calendly webhook teardown failed",
      expect.objectContaining({ businessId: BIZ, error: "string down" })
    );
    expect(resolveCalendarConnection).not.toHaveBeenCalled();

    // Error failures report their message.
    vi.mocked(getCalendlyWebhookSubscription).mockRejectedValue(new Error("read blew up"));
    await teardownCalendlyWebhookSubscription(BIZ, undefined, db);
    expect(logger.warn).toHaveBeenCalledWith(
      "calendly webhook teardown failed",
      expect.objectContaining({ error: "read blew up" })
    );
  });
});
