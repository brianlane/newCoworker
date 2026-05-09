import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Stub DNS so the SSRF re-check (`assertSafeHostname`) doesn't hit the
// network for unit tests. Default lookup returns a public address; tests
// that exercise the private-IP / DNS-failure paths override this with
// `dnsLookupMock.mockImplementationOnce(...)`. Hoisted so the
// `vi.mock("node:dns")` factory captures the same reference.
const { dnsLookupMock } = vi.hoisted(() => ({
  dnsLookupMock: vi.fn(async () => [
    { address: "93.184.216.34", family: 4 } // example.com's public IP
  ])
}));
vi.mock("node:dns", () => ({
  promises: { lookup: dnsLookupMock }
}));

vi.mock("@/lib/db/custom-integrations", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/db/custom-integrations")
  >("@/lib/db/custom-integrations");
  return {
    ...actual,
    getCustomIntegrationByLabel: vi.fn()
  };
});

import { GET, POST, RESPONSE_MAX_BYTES } from "@/app/api/integrations/custom/call/route";
import { getCustomIntegrationByLabel } from "@/lib/db/custom-integrations";

const BIZ = "11111111-1111-4111-8111-111111111111";

const BASE_ROW = {
  id: "ci-1",
  business_id: BIZ,
  label: "Acme",
  base_url: "https://api.acme.com/v2",
  auth_scheme: "bearer" as const,
  header_name: null as string | null,
  description: null as string | null,
  is_active: true,
  secret: "super-secret",
  created_at: "2026-05-08T00:00:00Z",
  updated_at: "2026-05-08T00:00:00Z"
};

const ORIGINAL_TOKEN = process.env.ROWBOAT_GATEWAY_TOKEN;
const ORIGINAL_FETCH = globalThis.fetch;

/**
 * Test helper. The proxy route reads `businessId` from the URL query
 * string (NOT the JSON body) so the model has no input surface to
 * influence which tenant's credentials get used. To keep the tests
 * readable we accept `body.businessId` as a convenience and shuttle
 * it into the URL — pass `options.businessId === null` to omit it
 * entirely (used to test the "missing tenant" rejection path).
 */
function mkRequest(
  body: { businessId?: string } & Record<string, unknown>,
  options: {
    token?: string | null;
    businessId?: string | null;
    rawBody?: string;
  } = {}
): Request {
  const headers: Record<string, string> = {
    "Content-Type": "application/json"
  };
  const t = options.token === undefined ? "test-gateway-token" : options.token;
  if (t !== null) headers["Authorization"] = `Bearer ${t}`;
  const url = new URL("http://localhost/api/integrations/custom/call");
  // Resolution order for businessId-on-the-URL:
  //   1. options.businessId (explicit override; null means "omit entirely")
  //   2. body.businessId (convenience for tests written before tenant-
  //      binding moved to the URL)
  //   3. nothing (caller is testing the rejection path)
  const biz =
    options.businessId === undefined ? body.businessId ?? null : options.businessId;
  if (biz !== null) url.searchParams.set("businessId", biz);
  // body.businessId is removed before serialization so a stale field
  // can never silently authenticate a request — the route ignores it
  // anyway, but the test surface should match the wire contract.
  const { businessId: _ignored, ...wireBody } = body;
  void _ignored;
  return new Request(url.toString(), {
    method: "POST",
    headers,
    body: options.rawBody ?? JSON.stringify(wireBody)
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.ROWBOAT_GATEWAY_TOKEN = "test-gateway-token";
  process.env.INTEGRATIONS_ENCRYPTION_KEY = "test-key-for-call-route";
  vi.mocked(getCustomIntegrationByLabel).mockResolvedValue({ ...BASE_ROW });
});

afterEach(() => {
  process.env.ROWBOAT_GATEWAY_TOKEN = ORIGINAL_TOKEN;
  globalThis.fetch = ORIGINAL_FETCH;
});

describe("auth", () => {
  it("rejects requests without the gateway bearer", async () => {
    const res = await POST(mkRequest({ businessId: BIZ, label: "Acme" }, { token: null }));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.detail).toBe("unauthorized");
  });

  it("rejects requests with a wrong bearer", async () => {
    const res = await POST(mkRequest({ businessId: BIZ, label: "Acme" }, { token: "nope" }));
    expect(res.status).toBe(401);
  });
});

