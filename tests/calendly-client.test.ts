/**
 * Tests for the direct Calendly API client (src/lib/calendly/client.ts):
 * PAT bearer requests with the Nango-compatible `{ data } | null` contract,
 * timeout/network error mapping, and token verification.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

import {
  calendlyDirectRequest,
  verifyCalendlyToken,
  CalendlyApiError
} from "@/lib/calendly/client";

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
  // mockReset (not clearAllMocks) so queued once-values never leak.
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("calendlyDirectRequest", () => {
  it("sends the PAT bearer + query params and returns the JSON body", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { collection: [] }));
    const res = await calendlyDirectRequest("pat-secret", {
      endpoint: "/event_types",
      method: "GET",
      params: { user: "https://api.calendly.com/users/U1", active: "true" }
    });
    expect(res).toEqual({ data: { collection: [] } });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://api.calendly.com/event_types?user=https%3A%2F%2Fapi.calendly.com%2Fusers%2FU1&active=true"
    );
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer pat-secret");
    expect(init.body).toBeUndefined();
  });

  it("serializes a JSON body with content-type", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(201, { resource: {} }));
    await calendlyDirectRequest("pat", {
      endpoint: "/scheduling_links",
      method: "POST",
      data: { max_event_count: 1 }
    });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.body).toBe('{"max_event_count":1}');
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
  });

  it("returns null on 401/403 (revoked or wrong PAT)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(401, {}));
    expect(await calendlyDirectRequest("pat", { endpoint: "/users/me", method: "GET" })).toBeNull();

    fetchMock.mockResolvedValueOnce(jsonResponse(403, {}));
    expect(await calendlyDirectRequest("pat", { endpoint: "/users/me", method: "GET" })).toBeNull();
  });

  it("throws request_failed on other non-2xx statuses, tolerating a failed body read", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(500, { error: "boom" }));
    await expect(
      calendlyDirectRequest("pat", { endpoint: "/users/me", method: "GET" })
    ).rejects.toMatchObject({ code: "request_failed", status: 500 });

    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 502,
      json: async () => ({}),
      text: async () => {
        throw new Error("stream died");
      }
    } as never);
    await expect(
      calendlyDirectRequest("pat", { endpoint: "/users/me", method: "GET" })
    ).rejects.toMatchObject({ code: "request_failed", status: 502 });
  });

  it("returns { data: null } for a non-JSON success body", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 204,
      json: async () => {
        throw new Error("empty");
      },
      text: async () => ""
    } as never);
    expect(
      await calendlyDirectRequest("pat", { endpoint: "/users/me", method: "GET" })
    ).toEqual({ data: null });
  });

  it("maps network failures and aborts to typed errors", async () => {
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    await expect(
      calendlyDirectRequest("pat", { endpoint: "/users/me", method: "GET" })
    ).rejects.toMatchObject({ code: "upstream_unreachable" });

    const abortErr = new Error("aborted");
    abortErr.name = "AbortError";
    fetchMock.mockRejectedValueOnce(abortErr);
    await expect(
      calendlyDirectRequest("pat", { endpoint: "/users/me", method: "GET" })
    ).rejects.toMatchObject({ code: "upstream_timeout" });
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
    const pending = calendlyDirectRequest("pat", { endpoint: "/users/me", method: "GET" });
    const assertion = expect(pending).rejects.toMatchObject({ code: "upstream_timeout" });
    await vi.advanceTimersByTimeAsync(16_000);
    await assertion;
  });
});

describe("verifyCalendlyToken", () => {
  it("returns the connected account's identity on success", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { resource: { name: "Acme Spa", email: "owner@acme.com" } })
    );
    expect(await verifyCalendlyToken("pat")).toEqual({
      ok: true,
      name: "Acme Spa",
      email: "owner@acme.com"
    });
  });

  it("nulls missing identity fields", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { resource: {} }));
    expect(await verifyCalendlyToken("pat")).toEqual({ ok: true, name: null, email: null });

    fetchMock.mockResolvedValueOnce(jsonResponse(200, {}));
    expect(await verifyCalendlyToken("pat")).toEqual({ ok: true, name: null, email: null });
  });

  it("reports an invalid token distinctly from a transport failure", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(401, {}));
    expect(await verifyCalendlyToken("pat")).toEqual({ ok: false, reason: "invalid_token" });

    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    expect(await verifyCalendlyToken("pat")).toEqual({ ok: false, reason: "request_failed" });
  });
});

describe("CalendlyApiError", () => {
  it("carries the code and status", () => {
    const err = new CalendlyApiError("request_failed", "nope", 503);
    expect(err.name).toBe("CalendlyApiError");
    expect(err.code).toBe("request_failed");
    expect(err.status).toBe(503);
  });
});
