import { describe, it, expect, vi } from "vitest";
import {
  TelnyxNumbersClient,
  TelnyxApiError,
  DEFAULT_TELNYX_API_BASE_URL
} from "@/lib/telnyx/numbers";

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

describe("TelnyxNumbersClient", () => {
  it("throws if apiKey is missing", () => {
    expect(() => new TelnyxNumbersClient({ apiKey: "" })).toThrow(/apiKey is required/);
    expect(() => new TelnyxNumbersClient({ apiKey: "   " })).toThrow(/apiKey is required/);
  });

  it("uses default base URL when not provided", () => {
    const c = new TelnyxNumbersClient({ apiKey: "k" });
    expect(DEFAULT_TELNYX_API_BASE_URL).toBe("https://api.telnyx.com/v2");
    expect(c).toBeInstanceOf(TelnyxNumbersClient);
  });

  it("searchAvailable builds filter[] query string and parses data", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit = {};
    const fetchImpl = mockFetch((url, init) => {
      capturedUrl = url;
      capturedInit = init;
      return jsonResponse({
        data: [{ phone_number: "+15551234567" }, { phone_number: "+15557654321" }]
      });
    });
    const client = new TelnyxNumbersClient({
      apiKey: "KEY",
      fetchImpl,
      userAgent: "test-agent"
    });
    const nums = await client.searchAvailable({
      countryCode: "us",
      areaCode: "212",
      locality: "New York",
      administrativeArea: "ny",
      features: ["sms", "voice"],
      limit: 3,
      quickshipOnly: true
    });
    expect(nums).toHaveLength(2);
    expect(capturedUrl).toContain("filter%5Bcountry_code%5D=US");
    expect(capturedUrl).toContain("filter%5Bnational_destination_code%5D=212");
    expect(capturedUrl).toContain("filter%5Blocality%5D=New+York");
    expect(capturedUrl).toContain("filter%5Badministrative_area%5D=NY");
    expect(capturedUrl).toContain("filter%5Bfeatures%5D%5B%5D=sms");
    expect(capturedUrl).toContain("filter%5Bfeatures%5D%5B%5D=voice");
    expect(capturedUrl).toContain("filter%5Blimit%5D=3");
    expect(capturedUrl).toContain("filter%5Bquickship%5D=true");
    expect((capturedInit.headers as Record<string, string>)["Authorization"]).toBe("Bearer KEY");
    expect((capturedInit.headers as Record<string, string>)["User-Agent"]).toBe("test-agent");
  });

  it("searchAvailable defaults country + features, clamps limit to 25 max / 1 min, returns [] when no data", async () => {
    let url1 = "";
    const fetchImpl = mockFetch((url) => {
      url1 = url;
      return jsonResponse({});
    });
    const client = new TelnyxNumbersClient({ apiKey: "k", fetchImpl });
    const nums = await client.searchAvailable({ limit: 100 });
    expect(nums).toEqual([]);
    expect(url1).toContain("filter%5Bcountry_code%5D=US");
    expect(url1).toContain("filter%5Bfeatures%5D%5B%5D=sms");
    expect(url1).toContain("filter%5Blimit%5D=25");

    let url2 = "";
    const fetchImpl2 = mockFetch((url) => {
      url2 = url;
      return jsonResponse({ data: [] });
    });
    const client2 = new TelnyxNumbersClient({ apiKey: "k", fetchImpl: fetchImpl2 });
    await client2.searchAvailable({ limit: 0 });
    expect(url2).toContain("filter%5Blimit%5D=1");

    let url3 = "";
    const fetchImpl3 = mockFetch((url) => {
      url3 = url;
      return jsonResponse({ data: [] });
    });
    const client3 = new TelnyxNumbersClient({ apiKey: "k", fetchImpl: fetchImpl3 });
    await client3.searchAvailable();
    expect(url3).toContain("filter%5Blimit%5D=10");
  });

  it("orderNumbers posts phone_numbers array and optional associations", async () => {
    let capturedBody: unknown = null;
    const fetchImpl = mockFetch((url, init) => {
      capturedBody = JSON.parse(String(init.body ?? "null"));
      expect(url).toContain("/number_orders");
      return jsonResponse({ data: { id: "ord_123", status: "pending" } });
    });
    const client = new TelnyxNumbersClient({ apiKey: "k", fetchImpl });
    const order = await client.orderNumbers({
      phoneNumbers: ["+15551234567"],
      connectionId: "conn_1",
      messagingProfileId: "prof_1",
      customerReference: "x".repeat(400)
    });
    expect(order.id).toBe("ord_123");
    expect(capturedBody).toMatchObject({
      phone_numbers: [{ phone_number: "+15551234567" }],
      connection_id: "conn_1",
      messaging_profile_id: "prof_1"
    });
    const body = capturedBody as { customer_reference: string };
    expect(body.customer_reference.length).toBe(250);
  });

  it("orderNumbers throws when phoneNumbers is empty", async () => {
    const client = new TelnyxNumbersClient({
      apiKey: "k",
      fetchImpl: mockFetch(() => jsonResponse({}))
    });
    await expect(client.orderNumbers({ phoneNumbers: [] })).rejects.toThrow(/phoneNumbers is required/);
  });

  it("orderNumbers omits association fields when not provided", async () => {
    let captured: Record<string, unknown> = {};
    const fetchImpl = mockFetch((_url, init) => {
      captured = JSON.parse(String(init.body));
      return jsonResponse({ data: { id: "o", status: "success" } });
    });
    const client = new TelnyxNumbersClient({ apiKey: "k", fetchImpl });
    await client.orderNumbers({ phoneNumbers: ["+15550001111"] });
    expect(captured).not.toHaveProperty("connection_id");
    expect(captured).not.toHaveProperty("messaging_profile_id");
    expect(captured).not.toHaveProperty("customer_reference");
  });

  it("getNumberOrder GETs and throws on empty id", async () => {
    let u = "";
    const fetchImpl = mockFetch((url) => {
      u = url;
      return jsonResponse({ data: { id: "ord", status: "success" } });
    });
    const client = new TelnyxNumbersClient({ apiKey: "k", fetchImpl });
    const o = await client.getNumberOrder("ord/slashed");
    expect(o.status).toBe("success");
    expect(u).toContain("ord%2Fslashed");
    await expect(client.getNumberOrder("")).rejects.toThrow(/orderId is required/);
    await expect(client.getNumberOrder("   ")).rejects.toThrow(/orderId is required/);
  });

  it("updatePhoneNumber PATCHes with all optional fields, validates id", async () => {
    let method = "";
    let body: Record<string, unknown> = {};
    let url = "";
    const fetchImpl = mockFetch((u, init) => {
      method = init.method ?? "";
      body = JSON.parse(String(init.body ?? "{}"));
      url = u;
      return jsonResponse({ data: { id: "pn_1", phone_number: "+15550001111" } });
    });
    const client = new TelnyxNumbersClient({ apiKey: "k", fetchImpl });
    const out = await client.updatePhoneNumber({
      phoneNumberIdOrE164: "+15550001111",
      connectionId: "conn_1",
      messagingProfileId: "prof_1",
      tags: ["biz:abc"],
      customerReference: "ref"
    });
    expect(method).toBe("PATCH");
    expect(url).toContain("%2B15550001111");
    expect(body).toMatchObject({
      connection_id: "conn_1",
      messaging_profile_id: "prof_1",
      tags: ["biz:abc"],
      customer_reference: "ref"
    });
    expect(out.id).toBe("pn_1");
    await expect(client.updatePhoneNumber({ phoneNumberIdOrE164: "" })).rejects.toThrow(
      /phoneNumberIdOrE164 is required/
    );
  });

  it("updatePhoneNumber sends empty body when no fields provided, and clears with null", async () => {
    let body: Record<string, unknown> = {};
    const fetchImpl = mockFetch((_u, init) => {
      body = JSON.parse(String(init.body ?? "{}"));
      return jsonResponse({ data: { id: "pn", phone_number: "+1" } });
    });
    const client = new TelnyxNumbersClient({ apiKey: "k", fetchImpl });
    await client.updatePhoneNumber({ phoneNumberIdOrE164: "+1", connectionId: null, messagingProfileId: null });
    expect(body).toEqual({ connection_id: null, messaging_profile_id: null });
  });

  it("updatePhoneNumber omits connection/messaging fields when they are undefined", async () => {
    let body: Record<string, unknown> = {};
    const fetchImpl = mockFetch((_u, init) => {
      body = JSON.parse(String(init.body ?? "{}"));
      return jsonResponse({ data: { id: "pn", phone_number: "+1" } });
    });
    const client = new TelnyxNumbersClient({ apiKey: "k", fetchImpl });
    await client.updatePhoneNumber({
      phoneNumberIdOrE164: "+1",
      tags: ["biz:abc"]
    });
    expect(body).toEqual({ tags: ["biz:abc"] });
    expect(body).not.toHaveProperty("connection_id");
    expect(body).not.toHaveProperty("messaging_profile_id");
    expect(body).not.toHaveProperty("customer_reference");
  });

  it("waitForNumberOrder polls until success or timeout", async () => {
    let calls = 0;
    const fetchImpl = mockFetch(() => {
      calls += 1;
      const status = calls < 3 ? "pending" : "success";
      return jsonResponse({ data: { id: "ord", status } });
    });
    const client = new TelnyxNumbersClient({ apiKey: "k", fetchImpl });
    const sleep = vi.fn().mockResolvedValue(undefined);
    const final = await client.waitForNumberOrder("ord", {
      timeoutMs: 10_000,
      pollIntervalMs: 100,
      sleep
    });
    expect(final.status).toBe("success");
    expect(calls).toBe(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("waitForNumberOrder exits on timeout while still pending", async () => {
    const fetchImpl = mockFetch(() => jsonResponse({ data: { id: "ord", status: "pending" } }));
    const client = new TelnyxNumbersClient({ apiKey: "k", fetchImpl });
    let t = 0;
    const now = () => {
      t += 5_000;
      return t;
    };
    const sleep = vi.fn().mockResolvedValue(undefined);
    const final = await client.waitForNumberOrder("ord", {
      timeoutMs: 1_000,
      pollIntervalMs: 250,
      now,
      sleep
    });
    expect(final.status).toBe("pending");
  });

  it("waitForNumberOrder enforces min poll interval of 250ms", async () => {
    const fetchImpl = mockFetch(() => jsonResponse({ data: { id: "ord", status: "success" } }));
    const client = new TelnyxNumbersClient({ apiKey: "k", fetchImpl });
    await client.waitForNumberOrder("ord", { pollIntervalMs: 10 });
  });

  it("waitForNumberOrder uses real setTimeout when sleep omitted", async () => {
    let calls = 0;
    const fetchImpl = mockFetch(() => {
      calls += 1;
      return jsonResponse({ data: { id: "ord", status: calls < 2 ? "pending" : "success" } });
    });
    const client = new TelnyxNumbersClient({ apiKey: "k", fetchImpl });
    const final = await client.waitForNumberOrder("ord", { pollIntervalMs: 1, timeoutMs: 5_000 });
    expect(final.status).toBe("success");
  });

  it("waitForNumberOrder uses default pollIntervalMs + timeout when options omitted", async () => {
    const fetchImpl = mockFetch(() => jsonResponse({ data: { id: "ord", status: "success" } }));
    const client = new TelnyxNumbersClient({ apiKey: "k", fetchImpl });
    const final = await client.waitForNumberOrder("ord");
    expect(final.status).toBe("success");
  });

  it("request surfaces non-200 responses as TelnyxApiError", async () => {
    const fetchImpl = mockFetch(() => new Response("boom", { status: 401 }));
    const client = new TelnyxNumbersClient({ apiKey: "k", fetchImpl });
    await expect(client.searchAvailable()).rejects.toBeInstanceOf(TelnyxApiError);
    try {
      await client.searchAvailable();
    } catch (err) {
      const e = err as TelnyxApiError;
      expect(e.status).toBe(401);
      expect(e.body).toBe("boom");
      expect(e.endpoint).toContain("/available_phone_numbers");
    }
  });

  it("request tolerates unreadable error body", async () => {
    const broken = {
      ok: false,
      status: 500,
      text: () => Promise.reject(new Error("no body"))
    } as unknown as Response;
    const brokenFetch = vi.fn(async () => broken) as unknown as typeof fetch;
    const client = new TelnyxNumbersClient({ apiKey: "k", fetchImpl: brokenFetch });
    await expect(client.searchAvailable()).rejects.toBeInstanceOf(TelnyxApiError);
  });

  it("strips trailing slash from baseUrl", () => {
    const client = new TelnyxNumbersClient({
      apiKey: "k",
      baseUrl: "https://x.example.com/v2/"
    });
    expect(client).toBeInstanceOf(TelnyxNumbersClient);
  });

  it("uses global fetch when fetchImpl omitted", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ data: [] })
    );
    const client = new TelnyxNumbersClient({ apiKey: "k" });
    await client.searchAvailable();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