// Bugbot P1: "Bind custom integration calls to the tenant".
// businessId comes from the URL query, NOT the JSON body. These
// tests pin that contract so the model can never smuggle another
// business UUID through a prompt-injection.
describe("tenant binding (URL query)", () => {
  it("rejects when ?businessId is missing entirely", async () => {
    const res = await POST(
      mkRequest({ label: "Acme" }, { businessId: null })
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.detail).toBe("invalid_args:missing_business_id");
    // Critically: the lookup is never invoked, so we cannot leak a
    // credential to a caller that didn't bind a tenant.
    expect(getCustomIntegrationByLabel).not.toHaveBeenCalled();
  });

  it("rejects when ?businessId is not a valid UUID", async () => {
    const res = await POST(
      mkRequest({ label: "Acme" }, { businessId: "not-a-uuid" })
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.detail).toBe("invalid_args:missing_business_id");
    expect(getCustomIntegrationByLabel).not.toHaveBeenCalled();
  });

  it("ignores `businessId` in the JSON body (model can't override the URL)", async () => {
    // Even if a prompt-injected agent stuffs another business UUID
    // in the body, the route uses ONLY the URL query value. Here we
    // smuggle a different UUID into the raw body and confirm the
    // lookup is called with the URL value — proving the body field
    // is dead weight.
    const otherBiz = "22222222-2222-4222-8222-222222222222";
    globalThis.fetch = vi.fn(
      async () =>
        new Response("{}", {
          status: 200,
          headers: { "Content-Type": "application/json" }
        })
    ) as never;
    await POST(
      mkRequest(
        {},
        {
          businessId: BIZ,
          rawBody: JSON.stringify({
            businessId: otherBiz,
            label: "Acme",
            path: "/x"
          })
        }
      )
    );
    expect(getCustomIntegrationByLabel).toHaveBeenCalledWith(
      BIZ, // ← URL query wins; body's `otherBiz` is ignored
      "Acme"
    );
  });
});

describe("validation", () => {
  it("rejects malformed body", async () => {
    const res = await POST(mkRequest({ businessId: BIZ }));
    expect(res.status).toBe(400);
  });

  it("returns 'invalid body' when JSON parse fails (non-Zod path)", async () => {
    const res = await POST(
      mkRequest({ businessId: BIZ }, { rawBody: "this is not json" })
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.detail).toMatch(/invalid_args:/);
  });

  it("rejects unsupported HTTP methods", async () => {
    const res = await POST(
      mkRequest({ businessId: BIZ, label: "Acme", method: "HEAD" })
    );
    expect(res.status).toBe(400);
  });

  it("rejects path that doesn't start with /", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as never;
    const res = await POST(
      mkRequest({ businessId: BIZ, label: "Acme", path: "evil" })
    );
    const body = await res.json();
    expect(body.detail).toBe("path_invalid");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects '..' segments in the path", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as never;
    const res = await POST(
      mkRequest({ businessId: BIZ, label: "Acme", path: "/foo/../bar" })
    );
    const body = await res.json();
    expect(body.detail).toBe("path_invalid");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects scheme-relative path that would pivot host", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as never;
    const res = await POST(
      mkRequest({ businessId: BIZ, label: "Acme", path: "//evil.example/" })
    );
    const body = await res.json();
    expect(body.detail).toBe("path_invalid");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects backslash-bearing paths (WHATWG URL pivots them too)", async () => {
    // WHATWG URL treats `\` as equivalent to `/` during authority
    // detection for special schemes (https/http), so a path like
    // `/\evil.example/` would resolve to `https://evil.example/`
    // and silently pivot the host. The proxy must refuse before fetch.
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as never;
    for (const path of ["/\\evil.example/", "/foo\\bar", "\\backslash"]) {
      fetchMock.mockClear();
      const res = await POST(
        mkRequest({ businessId: BIZ, label: "Acme", path })
      );
      const body = await res.json();
      expect(body.detail).toBe("path_invalid");
      expect(fetchMock).not.toHaveBeenCalled();
    }
  });
});

