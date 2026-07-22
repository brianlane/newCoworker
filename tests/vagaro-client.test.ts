/**
 * Tests for the Vagaro API client (src/lib/vagaro/client.ts): token
 * exchange + caching, the 401 refresh-and-retry, and the typed helper
 * response normalization.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

import {
  clearVagaroTokenCache,
  createVagaroAppointment,
  deleteVagaroAppointment,
  getVagaroAccessToken,
  listVagaroAppointments,
  listVagaroServices,
  normalizeVagaroAppointment,
  searchVagaroAvailability,
  updateVagaroAppointmentTime,
  vagaroFetch,
  VagaroApiError
} from "@/lib/vagaro/client";

const CONN = {
  id: "vg-1",
  business_id: "biz-1",
  client_id: "cid",
  clientSecret: "shhh",
  api_base_url: "https://api.vagaro.com",
  webhook_verification_token: "tok",
  default_service_id: null,
  default_employee_id: null,
  is_active: true,
  created_at: "",
  updated_at: ""
} as never;

const fetchMock = vi.fn();

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body)
  } as never;
}

function tokenResponse(token = "at-1", expiresIn: number | undefined = 3600) {
  return jsonResponse(200, {
    access_token: token,
    ...(expiresIn === undefined ? {} : { expires_in: expiresIn })
  });
}

beforeEach(() => {
  // mockReset (not clearAllMocks) so queued mockResolvedValueOnce values
  // from a failed assertion can never leak into the next test.
  fetchMock.mockReset();
  clearVagaroTokenCache();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("getVagaroAccessToken", () => {
  it("exchanges client credentials and caches the token", async () => {
    fetchMock.mockResolvedValueOnce(tokenResponse());
    expect(await getVagaroAccessToken(CONN)).toBe("at-1");
    expect(await getVagaroAccessToken(CONN)).toBe("at-1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.vagaro.com/oauth/token");
    expect(String(init.body)).toContain("grant_type=client_credentials");
    expect(String(init.body)).toContain("client_id=cid");
    expect(String(init.body)).toContain("client_secret=shhh");
  });

  it("re-exchanges once the cached token is near expiry", async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(tokenResponse("at-1", 120));
    await getVagaroAccessToken(CONN);
    // 61s left < 60s slack? 120s ttl - 70s elapsed = 50s left → refresh.
    vi.advanceTimersByTime(70_000);
    fetchMock.mockResolvedValue(tokenResponse("at-2", 120));
    expect(await getVagaroAccessToken(CONN)).toBe("at-2");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("defaults the TTL when expires_in is missing or non-positive", async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValueOnce(tokenResponse("at-1", undefined));
    await getVagaroAccessToken(CONN);
    // Default 600s: still cached at +400s.
    vi.advanceTimersByTime(400_000);
    expect(await getVagaroAccessToken(CONN)).toBe("at-1");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    clearVagaroTokenCache();
    fetchMock.mockResolvedValueOnce(tokenResponse("at-2", 0));
    await getVagaroAccessToken(CONN);
    vi.advanceTimersByTime(400_000);
    expect(await getVagaroAccessToken(CONN)).toBe("at-2");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("aborts a hung exchange at the request timeout", async () => {
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
    const pending = getVagaroAccessToken(CONN);
    const assertion = expect(pending).rejects.toMatchObject({ code: "upstream_timeout" });
    await vi.advanceTimersByTimeAsync(16_000);
    await assertion;
  });

  it("throws auth_failed on a rejected exchange or missing token", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(401, { error: "invalid_client" }));
    await expect(getVagaroAccessToken(CONN)).rejects.toMatchObject({ code: "auth_failed" });

    fetchMock.mockResolvedValueOnce(jsonResponse(200, {}));
    await expect(getVagaroAccessToken(CONN)).rejects.toMatchObject({ code: "auth_failed" });
  });

  it("throws auth_failed when the token body is not JSON", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("bad json");
      }
    } as never);
    await expect(getVagaroAccessToken(CONN)).rejects.toMatchObject({ code: "auth_failed" });
  });

  it("maps aborts and network failures to typed errors", async () => {
    const abortErr = new Error("aborted");
    abortErr.name = "AbortError";
    fetchMock.mockRejectedValueOnce(abortErr);
    await expect(getVagaroAccessToken(CONN)).rejects.toMatchObject({ code: "upstream_timeout" });

    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    await expect(getVagaroAccessToken(CONN)).rejects.toMatchObject({
      code: "upstream_unreachable"
    });
  });
});

describe("vagaroFetch", () => {
  it("sends the bearer + query params and parses JSON", async () => {
    fetchMock
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(jsonResponse(200, { hello: 1 }));
    const out = await vagaroFetch(CONN, {
      method: "GET",
      path: "/api/v3/services",
      query: { a: "b" }
    });
    expect(out).toEqual({ hello: 1 });
    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe("https://api.vagaro.com/api/v3/services?a=b");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer at-1");
    expect(init.body).toBeUndefined();
  });

  it("serializes a JSON body with content-type", async () => {
    fetchMock
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(jsonResponse(200, {}));
    await vagaroFetch(CONN, { method: "POST", path: "/api/v3/appointments", body: { x: 1 } });
    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(init.body).toBe('{"x":1}');
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
  });

  it("refreshes the token and retries ONCE on 401", async () => {
    fetchMock
      .mockResolvedValueOnce(tokenResponse("stale"))
      .mockResolvedValueOnce(jsonResponse(401, {}))
      .mockResolvedValueOnce(tokenResponse("fresh"))
      .mockResolvedValueOnce(jsonResponse(200, { ok: 1 }));
    const out = await vagaroFetch(CONN, { method: "GET", path: "/api/v3/services" });
    expect(out).toEqual({ ok: 1 });
    const secondAuth = (fetchMock.mock.calls[3][1] as RequestInit).headers as Record<
      string,
      string
    >;
    expect(secondAuth.Authorization).toBe("Bearer fresh");
  });

  it("throws auth_failed when the retry also 401s", async () => {
    fetchMock
      .mockResolvedValueOnce(tokenResponse("t1"))
      .mockResolvedValueOnce(jsonResponse(401, {}))
      .mockResolvedValueOnce(tokenResponse("t2"))
      .mockResolvedValueOnce(jsonResponse(401, {}));
    await expect(
      vagaroFetch(CONN, { method: "GET", path: "/api/v3/services" })
    ).rejects.toMatchObject({ code: "auth_failed", status: 401 });
  });

  it("throws request_failed on other non-2xx statuses", async () => {
    fetchMock
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => ({}),
        text: async () => "server exploded"
      } as never);
    await expect(
      vagaroFetch(CONN, { method: "GET", path: "/api/v3/services" })
    ).rejects.toMatchObject({ code: "request_failed", status: 500 });
  });

  it("tolerates a failed error-body read and a non-JSON success body", async () => {
    fetchMock.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce({
      ok: false,
      status: 502,
      json: async () => ({}),
      text: async () => {
        throw new Error("stream died");
      }
    } as never);
    await expect(
      vagaroFetch(CONN, { method: "GET", path: "/p" })
    ).rejects.toMatchObject({ code: "request_failed" });

    // Token is cached from the first call — queue only the API response.
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 204,
      json: async () => {
        throw new Error("empty");
      },
      text: async () => ""
    } as never);
    expect(await vagaroFetch(CONN, { method: "GET", path: "/p" })).toBeNull();
  });
});

describe("searchVagaroAvailability", () => {
  function primeToken() {
    fetchMock.mockResolvedValueOnce(tokenResponse());
  }

  it("maps items across envelope shapes and drops unparseable starts", async () => {
    primeToken();
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        data: [
          { startTime: "2026-06-12T15:00:00Z", endTime: "2026-06-12T15:30:00Z" },
          { start: "2026-06-12T16:00:00Z" },
          { startDate: "2026-06-12T17:00:00Z", endDate: "junk" },
          { startTime: "not a date" },
          { noStart: true }
        ]
      })
    );
    const slots = await searchVagaroAvailability(CONN, {
      serviceId: "svc-1",
      startIso: "2026-06-12T09:00:00Z",
      endIso: "2026-06-13T09:00:00Z"
    });
    expect(slots).toEqual([
      { startIso: "2026-06-12T15:00:00.000Z", endIso: "2026-06-12T15:30:00.000Z" },
      { startIso: "2026-06-12T16:00:00.000Z", endIso: null },
      { startIso: "2026-06-12T17:00:00.000Z", endIso: null }
    ]);
    const url = String(fetchMock.mock.calls[1][0]);
    expect(url).toContain("serviceId=svc-1");
    expect(url).not.toContain("employeeId");
  });

  it("passes an explicit employee filter and accepts bare-array and items envelopes", async () => {
    primeToken();
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, [{ startTime: "2026-06-12T15:00:00Z" }])
    );
    const bare = await searchVagaroAvailability(CONN, {
      serviceId: "svc-1",
      employeeId: "emp-9",
      startIso: "a",
      endIso: "b"
    });
    expect(bare).toHaveLength(1);
    expect(String(fetchMock.mock.calls[1][0])).toContain("employeeId=emp-9");

    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { items: [{ startTime: "2026-06-12T18:00:00Z" }] })
    );
    const items = await searchVagaroAvailability(CONN, {
      serviceId: "svc-1",
      startIso: "a",
      endIso: "b"
    });
    expect(items).toHaveLength(1);

    fetchMock.mockResolvedValueOnce(jsonResponse(200, { unexpected: true }));
    expect(
      await searchVagaroAvailability(CONN, { serviceId: "svc-1", startIso: "a", endIso: "b" })
    ).toEqual([]);
  });
});

describe("createVagaroAppointment", () => {
  it("posts the appointment and resolves the id across shapes", async () => {
    fetchMock
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(jsonResponse(200, { id: "appt-1" }));
    const created = await createVagaroAppointment(CONN, {
      serviceId: "svc-1",
      employeeId: "emp-2",
      startIso: "2026-06-12T15:00:00Z",
      endIso: "2026-06-12T15:30:00Z",
      customerName: "Joe",
      customerPhone: "+15551230000",
      customerEmail: "joe@example.com",
      notes: "gate code 1234"
    });
    expect(created).toEqual({ appointmentId: "appt-1" });
    const body = JSON.parse(String((fetchMock.mock.calls[1][1] as RequestInit).body));
    expect(body).toEqual({
      serviceId: "svc-1",
      employeeId: "emp-2",
      startTime: "2026-06-12T15:00:00Z",
      endTime: "2026-06-12T15:30:00Z",
      customer: { name: "Joe", phone: "+15551230000", email: "joe@example.com" },
      notes: "gate code 1234"
    });

    fetchMock.mockResolvedValueOnce(jsonResponse(200, { appointmentId: "appt-2" }));
    expect(
      (
        await createVagaroAppointment(CONN, {
          serviceId: "s",
          startIso: "a",
          endIso: "b",
          customerName: "Jo"
        })
      ).appointmentId
    ).toBe("appt-2");

    fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: { id: "appt-3" } }));
    expect(
      (
        await createVagaroAppointment(CONN, {
          serviceId: "s",
          startIso: "a",
          endIso: "b",
          customerName: "Jo"
        })
      ).appointmentId
    ).toBe("appt-3");

    fetchMock.mockResolvedValueOnce(jsonResponse(200, {}));
    expect(
      (
        await createVagaroAppointment(CONN, {
          serviceId: "s",
          startIso: "a",
          endIso: "b",
          customerName: "Jo"
        })
      ).appointmentId
    ).toBeNull();
  });

  it("omits optional customer fields when absent", async () => {
    fetchMock
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(jsonResponse(200, { id: "appt-1" }));
    await createVagaroAppointment(CONN, {
      serviceId: "svc-1",
      startIso: "a",
      endIso: "b",
      customerName: "Jo"
    });
    const body = JSON.parse(String((fetchMock.mock.calls[1][1] as RequestInit).body));
    expect(body.customer).toEqual({ name: "Jo" });
    expect(body).not.toHaveProperty("employeeId");
    expect(body).not.toHaveProperty("notes");
  });
});

describe("appointment lifecycle helpers", () => {
  it("PUTs the new times to the appointment resource (id URL-escaped)", async () => {
    fetchMock
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(jsonResponse(200, {}));
    await updateVagaroAppointmentTime(
      CONN,
      "appt/1",
      "2026-06-13T15:00:00.000Z",
      "2026-06-13T15:30:00.000Z"
    );
    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe("https://api.vagaro.com/api/v3/appointments/appt%2F1");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(String(init.body))).toEqual({
      startTime: "2026-06-13T15:00:00.000Z",
      endTime: "2026-06-13T15:30:00.000Z"
    });
  });

  it("DELETEs the appointment resource and tolerates an empty body", async () => {
    fetchMock.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce({
      ok: true,
      status: 204,
      json: async () => {
        throw new Error("empty");
      },
      text: async () => ""
    } as never);
    await deleteVagaroAppointment(CONN, "appt-1");
    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe("https://api.vagaro.com/api/v3/appointments/appt-1");
    expect(init.method).toBe("DELETE");
    expect(init.body).toBeUndefined();
  });
});

describe("listVagaroServices", () => {
  it("normalizes service rows and drops id-less entries", async () => {
    fetchMock.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(
      jsonResponse(200, {
        data: [
          { id: "svc-1", name: "Haircut", duration: 30 },
          { serviceId: "svc-2", serviceName: "Color", duration: 0 },
          { id: "svc-3" },
          { name: "no id" }
        ]
      })
    );
    expect(await listVagaroServices(CONN)).toEqual([
      { id: "svc-1", name: "Haircut", durationMinutes: 30 },
      { id: "svc-2", name: "Color", durationMinutes: null },
      { id: "svc-3", name: "Service", durationMinutes: null }
    ]);
  });
});

describe("normalizeVagaroAppointment", () => {
  it("normalizes across field aliases with a nested customer object", () => {
    expect(
      normalizeVagaroAppointment({
        id: "appt-1",
        startTime: "2026-06-12T15:00:00Z",
        endTime: "2026-06-12T15:30:00Z",
        createdAt: "2026-06-10T09:00:00Z",
        updatedAt: "2026-06-11T09:00:00Z",
        status: "Confirmed",
        serviceId: "svc-1",
        serviceName: "Gel Manicure",
        customer: {
          name: "Dana Doe",
          phone: "+16025550000",
          email: "Dana@Example.com"
        }
      })
    ).toEqual({
      id: "appt-1",
      startIso: "2026-06-12T15:00:00.000Z",
      endIso: "2026-06-12T15:30:00.000Z",
      createdIso: "2026-06-10T09:00:00.000Z",
      updatedIso: "2026-06-11T09:00:00.000Z",
      status: "confirmed",
      cancelled: false,
      serviceId: "svc-1",
      serviceName: "Gel Manicure",
      customerName: "Dana Doe",
      customerPhone: "+16025550000",
      customerEmail: "dana@example.com"
    });
  });

  it("reads flat customer fields, alias timestamps, and service objects", () => {
    expect(
      normalizeVagaroAppointment({
        appointmentId: "appt-2",
        start: "2026-06-12T16:00:00Z",
        end: "junk",
        created: "2026-06-10T10:00:00Z",
        modifiedAt: "2026-06-11T10:00:00Z",
        appointmentStatus: "cancelled",
        service: { id: "svc-2", name: "Color" },
        firstName: "Joe",
        lastName: "Ray",
        mobilePhone: "6025551212"
      })
    ).toEqual({
      id: "appt-2",
      startIso: "2026-06-12T16:00:00.000Z",
      endIso: null,
      createdIso: "2026-06-10T10:00:00.000Z",
      updatedIso: "2026-06-11T10:00:00.000Z",
      status: "cancelled",
      cancelled: true,
      serviceId: "svc-2",
      serviceName: "Color",
      customerName: "Joe Ray",
      customerPhone: "6025551212",
      customerEmail: null
    });
  });

  it("tolerates remaining alias shapes and minimal rows", () => {
    expect(
      normalizeVagaroAppointment({
        id: "appt-3",
        startDate: "2026-06-12T17:00:00Z",
        endDate: "2026-06-12T17:45:00Z",
        createdDate: "2026-06-10T11:00:00Z",
        lastModified: "2026-06-11T11:00:00Z",
        status: "deleted",
        fullName: "Solo Name",
        phoneNumber: "555",
        customerEmail: "x@y.co"
      })
    ).toMatchObject({
      id: "appt-3",
      endIso: "2026-06-12T17:45:00.000Z",
      createdIso: "2026-06-10T11:00:00.000Z",
      updatedIso: "2026-06-11T11:00:00.000Z",
      cancelled: true,
      customerName: "Solo Name",
      customerPhone: "555",
      customerEmail: "x@y.co"
    });
    expect(
      normalizeVagaroAppointment({
        id: "appt-4",
        startTime: "2026-06-12T18:00:00Z",
        createdDateTime: "2026-06-10T12:00:00Z",
        lastModifiedDateTime: "2026-06-11T12:00:00Z",
        customerName: "Named Field",
        customerPhone: "+15550001111",
        cellPhone: "ignored-when-customerPhone-set"
      })
    ).toMatchObject({
      id: "appt-4",
      createdIso: "2026-06-10T12:00:00.000Z",
      updatedIso: "2026-06-11T12:00:00.000Z",
      status: "",
      cancelled: false,
      serviceId: null,
      serviceName: null,
      customerName: "Named Field",
      customerPhone: "+15550001111",
      customerEmail: null
    });
    // cellPhone is the last phone alias tried.
    expect(
      normalizeVagaroAppointment({
        id: "appt-5",
        startTime: "2026-06-12T18:00:00Z",
        cellPhone: "6021112222",
        firstName: "OnlyFirst"
      })
    ).toMatchObject({ customerPhone: "6021112222", customerName: "OnlyFirst" });
  });

  it("returns null without an id or a parseable start", () => {
    expect(normalizeVagaroAppointment({ startTime: "2026-06-12T15:00:00Z" })).toBeNull();
    expect(normalizeVagaroAppointment({ id: "appt-1" })).toBeNull();
    expect(normalizeVagaroAppointment({ id: "appt-1", startTime: "junk" })).toBeNull();
  });
});

describe("listVagaroAppointments", () => {
  it("lists with the date window, drops unusable rows, and omits status by default", async () => {
    fetchMock.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(
      jsonResponse(200, {
        data: [
          { id: "appt-1", startTime: "2026-06-12T15:00:00Z" },
          { noId: true },
          { id: "appt-bad", startTime: "junk" }
        ]
      })
    );
    const items = await listVagaroAppointments(CONN, {
      startIso: "2026-06-12T00:00:00.000Z",
      endIso: "2026-06-13T00:00:00.000Z"
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: "appt-1", startIso: "2026-06-12T15:00:00.000Z" });
    const url = String(fetchMock.mock.calls[1][0]);
    expect(url).toContain("/api/v3/appointments");
    expect(url).toContain("startDate=2026-06-12T00%3A00%3A00.000Z");
    expect(url).toContain("endDate=2026-06-13T00%3A00%3A00.000Z");
    expect(url).not.toContain("status=");
  });

  it("passes the status filter through when given", async () => {
    fetchMock
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(jsonResponse(200, []));
    await listVagaroAppointments(CONN, {
      startIso: "a",
      endIso: "b",
      status: "cancelled"
    });
    expect(String(fetchMock.mock.calls[1][0])).toContain("status=cancelled");
  });
});

describe("VagaroApiError", () => {
  it("carries the code and status", () => {
    const err = new VagaroApiError("request_failed", "nope", 503);
    expect(err.name).toBe("VagaroApiError");
    expect(err.code).toBe("request_failed");
    expect(err.status).toBe(503);
  });
});
