/**
 * Tests for the direct Meta Graph API client (src/lib/meta/client.ts):
 * OAuth state signing, login URL, token exchanges, page listing/subscribe,
 * lead fetch + field flattening, and webhook signature verification.
 */
import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

import {
  MetaApiError,
  META_GRAPH_BASE_URL,
  META_STATE_TTL_MS,
  buildMetaLoginUrl,
  createMetaOAuthState,
  exchangeCodeForToken,
  exchangeForLongLivedToken,
  fetchLead,
  flattenLeadFields,
  getMetaAppId,
  getMetaAppSecret,
  getUserName,
  listManagedPages,
  metaCallbackUrl,
  subscribePageToLeadgen,
  unsubscribePage,
  verifyMetaOAuthState,
  verifyMetaWebhookSignature
} from "@/lib/meta/client";

const APP_ID = "1554839372962421";
const APP_SECRET = "test-app-secret";

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
  process.env.META_APP_ID = APP_ID;
  process.env.META_APP_SECRET = APP_SECRET;
  delete process.env.NEXT_PUBLIC_APP_URL;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("app credentials", () => {
  it("reads the configured id/secret and throws when unset", () => {
    expect(getMetaAppId()).toBe(APP_ID);
    expect(getMetaAppSecret()).toBe(APP_SECRET);
    delete process.env.META_APP_ID;
    delete process.env.META_APP_SECRET;
    expect(() => getMetaAppId()).toThrow(/META_APP_ID/);
    expect(() => getMetaAppSecret()).toThrow(/META_APP_SECRET/);
  });
});

describe("OAuth state", () => {
  const BIZ = "11111111-1111-4111-8111-111111111111";

  function signState(encoded: string): string {
    return createHmac("sha256", APP_SECRET).update(encoded).digest("base64url");
  }

  it("round-trips a signed businessId", () => {
    const state = createMetaOAuthState(BIZ);
    expect(verifyMetaOAuthState(state)).toBe(BIZ);
  });

  it("rejects malformed, empty-piece, and tampered states", () => {
    expect(verifyMetaOAuthState("nodots")).toBeNull();
    expect(verifyMetaOAuthState("a.b.c")).toBeNull();
    expect(verifyMetaOAuthState(".sig")).toBeNull();
    expect(verifyMetaOAuthState("payload.")).toBeNull();

    const state = createMetaOAuthState(BIZ);
    const [encoded] = state.split(".");
    // Same-length forged signature exercises the timingSafeEqual branch.
    const forged = signState(`${encoded}x`);
    expect(verifyMetaOAuthState(`${encoded}.${forged}`)).toBeNull();
    // Different-length signature exercises the length guard.
    expect(verifyMetaOAuthState(`${encoded}.short`)).toBeNull();
  });

  it("rejects a validly signed but non-JSON payload", () => {
    const encoded = Buffer.from("not json").toString("base64url");
    expect(verifyMetaOAuthState(`${encoded}.${signState(encoded)}`)).toBeNull();
  });

  it("rejects a payload missing businessId or issuedAt", () => {
    const noBiz = Buffer.from(JSON.stringify({ issuedAt: Date.now() })).toString(
      "base64url"
    );
    expect(verifyMetaOAuthState(`${noBiz}.${signState(noBiz)}`)).toBeNull();

    const emptyBiz = Buffer.from(
      JSON.stringify({ businessId: "", issuedAt: Date.now() })
    ).toString("base64url");
    expect(verifyMetaOAuthState(`${emptyBiz}.${signState(emptyBiz)}`)).toBeNull();

    const noIssued = Buffer.from(JSON.stringify({ businessId: BIZ })).toString(
      "base64url"
    );
    expect(verifyMetaOAuthState(`${noIssued}.${signState(noIssued)}`)).toBeNull();
  });

  it("rejects an expired state", () => {
    const stale = Buffer.from(
      JSON.stringify({ businessId: BIZ, issuedAt: Date.now() - META_STATE_TTL_MS - 1 })
    ).toString("base64url");
    expect(verifyMetaOAuthState(`${stale}.${signState(stale)}`)).toBeNull();
  });
});