describe("integration resolution", () => {
  it("returns integration_not_found when label doesn't match", async () => {
    vi.mocked(getCustomIntegrationByLabel).mockResolvedValueOnce(null);
    const res = await POST(mkRequest({ businessId: BIZ, label: "Nope" }));
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.detail).toBe("integration_not_found");
  });

  it("returns integration_disabled when row is_active=false", async () => {
    vi.mocked(getCustomIntegrationByLabel).mockResolvedValueOnce({
      ...BASE_ROW,
      is_active: false
    });
    const res = await POST(mkRequest({ businessId: BIZ, label: "Acme" }));
    const body = await res.json();
    expect(body.detail).toBe("integration_disabled");
  });

  it("returns 500 with detail=lookup_failed when DB throws", async () => {
    vi.mocked(getCustomIntegrationByLabel).mockRejectedValueOnce(new Error("db down"));
    const res = await POST(mkRequest({ businessId: BIZ, label: "Acme" }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.detail).toBe("lookup_failed");
  });

  it("survives a non-Error rejection from the lookup (string thrown)", async () => {
    vi.mocked(getCustomIntegrationByLabel).mockRejectedValueOnce("non-error rejection");
    const res = await POST(mkRequest({ businessId: BIZ, label: "Acme" }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.detail).toBe("lookup_failed");
  });
});

describe("auth scheme injection", () => {
  function captureFetch() {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchMock = vi.fn(async (url: string | URL | Request, init: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ ok: 1 }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    });
    globalThis.fetch = fetchMock as never;
    return { calls };
  }

  it("injects bearer token", async () => {
    const { calls } = captureFetch();
    await POST(mkRequest({ businessId: BIZ, label: "Acme", path: "/contacts" }));
    expect(calls).toHaveLength(1);
    const headers = calls[0].init.headers as Headers;
    expect(headers.get("Authorization")).toBe("Bearer super-secret");
  });

  it("injects custom header", async () => {
    vi.mocked(getCustomIntegrationByLabel).mockResolvedValueOnce({
      ...BASE_ROW,
      auth_scheme: "header",
      header_name: "X-API-Key"
    });
    const { calls } = captureFetch();
    await POST(mkRequest({ businessId: BIZ, label: "Acme", path: "/x" }));
    const headers = calls[0].init.headers as Headers;
    expect(headers.get("X-API-Key")).toBe("super-secret");
  });

  it("injects basic auth", async () => {
    vi.mocked(getCustomIntegrationByLabel).mockResolvedValueOnce({
      ...BASE_ROW,
      auth_scheme: "basic",
      secret: "user:pw"
    });
    const { calls } = captureFetch();
    await POST(mkRequest({ businessId: BIZ, label: "Acme", path: "/x" }));
    const headers = calls[0].init.headers as Headers;
    expect(headers.get("Authorization")).toBe(
      `Basic ${Buffer.from("user:pw").toString("base64")}`
    );
  });

  it("injects query parameter and overrides agent-supplied collision", async () => {
    vi.mocked(getCustomIntegrationByLabel).mockResolvedValueOnce({
      ...BASE_ROW,
      auth_scheme: "query",
      header_name: "api_key"
    });
    const { calls } = captureFetch();
    await POST(
      mkRequest({
        businessId: BIZ,
        label: "Acme",
        path: "/x",
        query: { api_key: "agent-tried-this", q: "hello" }
      })
    );
    const url = new URL(calls[0].url);
    expect(url.searchParams.get("api_key")).toBe("super-secret");
    expect(url.searchParams.get("q")).toBe("hello");
  });

  it("scheme=none does not inject a credential", async () => {
    vi.mocked(getCustomIntegrationByLabel).mockResolvedValueOnce({
      ...BASE_ROW,
      auth_scheme: "none",
      secret: null
    });
    const { calls } = captureFetch();
    await POST(mkRequest({ businessId: BIZ, label: "Acme", path: "/x" }));
    const headers = calls[0].init.headers as Headers;
    expect(headers.get("Authorization")).toBeNull();
  });

  it("returns 500 secret_missing when scheme requires a secret but none is stored", async () => {
    vi.mocked(getCustomIntegrationByLabel).mockResolvedValueOnce({
      ...BASE_ROW,
      secret: null
    });
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as never;
    const res = await POST(mkRequest({ businessId: BIZ, label: "Acme", path: "/x" }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.detail).toBe("secret_missing");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("URL composition", () => {
  it("appends path to base_url's pathPrefix", async () => {
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      calls.push(String(url));
      return new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }) as never;
    await POST(mkRequest({ businessId: BIZ, label: "Acme", path: "/contacts/42" }));
    expect(calls[0]).toBe("https://api.acme.com/v2/contacts/42");
  });

  it("preserves agent-supplied query params", async () => {
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      calls.push(String(url));
      return new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }) as never;
    await POST(
      mkRequest({
        businessId: BIZ,
        label: "Acme",
        path: "/search",
        query: { q: "tom", limit: 10 }
      })
    );
    const url = new URL(calls[0]);
    expect(url.searchParams.get("q")).toBe("tom");
    expect(url.searchParams.get("limit")).toBe("10");
  });

  it("blocks private host even if a row was somehow saved with one", async () => {
    vi.mocked(getCustomIntegrationByLabel).mockResolvedValueOnce({
      ...BASE_ROW,
      base_url: "https://localhost/x"
    });
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as never;
    const res = await POST(mkRequest({ businessId: BIZ, label: "Acme", path: "/x" }));
    const body = await res.json();
    // parseBaseUrl rejects with detail=base_url_invalid (via thrown
    // error → 500 with detail=base_url_invalid)
    expect(body.detail).toBe("base_url_invalid");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("header sanitization", () => {
  it("strips Authorization/Cookie/Host from agent-supplied headers", async () => {
    const calls: { init: RequestInit }[] = [];
    globalThis.fetch = vi.fn(async (_u: unknown, init: RequestInit) => {
      calls.push({ init });
      return new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }) as never;
    await POST(
      mkRequest({
        businessId: BIZ,
        label: "Acme",
        path: "/x",
        headers: {
          Authorization: "Bearer attacker",
          Cookie: "session=evil",
          Host: "evil.example",
          "X-Custom": "ok"
        }
      })
    );
    const headers = calls[0].init.headers as Headers;
    expect(headers.get("Authorization")).toBe("Bearer super-secret");
    expect(headers.get("Cookie")).toBeNull();
    expect(headers.get("Host")).toBeNull();
    expect(headers.get("X-Custom")).toBe("ok");
  });

  it("blocks the agent from setting the configured header_name (scheme=header)", async () => {
    vi.mocked(getCustomIntegrationByLabel).mockResolvedValueOnce({
      ...BASE_ROW,
      auth_scheme: "header",
      header_name: "X-API-Key"
    });
    const calls: { init: RequestInit }[] = [];
    globalThis.fetch = vi.fn(async (_u: unknown, init: RequestInit) => {
      calls.push({ init });
      return new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }) as never;
    await POST(
      mkRequest({
        businessId: BIZ,
        label: "Acme",
        path: "/x",
        headers: { "x-api-key": "agent-tried", "X-Other": "ok" }
      })
    );
    const headers = calls[0].init.headers as Headers;
    expect(headers.get("X-API-Key")).toBe("super-secret");
    expect(headers.get("X-Other")).toBe("ok");
  });
});

describe("response handling", () => {
  it("forwards JSON status + parsed body", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ contact: { id: 7 } }), {
          status: 201,
          headers: { "Content-Type": "application/json" }
        })
    ) as never;
    const res = await POST(mkRequest({ businessId: BIZ, label: "Acme", path: "/x" }));
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.status).toBe(201);
    expect(body.data.data.contact.id).toBe(7);
  });

  it("forwards text body when upstream returns non-JSON", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response("plain text response", {
          status: 200,
          headers: { "Content-Type": "text/plain" }
        })
    ) as never;
    const res = await POST(mkRequest({ businessId: BIZ, label: "Acme", path: "/x" }));
    const body = await res.json();
    expect(body.data.data).toBe("plain text response");
  });

  it("truncates when upstream body exceeds RESPONSE_MAX_BYTES", async () => {
    const huge = "x".repeat(RESPONSE_MAX_BYTES + 100);
    globalThis.fetch = vi.fn(
      async () =>
        new Response(huge, {
          status: 200,
          headers: { "Content-Type": "text/plain" }
        })
    ) as never;
    const res = await POST(mkRequest({ businessId: BIZ, label: "Acme", path: "/x" }));
    const body = await res.json();
    expect(body.data.truncated).toBe(true);
    // The bytes that fit MUST be returned; previously the whole
    // overflowing chunk was discarded and the agent got `data:""`.
    expect(typeof body.data.data).toBe("string");
    expect((body.data.data as string).length).toBe(RESPONSE_MAX_BYTES);
  });

  it("truncates a single oversized first chunk and still returns RESPONSE_MAX_BYTES bytes", async () => {
    // Single chunk much larger than the cap. Without the partial-
    // chunk fix this test would fail: chunks would stay empty and
    // body.data.data would be "".
    const oversized = new Uint8Array(RESPONSE_MAX_BYTES * 2).fill(0x41);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(oversized);
        controller.close();
      }
    });
    globalThis.fetch = vi.fn(
      async () =>
        new Response(stream, {
          status: 200,
          headers: { "Content-Type": "text/plain" }
        })
    ) as never;
    const res = await POST(mkRequest({ businessId: BIZ, label: "Acme", path: "/x" }));
    const body = await res.json();
    expect(body.data.truncated).toBe(true);
    expect((body.data.data as string).length).toBe(RESPONSE_MAX_BYTES);
  });

  it("filters response headers to a safe allowlist", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response("{}", {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "X-RateLimit-Remaining": "42",
            "Set-Cookie": "session=abc",
            Authorization: "Bearer leak"
          }
        })
    ) as never;
    const res = await POST(mkRequest({ businessId: BIZ, label: "Acme", path: "/x" }));
    const body = await res.json();
    const lowered = Object.fromEntries(
      Object.entries(body.data.headers).map(([k, v]) => [k.toLowerCase(), v])
    );
    expect(lowered["x-ratelimit-remaining"]).toBe("42");
    expect(lowered["set-cookie"]).toBeUndefined();
    expect(lowered["authorization"]).toBeUndefined();
  });

  it("returns 502 + upstream_unreachable on fetch error", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("network down");
    }) as never;
    const res = await POST(mkRequest({ businessId: BIZ, label: "Acme", path: "/x" }));
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.detail).toBe("upstream_unreachable");
  });

  it("returns 502 + upstream_timeout on AbortError", async () => {
    globalThis.fetch = vi.fn(async () => {
      const e = new Error("aborted");
      e.name = "AbortError";
      throw e;
    }) as never;
    const res = await POST(mkRequest({ businessId: BIZ, label: "Acme", path: "/x" }));
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.detail).toBe("upstream_timeout");
  });

  it("survives a non-Error rejection from the upstream fetch", async () => {
    globalThis.fetch = vi.fn(async () => {
      // Some libraries throw POJOs / strings instead of Error subclasses;
      // the route is expected to coerce via `String(err)` and still return
      // upstream_unreachable.
      throw "raw string rejection";
    }) as never;
    const res = await POST(mkRequest({ businessId: BIZ, label: "Acme", path: "/x" }));
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.detail).toBe("upstream_unreachable");
  });
});

