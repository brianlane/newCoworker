import { describe, expect, it, vi } from "vitest";
import { TelnyxPortingClient } from "@/lib/telnyx/porting";
import { TelnyxApiError, DEFAULT_TELNYX_API_BASE_URL } from "@/lib/telnyx/numbers";

/**
 * Coverage for src/lib/telnyx/porting.ts — same mocked-fetch approach as
 * tests/telnyx-numbers.test.ts: pin the wire shape (method, path, headers,
 * body) each wrapper produces so a drive-by edit breaks a fast unit test
 * instead of a live port.
 */

function mockFetch(
  handler: (url: string, init: RequestInit) => Promise<Response> | Response
): typeof fetch {
  const m = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    return handler(url, init ?? {});
  });
  return m as unknown as typeof fetch;
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init
  });
}

describe("TelnyxPortingClient", () => {
  it("throws if apiKey is missing", () => {
    expect(() => new TelnyxPortingClient({ apiKey: "" })).toThrow(/apiKey is required/);
    expect(() => new TelnyxPortingClient({ apiKey: "  " })).toThrow(/apiKey is required/);
  });

  it("constructs with defaults (global fetch, default timeout)", () => {
    expect(new TelnyxPortingClient({ apiKey: "k" })).toBeInstanceOf(TelnyxPortingClient);
  });

  it("uses the default base URL and strips a trailing slash from a custom one", async () => {
    let url = "";
    const fetchImpl = mockFetch((u) => {
      url = u;
      return jsonResponse({ data: [] });
    });
    const c = new TelnyxPortingClient({ apiKey: "k", fetchImpl });
    await c.checkPortability(["+13125550001"]);
    expect(url).toBe(`${DEFAULT_TELNYX_API_BASE_URL}/portability_checks`);

    const c2 = new TelnyxPortingClient({
      apiKey: "k",
      fetchImpl: mockFetch((u) => {
        url = u;
        return jsonResponse({ data: [] });
      }),
      baseUrl: "https://example.test/v2/"
    });
    await c2.checkPortability(["+13125550001"]);
    expect(url).toBe("https://example.test/v2/portability_checks");
  });

  describe("checkPortability", () => {
    it("POSTs phone_numbers and returns the results", async () => {
      let capturedInit: RequestInit = {};
      const fetchImpl = mockFetch((_url, init) => {
        capturedInit = init;
        return jsonResponse({
          data: [
            { phone_number: "+13125550001", portable: true, fast_portable: true },
            {
              phone_number: "+13125550002",
              portable: false,
              fast_portable: false,
              not_portable_reason: "no_coverage"
            }
          ]
        });
      });
      const client = new TelnyxPortingClient({ apiKey: "KEY", fetchImpl, userAgent: "ua-test" });
      const results = await client.checkPortability(["+13125550001", "+13125550002"]);
      expect(results).toHaveLength(2);
      expect(results[0].fast_portable).toBe(true);
      expect(results[1].not_portable_reason).toBe("no_coverage");
      expect(capturedInit.method).toBe("POST");
      expect(JSON.parse(String(capturedInit.body))).toEqual({
        phone_numbers: ["+13125550001", "+13125550002"]
      });
      const headers = capturedInit.headers as Record<string, string>;
      expect(headers["Authorization"]).toBe("Bearer KEY");
      expect(headers["Content-Type"]).toBe("application/json");
      expect(headers["User-Agent"]).toBe("ua-test");
    });

    it("returns [] when data is missing and validates input", async () => {
      const client = new TelnyxPortingClient({
        apiKey: "k",
        fetchImpl: mockFetch(() => jsonResponse({}))
      });
      expect(await client.checkPortability(["+13125550001"])).toEqual([]);
      await expect(client.checkPortability([])).rejects.toThrow(/phoneNumbers is required/);
    });
  });

  describe("createPortingOrder", () => {
    it("POSTs numbers (+ trimmed customer_reference) and returns the split orders", async () => {
      let capturedBody: Record<string, unknown> = {};
      let url = "";
      const fetchImpl = mockFetch((u, init) => {
        url = u;
        capturedBody = JSON.parse(String(init.body));
        return jsonResponse({
          data: [{ id: "po-1", status: { value: "draft", details: [] } }]
        });
      });
      const client = new TelnyxPortingClient({ apiKey: "k", fetchImpl });
      const orders = await client.createPortingOrder({
        phoneNumbers: ["+13125550001"],
        customerReference: "x".repeat(400)
      });
      expect(url).toContain("/porting_orders");
      expect(orders).toEqual([{ id: "po-1", status: { value: "draft", details: [] } }]);
      expect(capturedBody.phone_numbers).toEqual(["+13125550001"]);
      expect((capturedBody.customer_reference as string).length).toBe(250);
    });

    it("omits customer_reference when absent, returns [] when data missing, validates input", async () => {
      let capturedBody: Record<string, unknown> = {};
      const client = new TelnyxPortingClient({
        apiKey: "k",
        fetchImpl: mockFetch((_u, init) => {
          capturedBody = JSON.parse(String(init.body));
          return jsonResponse({});
        })
      });
      expect(await client.createPortingOrder({ phoneNumbers: ["+13125550001"] })).toEqual([]);
      expect(capturedBody).not.toHaveProperty("customer_reference");
      await expect(client.createPortingOrder({ phoneNumbers: [] })).rejects.toThrow(
        /phoneNumbers is required/
      );
    });
  });

  describe("getPortingOrder", () => {
    it("GETs the encoded order id", async () => {
      let url = "";
      let capturedInit: RequestInit = {};
      const client = new TelnyxPortingClient({
        apiKey: "k",
        fetchImpl: mockFetch((u, init) => {
          url = u;
          capturedInit = init;
          return jsonResponse({ data: { id: "po/1", status: { value: "submitted" } } });
        })
      });
      const order = await client.getPortingOrder("po/1");
      expect(order.status?.value).toBe("submitted");
      expect(url).toContain("/porting_orders/po%2F1");
      expect(capturedInit.method).toBe("GET");
      // GET has no body → no Content-Type header.
      expect(capturedInit.body).toBeUndefined();
      expect((capturedInit.headers as Record<string, string>)["Content-Type"]).toBeUndefined();
    });

    it("validates input", async () => {
      const client = new TelnyxPortingClient({
        apiKey: "k",
        fetchImpl: mockFetch(() => jsonResponse({ data: {} }))
      });
      await expect(client.getPortingOrder(" ")).rejects.toThrow(/orderId is required/);
    });
  });

  describe("updatePortingOrder", () => {
    it("PATCHes only the provided sections with snake_case keys", async () => {
      let capturedBody: Record<string, unknown> = {};
      let capturedInit: RequestInit = {};
      const client = new TelnyxPortingClient({
        apiKey: "k",
        fetchImpl: mockFetch((_u, init) => {
          capturedInit = init;
          capturedBody = JSON.parse(String(init.body));
          return jsonResponse({ data: { id: "po-1" } });
        })
      });
      await client.updatePortingOrder("po-1", {
        documents: { loa: "doc-loa", invoice: "doc-inv" },
        endUser: {
          admin: { entity_name: "Acme", auth_person_name: "Jane Doe", account_number: "42" },
          location: {
            street_address: "311 W Superior St",
            locality: "Chicago",
            administrative_area: "IL",
            postal_code: "60654",
            country_code: "US"
          }
        },
        misc: { type: "full" },
        focDatetimeRequested: "2026-07-20T13:00:00Z",
        phoneNumberConfiguration: { connection_id: "conn-1", messaging_profile_id: "prof-1" },
        webhookUrl: "https://example.test/hook",
        userReference: "r".repeat(400)
      });
      expect(capturedInit.method).toBe("PATCH");
      expect(capturedBody).toMatchObject({
        documents: { loa: "doc-loa", invoice: "doc-inv" },
        end_user: { admin: { entity_name: "Acme" } },
        misc: { type: "full" },
        activation_settings: { foc_datetime_requested: "2026-07-20T13:00:00Z" },
        phone_number_configuration: { connection_id: "conn-1" },
        webhook_url: "https://example.test/hook"
      });
      expect((capturedBody.user_reference as string).length).toBe(250);
    });

    it("sends an empty body when the patch has nothing set, validates input", async () => {
      let capturedBody: Record<string, unknown> = { sentinel: true };
      const client = new TelnyxPortingClient({
        apiKey: "k",
        fetchImpl: mockFetch((_u, init) => {
          capturedBody = JSON.parse(String(init.body));
          return jsonResponse({ data: { id: "po-1" } });
        })
      });
      await client.updatePortingOrder("po-1", {});
      expect(capturedBody).toEqual({});
      await expect(client.updatePortingOrder("", {})).rejects.toThrow(/orderId is required/);
    });
  });

  describe("confirmPortingOrder / cancelPortingOrder", () => {
    it("POSTs to the actions endpoints", async () => {
      const urls: string[] = [];
      const client = new TelnyxPortingClient({
        apiKey: "k",
        fetchImpl: mockFetch((u, init) => {
          urls.push(`${init.method} ${u}`);
          return jsonResponse({ data: { id: "po-1", status: { value: "submitted" } } });
        })
      });
      const confirmed = await client.confirmPortingOrder("po-1");
      expect(confirmed.status?.value).toBe("submitted");
      const cancelled = await client.cancelPortingOrder("po-1");
      expect(cancelled.id).toBe("po-1");
      expect(urls[0]).toContain("POST ");
      expect(urls[0]).toContain("/porting_orders/po-1/actions/confirm");
      expect(urls[1]).toContain("/porting_orders/po-1/actions/cancel");
    });

    it("validates input", async () => {
      const client = new TelnyxPortingClient({
        apiKey: "k",
        fetchImpl: mockFetch(() => jsonResponse({ data: {} }))
      });
      await expect(client.confirmPortingOrder("")).rejects.toThrow(/orderId is required/);
      await expect(client.cancelPortingOrder("")).rejects.toThrow(/orderId is required/);
    });
  });

  describe("listAllowedFocWindows", () => {
    it("GETs the windows and returns [] when data missing", async () => {
      let url = "";
      const client = new TelnyxPortingClient({
        apiKey: "k",
        fetchImpl: mockFetch((u) => {
          url = u;
          return jsonResponse({
            data: [{ started_at: "2026-07-20T13:00:00Z", ended_at: "2026-07-20T20:00:00Z" }]
          });
        })
      });
      const windows = await client.listAllowedFocWindows("po-1");
      expect(windows).toHaveLength(1);
      expect(url).toContain("/porting_orders/po-1/allowed_foc_windows");

      const client2 = new TelnyxPortingClient({
        apiKey: "k",
        fetchImpl: mockFetch(() => jsonResponse({}))
      });
      expect(await client2.listAllowedFocWindows("po-1")).toEqual([]);
      await expect(client2.listAllowedFocWindows("")).rejects.toThrow(/orderId is required/);
    });
  });

  describe("uploadDocument", () => {
    it("POSTs base64 file + filename (+ trimmed customer_reference) to /documents", async () => {
      let url = "";
      let capturedBody: Record<string, unknown> = {};
      const client = new TelnyxPortingClient({
        apiKey: "k",
        fetchImpl: mockFetch((u, init) => {
          url = u;
          capturedBody = JSON.parse(String(init.body));
          return jsonResponse({ data: { id: "doc-1", filename: "loa.pdf" } });
        })
      });
      const doc = await client.uploadDocument({
        base64: "JVBERi0xLjQ=",
        filename: "loa.pdf",
        customerReference: "c".repeat(400)
      });
      expect(doc.id).toBe("doc-1");
      expect(url).toContain("/documents");
      expect(capturedBody.file).toBe("JVBERi0xLjQ=");
      expect(capturedBody.filename).toBe("loa.pdf");
      expect((capturedBody.customer_reference as string).length).toBe(250);
    });

    it("omits customer_reference when absent and validates input", async () => {
      let capturedBody: Record<string, unknown> = {};
      const client = new TelnyxPortingClient({
        apiKey: "k",
        fetchImpl: mockFetch((_u, init) => {
          capturedBody = JSON.parse(String(init.body));
          return jsonResponse({ data: { id: "doc-1" } });
        })
      });
      await client.uploadDocument({ base64: "AAAA", filename: "invoice.pdf" });
      expect(capturedBody).not.toHaveProperty("customer_reference");
      await expect(client.uploadDocument({ base64: "", filename: "x.pdf" })).rejects.toThrow(
        /base64 is required/
      );
      await expect(client.uploadDocument({ base64: "AAAA", filename: " " })).rejects.toThrow(
        /filename is required/
      );
    });
  });

  it("throws TelnyxApiError with endpoint/status/body on non-2xx (body read failure tolerated)", async () => {
    const client = new TelnyxPortingClient({
      apiKey: "k",
      fetchImpl: mockFetch(() => new Response("account not authorized", { status: 403 }))
    });
    const err: unknown = await client.checkPortability(["+13125550001"]).catch((e) => e);
    expect(err).toBeInstanceOf(TelnyxApiError);
    const apiErr = err as TelnyxApiError;
    expect(apiErr.status).toBe(403);
    expect(apiErr.endpoint).toBe("/portability_checks");
    expect(apiErr.message).toContain("account not authorized");

    // text() rejecting must not mask the API error.
    const brokenBody = {
      ok: false,
      status: 500,
      text: () => Promise.reject(new Error("stream died"))
    } as unknown as Response;
    const client2 = new TelnyxPortingClient({
      apiKey: "k",
      fetchImpl: mockFetch(() => brokenBody)
    });
    const err2: unknown = await client2.getPortingOrder("po-1").catch((e) => e);
    expect(err2).toBeInstanceOf(TelnyxApiError);
    const apiErr2 = err2 as TelnyxApiError;
    expect(apiErr2.status).toBe(500);
    expect(apiErr2.body).toBe("");
  });
});
