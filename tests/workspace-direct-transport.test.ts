/**
 * The direct transport must be behaviorally indistinguishable from
 * `nango.proxy()`, because the ~58 call sites are shared and cannot tell which
 * transport served them. These cases pin the four details that are easy to get
 * subtly wrong (query merging onto an endpoint that already has a query, bare
 * headers, `data: {}` still sending a body, and an empty 204 body being "")
 * plus the throw-on-non-2xx contract the status-branching wrapper depends on.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  directProviderRequest,
  DirectTransportError,
  DirectTransportUnreachable,
  DIRECT_TRANSPORT_TIMEOUT_MS
} from "@/lib/workspace/direct-transport";

const BASE = "https://graph.microsoft.com";
const TOKEN = "tok-1";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

function lastCall() {
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  return { url, init, headers: init.headers as Record<string, string> };
}

describe("directProviderRequest", () => {
  it("sends a bearer GET and returns { status, data }", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ id: "m1" }));

    const res = await directProviderRequest(BASE, TOKEN, {
      endpoint: "/v1.0/me",
      method: "GET"
    });

    expect(res).toEqual({ status: 200, data: { id: "m1" } });
    const { url, init, headers } = lastCall();
    expect(url).toBe("https://graph.microsoft.com/v1.0/me");
    expect(init.method).toBe("GET");
    expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(init.body).toBeUndefined();
  });

  it("defaults the method to GET", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));
    await directProviderRequest(BASE, TOKEN, { endpoint: "/v1.0/me" });
    expect(lastCall().init.method).toBe("GET");
  });

  it("trims a trailing slash off the base url", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));
    await directProviderRequest(`${BASE}/`, TOKEN, { endpoint: "/v1.0/me" });
    expect(lastCall().url).toBe("https://graph.microsoft.com/v1.0/me");
  });

  it("merges params onto an endpoint that ALREADY carries a query string", async () => {
    // The calendar poller builds its own ?$select= and then passes params too;
    // Nango merges rather than replaces, so this must not drop $select.
    fetchMock.mockResolvedValue(jsonResponse({}));

    await directProviderRequest(BASE, TOKEN, {
      endpoint: "/v1.0/me/calendarView?$select=id,subject",
      params: { startDateTime: "2026-08-01T00:00:00Z", top: 25, all: true }
    });

    const parsed = new URL(lastCall().url);
    expect(parsed.searchParams.get("$select")).toBe("id,subject");
    expect(parsed.searchParams.get("startDateTime")).toBe("2026-08-01T00:00:00Z");
    expect(parsed.searchParams.get("top")).toBe("25");
    expect(parsed.searchParams.get("all")).toBe("true");
  });

  it("passes custom headers through UNPREFIXED", async () => {
    // Nango transmits these as Nango-Proxy-<k> and strips the prefix server
    // side. With no middleman they must arrive verbatim.
    fetchMock.mockResolvedValue(jsonResponse({}));

    await directProviderRequest(BASE, TOKEN, {
      endpoint: "/v1.0/me/calendarView",
      headers: { Prefer: 'outlook.timezone="UTC"' }
    });

    expect(lastCall().headers.Prefer).toBe('outlook.timezone="UTC"');
  });

  it("sends a JSON body on POST", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }, 202));

    const res = await directProviderRequest(BASE, TOKEN, {
      endpoint: "/v1.0/me/sendMail",
      method: "POST",
      data: { message: { subject: "hi" } }
    });

    expect(res.status).toBe(202);
    const { init, headers } = lastCall();
    expect(headers["Content-Type"]).toBe("application/json");
    expect(init.body).toBe(JSON.stringify({ message: { subject: "hi" } }));
  });

  it("still sends a body for data: {} (empty object is not 'no body')", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));

    await directProviderRequest(BASE, TOKEN, {
      endpoint: "/gmail/v1/users/me/messages/1/trash",
      method: "POST",
      data: {}
    });

    expect(lastCall().init.body).toBe("{}");
  });

  it("sends no body when data is absent", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));
    await directProviderRequest(BASE, TOKEN, { endpoint: "/x", method: "POST" });
    const { init, headers } = lastCall();
    expect(init.body).toBeUndefined();
    expect(headers["Content-Type"]).toBeUndefined();
  });

  it("never sends a body on GET even when data is supplied", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));
    await directProviderRequest(BASE, TOKEN, {
      endpoint: "/x",
      method: "GET",
      data: { a: 1 }
    });
    expect(lastCall().init.body).toBeUndefined();
  });

  it("uppercases a lowercase method", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));
    await directProviderRequest(BASE, TOKEN, { endpoint: "/x", method: "patch" });
    expect(lastCall().init.method).toBe("PATCH");
  });

  it("returns data === '' for an empty 204 (Graph event delete)", async () => {
    // axios's default transformResponse leaves an empty body as "", not null.
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));

    const res = await directProviderRequest(BASE, TOKEN, {
      endpoint: "/v1.0/me/events/e1",
      method: "DELETE"
    });

    expect(res).toEqual({ status: 204, data: "" });
  });

  it("returns the raw text when the body is not JSON", async () => {
    fetchMock.mockResolvedValue(new Response("plain words", { status: 200 }));
    const res = await directProviderRequest(BASE, TOKEN, { endpoint: "/x" });
    expect(res.data).toBe("plain words");
  });

  it("treats an unreadable body as empty rather than throwing", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.reject(new Error("stream broke"))
    } as unknown as Response);

    const res = await directProviderRequest(BASE, TOKEN, { endpoint: "/x" });
    expect(res).toEqual({ status: 200, data: "" });
  });

  it.each([401, 403, 404, 429, 500])("throws DirectTransportError on %i", async (status) => {
    fetchMock.mockResolvedValue(jsonResponse({ error: { code: "boom" } }, status));

    const err = await directProviderRequest(BASE, TOKEN, { endpoint: "/x" }).catch(
      (e: unknown) => e
    );

    expect(err).toBeInstanceOf(DirectTransportError);
    // The axios-shaped `response` is what proxyErrorResponse destructures, so
    // the status-branching wrapper keeps working across both transports.
    expect((err as DirectTransportError).response).toEqual({
      status,
      data: { error: { code: "boom" } }
    });
    expect((err as DirectTransportError).code).toBe("request_failed");
  });

  it("throws upstream_timeout when the request aborts", async () => {
    const abort = new Error("aborted");
    abort.name = "AbortError";
    fetchMock.mockRejectedValue(abort);

    const err = await directProviderRequest(BASE, TOKEN, { endpoint: "/x" }).catch(
      (e: unknown) => e
    );

    expect(err).toBeInstanceOf(DirectTransportUnreachable);
    expect((err as DirectTransportUnreachable).code).toBe("upstream_timeout");
  });

  it("throws upstream_unreachable on a network failure", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));

    const err = await directProviderRequest(BASE, TOKEN, { endpoint: "/x" }).catch(
      (e: unknown) => e
    );

    expect(err).toBeInstanceOf(DirectTransportUnreachable);
    expect((err as DirectTransportUnreachable).code).toBe("upstream_unreachable");
  });

  it("aborts the request once the timeout elapses", async () => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      fetchMock.mockImplementation((_url: string, init: RequestInit) => {
        signal = init.signal as AbortSignal;
        return new Promise(() => {});
      });

      void directProviderRequest(BASE, TOKEN, { endpoint: "/x" });
      await Promise.resolve();
      expect(signal?.aborted).toBe(false);

      vi.advanceTimersByTime(DIRECT_TRANSPORT_TIMEOUT_MS);
      expect(signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