describe("auth scheme misconfiguration", () => {
  it("returns header_name_missing when scheme=header but header_name is null", async () => {
    vi.mocked(getCustomIntegrationByLabel).mockResolvedValueOnce({
      ...BASE_ROW,
      auth_scheme: "header",
      header_name: null
    });
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as never;
    const res = await POST(mkRequest({ businessId: BIZ, label: "Acme", path: "/x" }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.detail).toBe("header_name_missing");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns header_name_missing when scheme=query but header_name is null", async () => {
    vi.mocked(getCustomIntegrationByLabel).mockResolvedValueOnce({
      ...BASE_ROW,
      auth_scheme: "query",
      header_name: null
    });
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as never;
    const res = await POST(mkRequest({ businessId: BIZ, label: "Acme", path: "/x" }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.detail).toBe("header_name_missing");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("URL composition extras", () => {
  it("supports a row whose base_url has no path prefix (just host)", async () => {
    vi.mocked(getCustomIntegrationByLabel).mockResolvedValueOnce({
      ...BASE_ROW,
      base_url: "https://api.acme.com"
    });
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      calls.push(String(url));
      return new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }) as never;
    await POST(mkRequest({ businessId: BIZ, label: "Acme", path: "/contacts" }));
    expect(calls[0]).toBe("https://api.acme.com/contacts");
  });
});

describe("GET on call route", () => {
  it("returns 405 with VALIDATION_ERROR envelope", async () => {
    const res = await GET();
    expect(res.status).toBe(405);
    const body = await res.json();
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });
});

describe("response handling extras", () => {
  it("falls back to text when upstream JSON is invalid", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response("not json {", {
          status: 200,
          headers: { "Content-Type": "application/json" }
        })
    ) as never;
    const res = await POST(mkRequest({ businessId: BIZ, label: "Acme", path: "/x" }));
    const body = await res.json();
    expect(body.data.data).toBe("not json {");
  });

  it("handles upstream with no body", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response(null, { status: 204 })
    ) as never;
    const res = await POST(mkRequest({ businessId: BIZ, label: "Acme", path: "/x" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.status).toBe(204);
  });
});

describe("body forwarding extras", () => {
  it("forwards a string body when contentType is non-JSON", async () => {
    const calls: { init: RequestInit }[] = [];
    globalThis.fetch = vi.fn(async (_u: unknown, init: RequestInit) => {
      calls.push({ init });
      return new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }) as never;
    await POST(
      mkRequest({
        businessId: BIZ,
        label: "Acme",
        method: "POST",
        path: "/x",
        body: "raw=string&payload=ok",
        contentType: "application/x-www-form-urlencoded"
      })
    );
    expect(calls[0].init.body).toBe("raw=string&payload=ok");
  });

  it("JSON-stringifies a non-string body when contentType is non-JSON", async () => {
    const calls: { init: RequestInit }[] = [];
    globalThis.fetch = vi.fn(async (_u: unknown, init: RequestInit) => {
      calls.push({ init });
      return new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }) as never;
    await POST(
      mkRequest({
        businessId: BIZ,
        label: "Acme",
        method: "POST",
        path: "/x",
        body: { x: 1 },
        contentType: "text/plain"
      })
    );
    expect(calls[0].init.body).toBe(JSON.stringify({ x: 1 }));
  });
});

describe("timeout (real abort)", () => {
  it("aborts a slow upstream and returns upstream_timeout", async () => {
    vi.useFakeTimers();
    try {
      // Stand up a fetch that returns a never-resolving promise but
      // listens to the AbortSignal so we can verify the abort path.
      const fetchMock = vi.fn(async (_u: unknown, init: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        });
      });
      globalThis.fetch = fetchMock as never;
      const promise = POST(
        mkRequest({ businessId: BIZ, label: "Acme", path: "/x" })
      );
      // Advance past REQUEST_TIMEOUT_MS so the setTimeout fires.
      await vi.advanceTimersByTimeAsync(20_001);
      const res = await promise;
      expect(res.status).toBe(502);
      const body = await res.json();
      expect(body.detail).toBe("upstream_timeout");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("body forwarding", () => {
  it("forwards JSON body on POST", async () => {
    const calls: { init: RequestInit }[] = [];
    globalThis.fetch = vi.fn(async (_u: unknown, init: RequestInit) => {
      calls.push({ init });
      return new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }) as never;
    await POST(
      mkRequest({
        businessId: BIZ,
        label: "Acme",
        method: "POST",
        path: "/contacts",
        body: { name: "Jane" }
      })
    );
    expect(calls[0].init.body).toBe(JSON.stringify({ name: "Jane" }));
    const headers = calls[0].init.headers as Headers;
    expect(headers.get("Content-Type")).toBe("application/json");
  });

  it("forwards `null` body when JSON content type but body is null", async () => {
    const calls: { init: RequestInit }[] = [];
    globalThis.fetch = vi.fn(async (_u: unknown, init: RequestInit) => {
      calls.push({ init });
      return new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }) as never;
    await POST(
      mkRequest({
        businessId: BIZ,
        label: "Acme",
        method: "POST",
        path: "/x",
        body: null
      })
    );
    expect(calls[0].init.body).toBe(JSON.stringify(null));
  });

  it("does not send a body on GET even if body is supplied", async () => {
    const calls: { init: RequestInit }[] = [];
    globalThis.fetch = vi.fn(async (_u: unknown, init: RequestInit) => {
      calls.push({ init });
      return new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }) as never;
    await POST(
      mkRequest({
        businessId: BIZ,
        label: "Acme",
        method: "GET",
        path: "/x",
        body: { ignored: true }
      })
    );
    expect(calls[0].init.body).toBeUndefined();
  });
});

describe("SSRF (DNS resolution)", () => {
  it("rejects when hostname resolves to a private IPv4", async () => {
    // Public-looking host (`api.acme.com`) that secretly resolves to a
    // 10.0.0.0/8 address. Without the DNS pre-check this would happily
    // proxy a stored credential to a LAN admin panel.
    dnsLookupMock.mockImplementationOnce(async () => [
      { address: "10.0.0.5", family: 4 }
    ]);
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as never;
    const res = await POST(mkRequest({ businessId: BIZ, label: "Acme", path: "/x" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.detail).toBe("private_host_blocked");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects when hostname resolves to a private IPv6", async () => {
    dnsLookupMock.mockImplementationOnce(async () => [
      { address: "fc00::1", family: 6 }
    ]);
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as never;
    const res = await POST(mkRequest({ businessId: BIZ, label: "Acme", path: "/x" }));
    const body = await res.json();
    expect(body.detail).toBe("private_host_blocked");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects when hostname resolves to a mix of public and private addresses", async () => {
    // An attacker-controlled DNS server might serve both a public and a
    // private record so a happy-eyeballs implementation prefers the
    // private one. We must reject if ANY returned address is private.
    dnsLookupMock.mockImplementationOnce(async () => [
      { address: "8.8.8.8", family: 4 },
      { address: "127.0.0.1", family: 4 }
    ]);
    const res = await POST(mkRequest({ businessId: BIZ, label: "Acme", path: "/x" }));
    const body = await res.json();
    expect(body.detail).toBe("private_host_blocked");
  });

  it("returns 502 + upstream_unreachable when DNS lookup itself fails", async () => {
    dnsLookupMock.mockImplementationOnce(async () => {
      throw new Error("ENOTFOUND");
    });
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as never;
    const res = await POST(mkRequest({ businessId: BIZ, label: "Acme", path: "/x" }));
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.detail).toBe("upstream_unreachable");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("body read timeout", () => {
  // The fetch timeout must remain active during the body-read loop —
  // an upstream that sends headers promptly but stalls mid-body would
  // otherwise hang the worker indefinitely.
  it("returns 502 + upstream_timeout when the body stream aborts", async () => {
    const abortErr = new Error("aborted");
    abortErr.name = "AbortError";
    const stallingStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(abortErr);
      }
    });
    globalThis.fetch = vi.fn(
      async () =>
        new Response(stallingStream, {
          status: 200,
          headers: { "Content-Type": "application/json" }
        })
    ) as never;
    const res = await POST(mkRequest({ businessId: BIZ, label: "Acme", path: "/x" }));
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.detail).toBe("upstream_timeout");
  });

  it("returns 502 + upstream_body_failed on non-abort body stream errors", async () => {
    const stallingStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("network reset mid-body"));
      }
    });
    globalThis.fetch = vi.fn(
      async () =>
        new Response(stallingStream, {
          status: 200,
          headers: { "Content-Type": "application/json" }
        })
    ) as never;
    const res = await POST(mkRequest({ businessId: BIZ, label: "Acme", path: "/x" }));
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.detail).toBe("upstream_body_failed");
  });
});