describe("metaCallbackUrl", () => {
  it("prefers NEXT_PUBLIC_APP_URL (trailing slash stripped) over the request origin", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://www.newcoworker.com/";
    expect(metaCallbackUrl("http://localhost:3000")).toBe(
      "https://www.newcoworker.com/api/integrations/meta/callback"
    );
    delete process.env.NEXT_PUBLIC_APP_URL;
    expect(metaCallbackUrl("http://localhost:3000")).toBe(
      "http://localhost:3000/api/integrations/meta/callback"
    );
  });
});

describe("buildMetaLoginUrl", () => {
  it("targets the Facebook dialog with client id, redirect, state, and scopes", () => {
    const url = new URL(
      buildMetaLoginUrl({ redirectUri: "https://x.test/cb", state: "signed-state" })
    );
    expect(url.origin + url.pathname).toBe("https://www.facebook.com/v24.0/dialog/oauth");
    expect(url.searchParams.get("client_id")).toBe(APP_ID);
    expect(url.searchParams.get("redirect_uri")).toBe("https://x.test/cb");
    expect(url.searchParams.get("state")).toBe("signed-state");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toContain("leads_retrieval");
  });
});

describe("token exchanges", () => {
  it("exchanges a code for a token with the registered redirect uri", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { access_token: "short-tok" }));
    expect(await exchangeCodeForToken("the-code", "https://x.test/cb")).toBe("short-tok");
    const [url] = fetchMock.mock.calls[0] as [string];
    const parsed = new URL(url);
    expect(parsed.pathname).toBe("/v24.0/oauth/access_token");
    expect(parsed.searchParams.get("code")).toBe("the-code");
    expect(parsed.searchParams.get("client_secret")).toBe(APP_SECRET);
    expect(parsed.searchParams.get("redirect_uri")).toBe("https://x.test/cb");
  });

  it("exchanges a short-lived token for a long-lived one", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { access_token: "long-tok" }));
    expect(await exchangeForLongLivedToken("short-tok")).toBe("long-tok");
    const [url] = fetchMock.mock.calls[0] as [string];
    const parsed = new URL(url);
    expect(parsed.searchParams.get("grant_type")).toBe("fb_exchange_token");
    expect(parsed.searchParams.get("fb_exchange_token")).toBe("short-tok");
  });

  it("throws request_failed when no access token comes back", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, {}));
    await expect(exchangeCodeForToken("c", "https://x.test/cb")).rejects.toThrow(
      /no access token/
    );
  });

  it("throws request_failed when the body is not JSON", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("bad json");
      },
      text: async () => ""
    } as never);
    await expect(exchangeForLongLivedToken("s")).rejects.toThrow(/no access token/);
  });
});

describe("graph transport errors", () => {
  it("maps non-2xx to request_failed with the status, tolerating a failed body read", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({}),
      text: async () => {
        throw new Error("unreadable");
      }
    } as never);
    const err = await getUserName("tok").catch((e) => e as MetaApiError);
    expect(err).toBeInstanceOf(MetaApiError);
    expect((err as MetaApiError).code).toBe("request_failed");
    expect((err as MetaApiError).status).toBe(500);
  });

  it("maps an abort to upstream_timeout and other network errors to upstream_unreachable", async () => {
    const abort = new Error("aborted");
    abort.name = "AbortError";
    fetchMock.mockRejectedValueOnce(abort);
    await expect(getUserName("tok")).rejects.toMatchObject({ code: "upstream_timeout" });

    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    await expect(getUserName("tok")).rejects.toMatchObject({
      code: "upstream_unreachable"
    });
  });

  it("aborts a hung request after the timeout budget", async () => {
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
    const pending = getUserName("tok");
    const assertion = expect(pending).rejects.toMatchObject({ code: "upstream_timeout" });
    await vi.advanceTimersByTimeAsync(16_000);
    await assertion;
  });
});

describe("getUserName", () => {
  it("returns the name, or null when absent/empty", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { name: "Brian Lane" }));
    expect(await getUserName("tok")).toBe("Brian Lane");
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url.startsWith(`${META_GRAPH_BASE_URL}/me?`)).toBe(true);

    fetchMock.mockResolvedValueOnce(jsonResponse(200, {}));
    expect(await getUserName("tok")).toBeNull();

    fetchMock.mockResolvedValueOnce(jsonResponse(200, { name: "" }));
    expect(await getUserName("tok")).toBeNull();
  });
});

