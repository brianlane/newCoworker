/**
 * Tests for the Acuity API client (src/lib/acuity/client.ts).
 *
 * Three areas carry real risk and get the bulk of the coverage:
 *   - the time helpers, because Acuity parses datetimes with PHP strtotime()
 *     in the account timezone unless we pin an offset, and its availability
 *     responses use non-ISO compact offsets;
 *   - error mapping, because "that slot is taken" and "your key is wrong"
 *     have to reach the model as different things;
 *   - the rate limiter, because Acuity's ceiling is per egress IP and shared
 *     across the whole fleet.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

type SystemLogInput = { businessId?: string | null; payload?: Record<string, unknown> };
const recordSystemLogMock = vi.fn(async (_input: SystemLogInput) => {});
vi.mock("@/lib/db/system-logs", () => ({
  recordSystemLog: (input: SystemLogInput) => recordSystemLogMock(input)
}));

type RateLimitResult = { success: boolean; limit: number; remaining: number; reset: number };
const rateLimitDurableMock = vi.fn(
  async (_key: string, _config: { interval: number; maxRequests: number }) =>
    ({ success: true, limit: 6, remaining: 5, reset: Date.now() + 1000 }) as RateLimitResult
);
vi.mock("@/lib/rate-limit", () => ({
  rateLimitDurable: (key: string, config: { interval: number; maxRequests: number }) =>
    rateLimitDurableMock(key, config)
}));

import {
  ACUITY_FLEET_WAIT_ATTEMPTS,
  ACUITY_MIN_REQUEST_INTERVAL_MS,
  ACUITY_REQUEST_TIMEOUT_MS,
  AcuityApiError,
  acuityDateTime,
  acuityFetch,
  acuityLocalDate,
  cancelAcuityAppointmentById,
  clearAcuityCaches,
  createAcuityAppointment,
  createAcuityWebhook,
  deleteAcuityWebhook,
  getAcuityAppointment,
  listAcuityAppointments,
  listAcuityAppointmentTypes,
  listAcuityAvailableDates,
  listAcuityAvailableTimes,
  listAcuityCalendars,
  listAcuityWebhooks,
  normalizeAcuityAppointment,
  normalizeAcuityTime,
  offsetFromLongOffset,
  rescheduleAcuityAppointmentTime,
  verifyAcuityCredentials,
  verifyAcuityWebhookSignature
} from "@/lib/acuity/client";

const CONN = {
  id: "ac-1",
  business_id: "biz-1",
  user_id: "12345",
  apiKey: "key-abc",
  api_base_url: "https://acuityscheduling.com",
  webhook_verification_token: "tok",
  default_appointment_type_id: null,
  default_calendar_id: null,
  default_calendar_timezone: null,
  suppress_provider_emails: true,
  webhook_registration: {},
  is_active: true,
  created_at: "",
  updated_at: ""
} as never;

const fetchMock = vi.fn();

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    json: async () => body,
    text: async () => JSON.stringify(body)
  } as never;
}

function lastUrl(): URL {
  return new URL(fetchMock.mock.calls.at(-1)?.[0] as string);
}

beforeEach(() => {
  fetchMock.mockReset();
  recordSystemLogMock.mockClear();
  rateLimitDurableMock.mockClear();
  rateLimitDurableMock.mockResolvedValue({
    success: true,
    limit: 6,
    remaining: 5,
    reset: Date.now() + 1000
  });
  clearAcuityCaches();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("time helpers", () => {
  it("renders an instant with an explicit offset so strtotime cannot guess", () => {
    // 2026-08-04T17:00:00Z is 13:00 in New York (EDT, -04:00).
    expect(acuityDateTime("2026-08-04T17:00:00Z", "America/New_York")).toBe(
      "2026-08-04T13:00:00-04:00"
    );
  });

  it("handles DST spring-forward and fall-back in the same zone", () => {
    // US DST 2026: forward Mar 8, back Nov 1.
    expect(acuityDateTime("2026-03-08T18:00:00Z", "America/New_York")).toBe(
      "2026-03-08T14:00:00-04:00"
    );
    expect(acuityDateTime("2026-11-01T18:00:00Z", "America/New_York")).toBe(
      "2026-11-01T13:00:00-05:00"
    );
  });

  it("handles non-hour offsets", () => {
    expect(acuityDateTime("2026-08-04T06:00:00Z", "Asia/Kolkata")).toBe(
      "2026-08-04T11:30:00+05:30"
    );
    expect(acuityDateTime("2026-08-04T00:00:00Z", "Australia/Eucla")).toBe(
      "2026-08-04T08:45:00+08:45"
    );
  });

  it("renders UTC as +00:00 rather than a bare GMT", () => {
    expect(acuityDateTime("2026-08-04T09:30:00Z", "UTC")).toBe("2026-08-04T09:30:00+00:00");
  });

  it("resolves the local date in the requested zone, not the server zone", () => {
    // 03:00Z on the 5th is still the 4th in New York.
    expect(acuityLocalDate("2026-08-05T03:00:00Z", "America/New_York")).toBe("2026-08-04");
    expect(acuityLocalDate("2026-08-05T03:00:00Z", "UTC")).toBe("2026-08-05");
    // And the reverse: 22:00Z on the 4th is already the 5th in Tokyo.
    expect(acuityLocalDate("2026-08-04T22:00:00Z", "Asia/Tokyo")).toBe("2026-08-05");
  });

  it("renders midnight as 00, never 24", () => {
    // 04:00Z is exactly midnight in New York during EDT. An h24 locale would
    // render this as T24:00:00 on the PREVIOUS day, which Acuity would book
    // a day early.
    expect(acuityDateTime("2026-08-04T04:00:00Z", "America/New_York")).toBe(
      "2026-08-04T00:00:00-04:00"
    );
  });

  it("accepts a Date as well as an ISO string", () => {
    const d = new Date("2026-08-04T17:00:00Z");
    expect(acuityDateTime(d, "America/New_York")).toBe("2026-08-04T13:00:00-04:00");
    expect(acuityLocalDate(d, "America/New_York")).toBe("2026-08-04");
  });

  it("maps ICU long offsets, including the bare GMT that means UTC", () => {
    expect(offsetFromLongOffset("GMT-04:00")).toBe("-04:00");
    expect(offsetFromLongOffset("GMT+5:30")).toBe("+05:30");
    expect(offsetFromLongOffset("GMT+08")).toBe("+08:00");
    expect(offsetFromLongOffset("GMT")).toBe("+00:00");
  });

  it("rejects unparseable instants instead of emitting Invalid Date", () => {
    expect(() => acuityDateTime("not-a-date", "UTC")).toThrow(AcuityApiError);
    expect(() => acuityLocalDate("not-a-date", "UTC")).toThrow(AcuityApiError);
    expect(() => acuityDateTime(new Date("nope"), "UTC")).toThrow(AcuityApiError);
    expect(() => acuityLocalDate(new Date("nope"), "UTC")).toThrow(AcuityApiError);
  });

  it("normalizes Acuity's compact offsets and rejects junk", () => {
    expect(normalizeAcuityTime("2016-02-04T13:00:00-0800")).toBe("2016-02-04T21:00:00.000Z");
    expect(normalizeAcuityTime("2026-08-04T13:00:00+05:30")).toBe("2026-08-04T07:30:00.000Z");
    expect(() => normalizeAcuityTime("nope")).toThrow(AcuityApiError);
  });
});

describe("transport", () => {
  it("sends Basic auth built from the user id and api key", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, {}));
    await acuityFetch(CONN, { method: "GET", path: "/me" });
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const expected = `Basic ${Buffer.from("12345:key-abc", "utf8").toString("base64")}`;
    expect((init.headers as Record<string, string>).Authorization).toBe(expected);
    expect(lastUrl().toString()).toBe("https://acuityscheduling.com/api/v1/me");
  });

  it("maps 401 to auth_failed with NO retry (there is no token to refresh)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(401, { error: "unauthorized" }));
    await expect(acuityFetch(CONN, { method: "GET", path: "/me" })).rejects.toMatchObject({
      code: "auth_failed"
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("maps 403 to auth_failed too", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(403, {}));
    await expect(acuityFetch(CONN, { method: "GET", path: "/me" })).rejects.toMatchObject({
      code: "auth_failed"
    });
  });

  it("maps 404 to not_found", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(404, {}));
    await expect(
      acuityFetch(CONN, { method: "GET", path: "/appointments/9" })
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("maps availability error codes to slot_unavailable, keeping the machine code", async () => {
    for (const code of [
      "not_available",
      "not_available_min_hours_in_advance",
      "not_available_max_days_in_advance",
      "reschedule_too_close",
      "reschedule_not_allowed"
    ]) {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(400, { status_code: 400, message: "nope", error: code })
      );
      await expect(
        acuityFetch(CONN, { method: "POST", path: "/appointments" })
      ).rejects.toMatchObject({ code: "slot_unavailable", acuityError: code });
    }
  });

  it("maps other 400s to request_failed and preserves the machine code", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(400, { status_code: 400, message: "bad", error: "invalid_email" })
    );
    await expect(
      acuityFetch(CONN, { method: "POST", path: "/appointments" })
    ).rejects.toMatchObject({ code: "request_failed", acuityError: "invalid_email" });
  });

  it("tolerates a non-JSON error body", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      headers: { get: () => null },
      text: async () => "<html>oops</html>"
    } as never);
    await expect(acuityFetch(CONN, { method: "GET", path: "/me" })).rejects.toMatchObject({
      code: "request_failed"
    });
  });

  it("maps an abort to upstream_timeout and a network error to upstream_unreachable", async () => {
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    fetchMock.mockRejectedValueOnce(abort);
    await expect(acuityFetch(CONN, { method: "GET", path: "/me" })).rejects.toMatchObject({
      code: "upstream_timeout"
    });
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    await expect(acuityFetch(CONN, { method: "GET", path: "/me" })).rejects.toMatchObject({
      code: "upstream_unreachable"
    });
  });

  it("aborts a hung request once the timeout budget expires", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          (init.signal as AbortSignal).addEventListener("abort", () => {
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          });
        })
    );
    const pending = acuityFetch(CONN, { method: "GET", path: "/me" });
    const assertion = expect(pending).rejects.toMatchObject({ code: "upstream_timeout" });
    await vi.advanceTimersByTimeAsync(
      ACUITY_MIN_REQUEST_INTERVAL_MS + ACUITY_REQUEST_TIMEOUT_MS + 10
    );
    await assertion;
  });

  it("treats an unreadable error body as empty rather than failing twice", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      headers: { get: () => null },
      text: async () => {
        throw new Error("stream already consumed");
      }
    } as never);
    await expect(acuityFetch(CONN, { method: "GET", path: "/me" })).rejects.toMatchObject({
      code: "request_failed",
      acuityError: undefined
    });
  });

  it("treats a non-Error rejection as unreachable rather than crashing", async () => {
    fetchMock.mockRejectedValueOnce(undefined);
    await expect(acuityFetch(CONN, { method: "GET", path: "/me" })).rejects.toMatchObject({
      code: "upstream_unreachable"
    });
  });

  it("supplies its own copy when a slot_unavailable body carries no message", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(400, { error: "not_available" }));
    await expect(
      acuityFetch(CONN, { method: "POST", path: "/appointments" })
    ).rejects.toMatchObject({
      code: "slot_unavailable",
      message: "That time is no longer available on Acuity"
    });
  });

  it("returns null rather than throwing when the success body is not JSON", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => {
        throw new Error("not json");
      }
    } as never);
    await expect(acuityFetch(CONN, { method: "GET", path: "/me" })).resolves.toBeNull();
  });

  it("repeats bracketed array params once per value and skips undefined", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, []));
    await acuityFetch(CONN, {
      method: "GET",
      path: "/availability/times",
      query: { "ignoreAppointmentIDs[]": ["7", "8"], calendarID: undefined, date: "2026-08-04" }
    });
    const url = lastUrl();
    expect(url.searchParams.getAll("ignoreAppointmentIDs[]")).toEqual(["7", "8"]);
    expect(url.searchParams.has("calendarID")).toBe(false);
    expect(url.searchParams.get("date")).toBe("2026-08-04");
  });
});

describe("rate limiting", () => {
  it("draws on ONE fleet-wide bucket, not a per-business one", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, {}));
    await acuityFetch(CONN, { method: "GET", path: "/me" });
    await acuityFetch({ ...(CONN as object), business_id: "biz-2" } as never, {
      method: "GET",
      path: "/me"
    });
    // Both calls key the same bucket: Acuity's ceiling is per egress IP, so a
    // per-business key would let N tenants each "stay under" it together.
    for (const call of rateLimitDurableMock.mock.calls) {
      expect(call[0]).toBe("acuity:global");
    }
    expect(rateLimitDurableMock).toHaveBeenCalledTimes(2);
  });

  it("logs every 429 so the real per-IP ceiling is observable", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(429, {}, { "retry-after": "1" }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    await expect(acuityFetch(CONN, { method: "GET", path: "/me" })).resolves.toEqual({ ok: true });
    expect(recordSystemLogMock).toHaveBeenCalledTimes(1);
    expect(recordSystemLogMock.mock.calls[0][0]).toMatchObject({
      businessId: "biz-1",
      event: "acuity_rate_limited",
      payload: { retryAfter: 1 }
    });
  });

  it("retries a 429 exactly once, then surfaces rate_limited", async () => {
    fetchMock.mockResolvedValue(jsonResponse(429, {}));
    await expect(acuityFetch(CONN, { method: "GET", path: "/me" })).rejects.toMatchObject({
      code: "rate_limited"
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("logs a null retryAfter when the header is an HTTP date rather than seconds", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(429, {}, { "retry-after": "Wed, 04 Aug 2026 13:00:00 GMT" })
      )
      .mockResolvedValueOnce(jsonResponse(200, {}));
    await acuityFetch(CONN, { method: "GET", path: "/me" });
    expect(recordSystemLogMock.mock.calls[0][0]).toMatchObject({
      payload: { retryAfter: null }
    });
  });

  it("waits out the window and re-checks when the fleet budget is momentarily spent", async () => {
    rateLimitDurableMock.mockResolvedValueOnce({
      success: false,
      limit: 6,
      remaining: 0,
      reset: Date.now() + 30
    });
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    await expect(acuityFetch(CONN, { method: "GET", path: "/me" })).resolves.toEqual({ ok: true });
    // Re-checked rather than proceeding on the failed first check.
    expect(rateLimitDurableMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("REFUSES to call Acuity at all once the fleet budget stays exhausted", async () => {
    // The whole point of a global bucket is that an over-budget check
    // prevents the request. Sleeping and then calling anyway would make the
    // cap decorative and push enforcement onto Acuity's own 429s.
    rateLimitDurableMock.mockResolvedValue({
      success: false,
      limit: 6,
      remaining: 0,
      reset: Date.now() + 5
    });
    await expect(acuityFetch(CONN, { method: "GET", path: "/me" })).rejects.toMatchObject({
      code: "rate_limited"
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(rateLimitDurableMock).toHaveBeenCalledTimes(ACUITY_FLEET_WAIT_ATTEMPTS);
    expect(recordSystemLogMock.mock.calls[0][0]).toMatchObject({
      event: "acuity_fleet_budget_exhausted"
    });
  });

  it("serializes concurrent calls instead of bursting", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, {}));
    const started = Date.now();
    await Promise.all([
      acuityFetch(CONN, { method: "GET", path: "/me" }),
      acuityFetch(CONN, { method: "GET", path: "/me" }),
      acuityFetch(CONN, { method: "GET", path: "/me" })
    ]);
    // Three requests cannot clear faster than two inter-request gaps.
    expect(Date.now() - started).toBeGreaterThanOrEqual(ACUITY_MIN_REQUEST_INTERVAL_MS * 2);
  });
});

describe("appointment types", () => {
  const TYPES = [
    { id: 1, name: "Consult", duration: 30, type: "service", active: true, calendarIDs: [7] },
    { id: 2, name: "Yoga", duration: 60, type: "class", active: true, classSize: 12 },
    { id: 3, name: "Old", duration: 30, type: "service", active: false },
    { name: "no id", duration: 15 }
  ];

  it("normalizes every type and keeps classes for the caller to filter", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, TYPES));
    const types = await listAcuityAppointmentTypes(CONN);
    expect(types).toEqual([
      {
        id: "1",
        name: "Consult",
        durationMinutes: 30,
        type: "service",
        active: true,
        calendarIds: ["7"]
      },
      { id: "2", name: "Yoga", durationMinutes: 60, type: "class", active: true, calendarIds: [] },
      { id: "3", name: "Old", durationMinutes: 30, type: "service", active: false, calendarIds: [] }
    ]);
  });

  it("defaults a payload with no type discriminator to service", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, [{ id: 9, name: "X", duration: 30 }]));
    const types = await listAcuityAppointmentTypes(CONN);
    expect(types[0].type).toBe("service");
  });

  it("coerces a stringified duration and a missing one", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, [
        { id: 9, name: "String", duration: "45" },
        { id: 10, name: "Blank", duration: "" },
        { id: 11, name: "None" }
      ])
    );
    const types = await listAcuityAppointmentTypes(CONN);
    expect(types.map((t) => t.durationMinutes)).toEqual([45, null, null]);
  });

  it("returns nothing when the catalog response is not an array", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { unexpected: true }));
    await expect(listAcuityAppointmentTypes(CONN)).resolves.toEqual([]);
  });

  it("clearing caches does NOT reset the request serializer", async () => {
    // The chain is a concurrency primitive, not a cache. Resetting it while
    // requests are in flight lets the next caller skip the wait, and two
    // overlapping requests is the exact burst the serializer prevents
    // against a per-IP rate limit.
    fetchMock.mockResolvedValue(jsonResponse(200, {}));
    const started = Date.now();
    const inFlight = acuityFetch(CONN, { method: "GET", path: "/me" });
    clearAcuityCaches();
    await Promise.all([inFlight, acuityFetch(CONN, { method: "GET", path: "/me" })]);
    // A few ms of tolerance: each of the two serializer sleeps can fire ~1ms
    // early on a loaded runner (Node timer granularity; flaked at 239 vs 240
    // on PR #1127's CI). A real serializer reset would show up as a whole
    // missing 120ms interval, which this floor still fails loudly. The
    // three-request test above needs no tolerance: it asserts two intervals
    // against three paid sleeps, a full interval of slack.
    expect(Date.now() - started).toBeGreaterThanOrEqual(ACUITY_MIN_REQUEST_INTERVAL_MS * 2 - 5);
  });

  it("caches the catalog per connection and clears on demand", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, TYPES));
    await listAcuityAppointmentTypes(CONN);
    await listAcuityAppointmentTypes(CONN);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    clearAcuityCaches();
    await listAcuityAppointmentTypes(CONN);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("expires the catalog cache", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, TYPES));
    await listAcuityAppointmentTypes(CONN);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 10 * 60_000);
    await listAcuityAppointmentTypes(CONN);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.restoreAllMocks();
  });
});

describe("calendars and availability", () => {
  it("lists calendars with their own timezones", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, [
        { id: 7, name: "Ana", timezone: "America/Denver" },
        { name: "no id" }
      ])
    );
    await expect(listAcuityCalendars(CONN)).resolves.toEqual([
      { id: "7", name: "Ana", timezone: "America/Denver" }
    ]);
  });

  it("asks for dates by month with an explicit timezone", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, [{ date: "2026-08-04" }, { date: "2026-08-05" }, {}])
    );
    const dates = await listAcuityAvailableDates(CONN, {
      month: "2026-08",
      appointmentTypeId: "1",
      calendarId: "7",
      timezone: "America/New_York"
    });
    expect(dates).toEqual(["2026-08-04", "2026-08-05"]);
    const url = lastUrl();
    expect(url.pathname).toBe("/api/v1/availability/dates");
    expect(url.searchParams.get("month")).toBe("2026-08");
    expect(url.searchParams.get("timezone")).toBe("America/New_York");
    expect(url.searchParams.get("calendarID")).toBe("7");
  });

  it("omits calendarID when the merchant has no default calendar pinned", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, []));
    await listAcuityAvailableDates(CONN, {
      month: "2026-08",
      appointmentTypeId: "1",
      timezone: "UTC"
    });
    expect(lastUrl().searchParams.has("calendarID")).toBe(false);
  });

  it("scopes the times read to a pinned calendar when there is one", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, []));
    await listAcuityAvailableTimes(CONN, {
      date: "2026-08-04",
      appointmentTypeId: "1",
      calendarId: "7",
      timezone: "UTC"
    });
    expect(lastUrl().searchParams.get("calendarID")).toBe("7");
  });

  it("normalizes returned times and forwards ignoreAppointmentIDs[]", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, [{ time: "2026-08-04T13:00:00-0400" }, {}])
    );
    const times = await listAcuityAvailableTimes(CONN, {
      date: "2026-08-04",
      appointmentTypeId: "1",
      timezone: "America/New_York",
      ignoreAppointmentId: "55"
    });
    expect(times).toEqual(["2026-08-04T17:00:00.000Z"]);
    expect(lastUrl().searchParams.getAll("ignoreAppointmentIDs[]")).toEqual(["55"]);
  });

  it("omits ignoreAppointmentIDs[] when there is nothing to ignore", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, []));
    await listAcuityAvailableTimes(CONN, {
      date: "2026-08-04",
      appointmentTypeId: "1",
      timezone: "UTC"
    });
    expect(lastUrl().searchParams.has("ignoreAppointmentIDs[]")).toBe(false);
  });
});

describe("appointment normalization", () => {
  const RAW = {
    id: 100,
    datetime: "2026-08-04T13:00:00-0400",
    endTime: "2026-08-04T13:30:00-0400",
    dateCreated: "2026-08-01T09:00:00-0400",
    duration: 30,
    appointmentTypeID: 1,
    type: "Consult",
    calendarID: 7,
    calendar: "Ana",
    firstName: "Sam",
    lastName: "Rivera",
    email: "sam@example.com",
    phone: "+15551234567",
    notes: "prefers mornings",
    timezone: "America/New_York"
  };

  it("normalizes a full payload", () => {
    expect(normalizeAcuityAppointment(RAW, false)).toEqual({
      id: "100",
      startIso: "2026-08-04T17:00:00.000Z",
      endIso: "2026-08-04T17:30:00.000Z",
      createdIso: "2026-08-01T13:00:00.000Z",
      canceled: false,
      appointmentTypeId: "1",
      appointmentTypeName: "Consult",
      calendarId: "7",
      calendarName: "Ana",
      durationMinutes: 30,
      customerName: "Sam Rivera",
      customerEmail: "sam@example.com",
      customerPhone: "+15551234567",
      notes: "prefers mornings",
      timezone: "America/New_York"
    });
  });

  it("derives endIso from duration when endTime is a bare wall clock", () => {
    const out = normalizeAcuityAppointment({ ...RAW, endTime: "13:30" }, false);
    expect(out?.endIso).toBe("2026-08-04T17:30:00.000Z");
  });

  it("leaves endIso null when there is neither a usable end nor a duration", () => {
    const out = normalizeAcuityAppointment(
      { id: 1, datetime: "2026-08-04T13:00:00-0400" },
      false
    );
    expect(out?.endIso).toBeNull();
    expect(out?.durationMinutes).toBeNull();
    expect(out?.customerName).toBeNull();
  });

  it("drops rows with no id or no parseable start", () => {
    expect(normalizeAcuityAppointment({ datetime: RAW.datetime })).toBeNull();
    expect(normalizeAcuityAppointment({ id: 1 })).toBeNull();
    expect(normalizeAcuityAppointment({ id: 1, datetime: "garbage" })).toBeNull();
  });

  it("tolerates an unparseable dateCreated rather than losing the appointment", () => {
    const out = normalizeAcuityAppointment({ ...RAW, dateCreated: "garbage" }, false);
    expect(out?.createdIso).toBeNull();
    expect(out?.id).toBe("100");
  });

  it("falls back to the noShow hint when no cancel state is passed", () => {
    expect(normalizeAcuityAppointment({ ...RAW, noShow: false })?.canceled).toBe(true);
    expect(normalizeAcuityAppointment(RAW)?.canceled).toBe(false);
  });
});

describe("appointment reads and writes", () => {
  it("selects the canceled listing and marks rows canceled", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, [{ id: 1, datetime: "2026-08-04T13:00:00-0400", duration: 30 }])
    );
    const rows = await listAcuityAppointments(CONN, {
      minDate: "2026-08-01",
      maxDate: "2026-08-31",
      canceled: true,
      max: 100
    });
    expect(rows[0].canceled).toBe(true);
    const url = lastUrl();
    expect(url.searchParams.get("canceled")).toBe("true");
    expect(url.searchParams.get("max")).toBe("100");
    expect(url.searchParams.get("excludeForms")).toBe("true");
  });

  it("omits the canceled filter for the default (active) listing", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, []));
    await listAcuityAppointments(CONN, {
      email: "a@b.co",
      phone: "+1555",
      calendarId: "7",
      appointmentTypeId: "1"
    });
    const url = lastUrl();
    expect(url.searchParams.has("canceled")).toBe(false);
    expect(url.searchParams.has("minDate")).toBe(false);
    expect(url.searchParams.has("maxDate")).toBe(false);
    expect(url.searchParams.has("max")).toBe(false);
    expect(url.searchParams.get("email")).toBe("a@b.co");
    expect(url.searchParams.get("phone")).toBe("+1555");
    expect(url.searchParams.get("calendarID")).toBe("7");
    expect(url.searchParams.get("appointmentTypeID")).toBe("1");
  });

  it("skips listing rows that cannot be normalized", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, [
        { id: 1, datetime: "2026-08-04T13:00:00-0400", duration: 30 },
        { datetime: "2026-08-04T14:00:00-0400" },
        { id: 3, datetime: "garbage" }
      ])
    );
    const rows = await listAcuityAppointments(CONN, {});
    expect(rows.map((r) => r.id)).toEqual(["1"]);
  });

  it("falls back to the noShow heuristic when a single fetch omits canceled", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { id: 1, datetime: "2026-08-04T13:00:00-0400", noShow: false })
    );
    await expect(getAcuityAppointment(CONN, "1")).resolves.toMatchObject({ canceled: true });
  });

  it("returns null for a missing appointment instead of throwing", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(404, {}));
    await expect(getAcuityAppointment(CONN, "404")).resolves.toBeNull();
  });

  it("propagates non-404 failures from a single fetch", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(401, {}));
    await expect(getAcuityAppointment(CONN, "1")).rejects.toMatchObject({ code: "auth_failed" });
  });

  it("trusts an explicit canceled flag on a single fetch", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { id: 1, datetime: "2026-08-04T13:00:00-0400", canceled: true })
    );
    await expect(getAcuityAppointment(CONN, "1")).resolves.toMatchObject({ canceled: true });
  });

  it("returns null when a single fetch yields an empty body", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, null));
    await expect(getAcuityAppointment(CONN, "1")).resolves.toBeNull();
  });

  it("sends notes only in admin mode, and honors noEmail", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { id: 5, datetime: "2026-08-04T13:00:00-0400", duration: 30 })
    );
    await createAcuityAppointment(CONN, {
      datetime: "2026-08-04T13:00:00-04:00",
      appointmentTypeId: "1",
      firstName: "Sam",
      lastName: "Rivera",
      email: "sam@example.com",
      phone: "+15551234567",
      timezone: "America/New_York",
      calendarId: "7",
      notes: "via coworker",
      admin: true,
      noEmail: true
    });
    const url = lastUrl();
    expect(url.searchParams.get("admin")).toBe("true");
    expect(url.searchParams.get("noEmail")).toBe("true");
    const body = JSON.parse((fetchMock.mock.calls.at(-1)?.[1] as RequestInit).body as string);
    expect(body).toMatchObject({ notes: "via coworker", calendarID: "7", phone: "+15551234567" });
  });

  it("drops notes in client mode, where Acuity rejects them", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, null));
    await createAcuityAppointment(CONN, {
      datetime: "2026-08-04T13:00:00-04:00",
      appointmentTypeId: "1",
      firstName: "Sam",
      lastName: "Rivera",
      email: "sam@example.com",
      timezone: "America/New_York",
      notes: "dropped",
      admin: false,
      noEmail: false
    });
    const url = lastUrl();
    expect(url.searchParams.has("admin")).toBe(false);
    expect(url.searchParams.has("noEmail")).toBe(false);
    const body = JSON.parse((fetchMock.mock.calls.at(-1)?.[1] as RequestInit).body as string);
    expect(body.notes).toBeUndefined();
    expect(body.calendarID).toBeUndefined();
  });

  it("reschedules as admin and keeps the original calendar when none is given", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { id: 5, datetime: "2026-08-05T13:00:00-0400", duration: 30 })
    );
    await rescheduleAcuityAppointmentTime(CONN, "5", {
      datetime: "2026-08-05T13:00:00-04:00",
      timezone: "America/New_York",
      admin: true,
      noEmail: true
    });
    const url = lastUrl();
    expect(url.pathname).toBe("/api/v1/appointments/5/reschedule");
    expect(url.searchParams.get("admin")).toBe("true");
    const body = JSON.parse((fetchMock.mock.calls.at(-1)?.[1] as RequestInit).body as string);
    expect(body.calendarID).toBeUndefined();
  });

  it("omits admin so Acuity validates when the caller could not verify the slot", async () => {
    // admin waives availability validation. A caller that could not run the
    // ignore-aware precheck must NOT also waive Acuity's own check.
    fetchMock.mockResolvedValueOnce(jsonResponse(200, null));
    await rescheduleAcuityAppointmentTime(CONN, "5", {
      datetime: "2026-08-05T13:00:00-04:00",
      timezone: "UTC",
      admin: false,
      noEmail: true
    });
    expect(lastUrl().searchParams.has("admin")).toBe(false);
  });

  it("returns null when a reschedule response has no body", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, null));
    await expect(
      rescheduleAcuityAppointmentTime(CONN, "5", {
        datetime: "2026-08-05T13:00:00-04:00",
        timezone: "UTC",
        calendarId: "7",
        admin: true,
        noEmail: false
      })
    ).resolves.toBeNull();
    expect(lastUrl().searchParams.has("noEmail")).toBe(false);
  });

  it("cancels as admin", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, {}));
    await cancelAcuityAppointmentById(CONN, "5", { noEmail: true });
    const url = lastUrl();
    expect(url.pathname).toBe("/api/v1/appointments/5/cancel");
    expect(url.searchParams.get("admin")).toBe("true");
    expect(url.searchParams.get("noEmail")).toBe("true");
  });

  it("lets Acuity send its own cancellation notice when suppression is off", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, {}));
    await cancelAcuityAppointmentById(CONN, "5", { noEmail: false });
    expect(lastUrl().searchParams.has("noEmail")).toBe(false);
  });

  it("verifies credentials via /me", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { id: 12345, email: "owner@shop.com", timezone: "America/Denver" })
    );
    await expect(verifyAcuityCredentials(CONN)).resolves.toEqual({
      id: "12345",
      email: "owner@shop.com",
      timezone: "America/Denver"
    });
  });

  it("tolerates an empty /me body", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, null));
    await expect(verifyAcuityCredentials(CONN)).resolves.toEqual({
      id: null,
      email: null,
      timezone: null
    });
  });
});

describe("dynamic webhooks", () => {
  it("lists registrations, skipping malformed rows", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, [
        { id: 1, event: "appointment.scheduled", target: "https://x/y" },
        { event: "no id" },
        { id: 2 }
      ])
    );
    await expect(listAcuityWebhooks(CONN)).resolves.toEqual([
      { id: "1", event: "appointment.scheduled", target: "https://x/y" }
    ]);
  });

  it("creates a registration and returns its id", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { id: 42 }));
    await expect(
      createAcuityWebhook(CONN, "appointment.scheduled", "https://x/y")
    ).resolves.toEqual({ id: "42", event: "appointment.scheduled", target: "https://x/y" });
  });

  it("returns null when the create response carries no id", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, {}));
    await expect(
      createAcuityWebhook(CONN, "appointment.scheduled", "https://x/y")
    ).resolves.toBeNull();
  });

  it("deletes a registration by id", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, {}));
    await deleteAcuityWebhook(CONN, "42/x");
    expect(lastUrl().pathname).toBe("/api/v1/webhooks/42%2Fx");
    expect((fetchMock.mock.calls.at(-1)?.[1] as RequestInit).method).toBe("DELETE");
  });

  it("surfaces the 400 Acuity returns at the 25-webhook account cap", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(400, { status_code: 400, message: "Too many webhooks", error: "too_many" })
    );
    await expect(
      createAcuityWebhook(CONN, "appointment.scheduled", "https://x/y")
    ).rejects.toMatchObject({ code: "request_failed", status: 400, acuityError: "too_many" });
  });
});

describe("webhook signature", () => {
  const body = "action=scheduled&id=1&calendarID=7";
  const sign = (key: string): string =>
    require("node:crypto").createHmac("sha256", key).update(body, "utf8").digest("base64");

  it("accepts a signature computed with the account api key", () => {
    expect(verifyAcuityWebhookSignature(body, sign("key-abc"), "key-abc")).toBe(true);
  });

  it("rejects a signature from the wrong key", () => {
    expect(verifyAcuityWebhookSignature(body, sign("other"), "key-abc")).toBe(false);
  });

  it("rejects a tampered body", () => {
    expect(verifyAcuityWebhookSignature(`${body}&extra=1`, sign("key-abc"), "key-abc")).toBe(false);
  });

  it("rejects a missing header and a length-mismatched value", () => {
    expect(verifyAcuityWebhookSignature(body, null, "key-abc")).toBe(false);
    expect(verifyAcuityWebhookSignature(body, "short", "key-abc")).toBe(false);
  });
});