describe("listManagedPages", () => {
  it("maps well-formed pages and skips malformed entries", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        data: [
          { id: "p1", name: "Page One", access_token: "pt1" },
          { id: "p2", access_token: "pt2" },
          { id: "p3", name: "No Token" },
          { name: "No Id", access_token: "x" },
          "garbage"
        ]
      })
    );
    const pages = await listManagedPages("user-tok");
    expect(pages).toEqual([
      { id: "p1", name: "Page One", accessToken: "pt1" },
      { id: "p2", name: "p2", accessToken: "pt2" }
    ]);
  });

  it("returns [] when data is not an array", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: "nope" }));
    expect(await listManagedPages("user-tok")).toEqual([]);
  });
});

describe("subscribePageToLeadgen", () => {
  it("POSTs subscribed_fields=leadgen and requires success:true", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { success: true }));
    await subscribePageToLeadgen("p1", "page-tok");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe("POST");
    const parsed = new URL(url);
    expect(parsed.pathname).toBe("/v24.0/p1/subscribed_apps");
    expect(parsed.searchParams.get("subscribed_fields")).toBe("leadgen");

    fetchMock.mockResolvedValueOnce(jsonResponse(200, { success: false }));
    await expect(subscribePageToLeadgen("p1", "page-tok")).rejects.toThrow(
      /not confirmed/
    );
  });
});

describe("unsubscribePage", () => {
  it("DELETEs the subscription and swallows failures", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { success: true }));
    await unsubscribePage("p1", "page-tok");
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe("DELETE");

    fetchMock.mockResolvedValueOnce(jsonResponse(500, { error: "boom" }));
    await expect(unsubscribePage("p1", "page-tok")).resolves.toBeUndefined();
  });
});

describe("flattenLeadFields", () => {
  it("flattens names to joined values and tolerates malformed rows", () => {
    expect(
      flattenLeadFields([
        { name: "full_name", values: ["Jane Doe"] },
        { name: "colors", values: ["red", "blue", 3] },
        { name: "empty_values", values: "not-array" },
        { name: "", values: ["skipped"] },
        { values: ["no name"] },
        "garbage"
      ])
    ).toEqual({
      full_name: "Jane Doe",
      colors: "red, blue",
      empty_values: ""
    });
    expect(flattenLeadFields(null)).toEqual({});
  });
});

describe("fetchLead", () => {
  it("returns the typed lead with flattened fields", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        id: "lead-1",
        created_time: "2026-07-14T00:00:00+0000",
        form_id: "form-1",
        ad_id: "ad-1",
        field_data: [{ name: "email", values: ["j@x.com"] }]
      })
    );
    const lead = await fetchLead("lead-1", "page-tok");
    expect(lead).toEqual({
      id: "lead-1",
      createdTime: "2026-07-14T00:00:00+0000",
      formId: "form-1",
      adId: "ad-1",
      fields: { email: "j@x.com" }
    });
  });

  it("falls back to the requested id and nulls for missing fields", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, {}));
    const lead = await fetchLead("lead-2", "page-tok");
    expect(lead).toEqual({
      id: "lead-2",
      createdTime: null,
      formId: null,
      adId: null,
      fields: {}
    });
  });
});

describe("verifyMetaWebhookSignature", () => {
  function sign(body: string): string {
    return `sha256=${createHmac("sha256", APP_SECRET).update(body, "utf8").digest("hex")}`;
  }

  it("accepts the correct signature and rejects everything else", () => {
    const body = JSON.stringify({ object: "page" });
    expect(verifyMetaWebhookSignature(body, sign(body))).toBe(true);
    expect(verifyMetaWebhookSignature(body, sign(`${body}x`))).toBe(false);
    expect(verifyMetaWebhookSignature(body, "sha256=deadbeef")).toBe(false);
    expect(verifyMetaWebhookSignature(body, "sha1=whatever")).toBe(false);
    expect(verifyMetaWebhookSignature(body, null)).toBe(false);
  });
});
