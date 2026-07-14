/**
 * Tests for the Vagaro provider cores (src/lib/calendar-tools/vagaro.ts):
 * service resolution (explicit → default → closest duration), availability
 * mapping, real appointment creation, and the auth-failure surfacing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/vagaro-connections", () => ({ getActiveVagaroConnection: vi.fn() }));
vi.mock("@/lib/vagaro/client", () => {
  class VagaroApiError extends Error {
    constructor(
      public readonly code: string,
      message: string
    ) {
      super(message);
      this.name = "VagaroApiError";
    }
  }
  return {
    VagaroApiError,
    listVagaroServices: vi.fn(),
    searchVagaroAvailability: vi.fn(),
    createVagaroAppointment: vi.fn(),
    updateVagaroAppointmentTime: vi.fn(),
    deleteVagaroAppointment: vi.fn()
  };
});

import {
  bookVagaroAppointment,
  cancelVagaroAppointment,
  findVagaroSlots,
  rescheduleVagaroAppointment,
  resolveVagaroService
} from "@/lib/calendar-tools/vagaro";
import { getActiveVagaroConnection } from "@/lib/db/vagaro-connections";
import {
  createVagaroAppointment,
  deleteVagaroAppointment,
  listVagaroServices,
  searchVagaroAvailability,
  updateVagaroAppointmentTime,
  VagaroApiError
} from "@/lib/vagaro/client";

const BIZ = "11111111-1111-4111-8111-111111111111";
const NOW = Date.parse("2026-06-12T09:00:00.000Z");

/** Construct the factory-mocked VagaroApiError (real class, mock module). */
function apiError(code: string, message: string): Error {
  const Ctor = VagaroApiError as unknown as new (code: string, message: string) => Error;
  return new Ctor(code, message);
}

const CONN = {
  id: "vg-1",
  business_id: BIZ,
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

const HAIRCUT = { id: "svc-30", name: "Haircut", durationMinutes: 30 };
const COLOR = { id: "svc-90", name: "Color", durationMinutes: 90 };

const WINDOW = {
  windowStart: new Date(NOW + 60 * 60_000),
  windowEnd: new Date(NOW + 26 * 60 * 60_000),
  durationMinutes: 30,
  timezone: "America/Phoenix"
};

const BOOK_ARGS = {
  startIso: "2026-06-12T15:00:00.000Z",
  endIso: "2026-06-12T15:30:00.000Z",
  summary: "Haircut for Joe",
  attendeeName: "Joe"
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.mocked(getActiveVagaroConnection).mockResolvedValue(CONN);
  vi.mocked(listVagaroServices).mockResolvedValue([HAIRCUT, COLOR]);
  vi.mocked(searchVagaroAvailability).mockResolvedValue([]);
  vi.mocked(createVagaroAppointment).mockResolvedValue({ appointmentId: "appt-1" });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("resolveVagaroService", () => {
  it("prefers the explicit arg, then the owner's default, without listing", async () => {
    expect(await resolveVagaroService(CONN, "svc-x", 30)).toEqual({
      id: "svc-x",
      name: null,
      durationMinutes: null
    });
    const withDefault = { ...(CONN as object), default_service_id: "svc-def" } as never;
    expect(await resolveVagaroService(withDefault, undefined, 30)).toEqual({
      id: "svc-def",
      name: null,
      durationMinutes: null
    });
    // A whitespace-only explicit arg falls through to the default.
    expect(await resolveVagaroService(withDefault, "  ", 30)).toEqual({
      id: "svc-def",
      name: null,
      durationMinutes: null
    });
    expect(listVagaroServices).not.toHaveBeenCalled();
  });

  it("falls back to the closest-duration service from the listing", async () => {
    expect(await resolveVagaroService(CONN, undefined, 80)).toEqual({
      id: "svc-90",
      name: "Color",
      durationMinutes: 90
    });
    expect(await resolveVagaroService(CONN, undefined, 35)).toEqual({
      id: "svc-30",
      name: "Haircut",
      durationMinutes: 30
    });
  });

  it("treats a duration-less service as matching the request exactly", async () => {
    vi.mocked(listVagaroServices).mockResolvedValue([
      HAIRCUT,
      { id: "svc-any", name: "Anything", durationMinutes: null }
    ]);
    expect(await resolveVagaroService(CONN, undefined, 55)).toEqual({
      id: "svc-any",
      name: "Anything",
      durationMinutes: null
    });
  });

  it("keeps a duration-less BEST over a worse-fitting candidate", async () => {
    vi.mocked(listVagaroServices).mockResolvedValue([
      { id: "svc-any", name: "Anything", durationMinutes: null },
      COLOR
    ]);
    // Null-duration best counts as an exact match (gap 0) → Color never wins.
    expect(await resolveVagaroService(CONN, undefined, 30)).toEqual({
      id: "svc-any",
      name: "Anything",
      durationMinutes: null
    });
  });

  it("is no_services when the merchant has nothing bookable", async () => {
    vi.mocked(listVagaroServices).mockResolvedValue([]);
    expect(await resolveVagaroService(CONN, undefined, 30)).toBe("no_services");
  });
});

describe("findVagaroSlots", () => {
  it("is calendar_not_connected without an active connection", async () => {
    vi.mocked(getActiveVagaroConnection).mockResolvedValue(null);
    expect(await findVagaroSlots(BIZ, WINDOW)).toEqual({
      ok: false,
      detail: "calendar_not_connected"
    });
  });

  it("surfaces a merchant with no services", async () => {
    vi.mocked(listVagaroServices).mockResolvedValue([]);
    expect(await findVagaroSlots(BIZ, WINDOW)).toEqual({
      ok: false,
      detail: "vagaro_no_services"
    });
  });

  it("rejects a window entirely in the past", async () => {
    expect(
      await findVagaroSlots(BIZ, {
        ...WINDOW,
        windowStart: new Date(NOW - 2 * 60 * 60_000),
        windowEnd: new Date(NOW - 60 * 60_000)
      })
    ).toEqual({ ok: false, detail: "invalid_window" });
  });

  it("maps availability into slots, backfilling missing ends from the service duration", async () => {
    vi.mocked(searchVagaroAvailability).mockResolvedValue([
      { startIso: "2026-06-12T15:00:00.000Z", endIso: "2026-06-12T15:30:00.000Z" },
      { startIso: "2026-06-12T16:00:00.000Z", endIso: null },
      { startIso: "2026-06-12T17:00:00.000Z", endIso: null },
      { startIso: "2026-06-12T18:00:00.000Z", endIso: null } // 4th → dropped by cap
    ]);
    const result = await findVagaroSlots(BIZ, { ...WINDOW, purpose: "trim" });
    expect(result).toEqual({
      ok: true,
      data: {
        slots: [
          { startIso: "2026-06-12T15:00:00.000Z", endIso: "2026-06-12T15:30:00.000Z" },
          { startIso: "2026-06-12T16:00:00.000Z", endIso: "2026-06-12T16:30:00.000Z" },
          { startIso: "2026-06-12T17:00:00.000Z", endIso: "2026-06-12T17:30:00.000Z" }
        ],
        timezone: "America/Phoenix",
        purpose: "trim",
        durationMinutes: 30,
        provider: "vagaro",
        serviceId: "svc-30",
        serviceName: "Haircut"
      }
    });
    expect(searchVagaroAvailability).toHaveBeenCalledWith(CONN, {
      serviceId: "svc-30",
      employeeId: null,
      startIso: WINDOW.windowStart.toISOString(),
      endIso: WINDOW.windowEnd.toISOString()
    });
  });

  it("clamps a past window start to now and honors the default employee", async () => {
    const withEmployee = {
      ...(CONN as object),
      default_employee_id: "emp-7",
      default_service_id: "svc-def"
    } as never;
    vi.mocked(getActiveVagaroConnection).mockResolvedValue(withEmployee);
    await findVagaroSlots(BIZ, { ...WINDOW, windowStart: new Date(NOW - 60 * 60_000) });
    const call = vi.mocked(searchVagaroAvailability).mock.calls[0][1];
    expect(call.startIso).toBe(new Date(NOW).toISOString());
    expect(call.employeeId).toBe("emp-7");
    expect(call.serviceId).toBe("svc-def");
  });

  it("echoes the requested duration when the pinned service has no known duration", async () => {
    const withDefault = { ...(CONN as object), default_service_id: "svc-def" } as never;
    vi.mocked(getActiveVagaroConnection).mockResolvedValue(withDefault);
    const result = await findVagaroSlots(BIZ, { ...WINDOW, durationMinutes: 45 });
    expect((result.data as { durationMinutes: number }).durationMinutes).toBe(45);
    expect((result.data as { purpose: null }).purpose).toBeNull();
  });

  it("maps credential rejections to vagaro_auth_failed and rethrows other errors", async () => {
    vi.mocked(searchVagaroAvailability).mockRejectedValueOnce(apiError("auth_failed", "401"));
    expect(await findVagaroSlots(BIZ, WINDOW)).toEqual({
      ok: false,
      detail: "vagaro_auth_failed"
    });

    vi.mocked(searchVagaroAvailability).mockRejectedValueOnce(
      apiError("request_failed", "500")
    );
    await expect(findVagaroSlots(BIZ, WINDOW)).rejects.toThrow(/500/);
  });
});

describe("bookVagaroAppointment", () => {
  it("is calendar_not_connected without an active connection", async () => {
    vi.mocked(getActiveVagaroConnection).mockResolvedValue(null);
    expect(await bookVagaroAppointment(BIZ, BOOK_ARGS)).toEqual({
      ok: false,
      detail: "calendar_not_connected"
    });
  });

  it("surfaces a merchant with no services", async () => {
    vi.mocked(listVagaroServices).mockResolvedValue([]);
    expect(await bookVagaroAppointment(BIZ, BOOK_ARGS)).toEqual({
      ok: false,
      detail: "vagaro_no_services"
    });
  });

  it("creates the appointment with the summary+notes and the caller-phone fallback", async () => {
    const result = await bookVagaroAppointment(
      BIZ,
      { ...BOOK_ARGS, notes: "gate code 1234", attendeeEmail: "joe@example.com" },
      "+15551230000"
    );
    expect(result).toEqual({
      ok: true,
      data: {
        eventId: "appt-1",
        htmlLink: null,
        provider: "vagaro",
        calendar: "vagaro",
        serviceId: "svc-30",
        serviceName: "Haircut"
      }
    });
    expect(createVagaroAppointment).toHaveBeenCalledWith(CONN, {
      serviceId: "svc-30",
      employeeId: null,
      startIso: "2026-06-12T15:00:00.000Z",
      endIso: "2026-06-12T15:30:00.000Z",
      customerName: "Joe",
      customerPhone: "+15551230000",
      customerEmail: "joe@example.com",
      notes: "Haircut for Joe\ngate code 1234"
    });
  });

  it("prefers the explicit attendee phone and serviceId, clamping degenerate durations", async () => {
    await bookVagaroAppointment(
      BIZ,
      {
        ...BOOK_ARGS,
        endIso: BOOK_ARGS.startIso, // degenerate → 1-minute duration ask
        attendeePhone: "+15559998888",
        serviceId: "svc-explicit"
      },
      "+15551230000"
    );
    const input = vi.mocked(createVagaroAppointment).mock.calls[0][1];
    expect(input.serviceId).toBe("svc-explicit");
    expect(input.customerPhone).toBe("+15559998888");
    expect(input.customerEmail).toBeNull();
    expect(listVagaroServices).not.toHaveBeenCalled();
  });

  it("maps credential rejections to vagaro_auth_failed and rethrows other errors", async () => {
    vi.mocked(createVagaroAppointment).mockRejectedValueOnce(apiError("auth_failed", "401"));
    expect(await bookVagaroAppointment(BIZ, BOOK_ARGS)).toEqual({
      ok: false,
      detail: "vagaro_auth_failed"
    });

    vi.mocked(createVagaroAppointment).mockRejectedValueOnce(new Error("network"));
    await expect(bookVagaroAppointment(BIZ, BOOK_ARGS)).rejects.toThrow(/network/);
  });
});

describe("rescheduleVagaroAppointment", () => {
  it("is calendar_not_connected without an active connection", async () => {
    vi.mocked(getActiveVagaroConnection).mockResolvedValue(null);
    expect(
      await rescheduleVagaroAppointment(
        BIZ,
        "appt-1",
        "2026-06-13T15:00:00.000Z",
        "2026-06-13T15:30:00.000Z"
      )
    ).toEqual({ ok: false, detail: "calendar_not_connected" });
    expect(updateVagaroAppointmentTime).not.toHaveBeenCalled();
  });

  it("moves the appointment in place, normalizing times to ISO instants", async () => {
    const result = await rescheduleVagaroAppointment(
      BIZ,
      "appt-1",
      // Offset form: the core must normalize to the UTC instant.
      "2026-06-13T08:00:00-07:00",
      "2026-06-13T08:30:00-07:00"
    );
    expect(result).toEqual({
      ok: true,
      data: {
        eventId: "appt-1",
        provider: "vagaro",
        startIso: "2026-06-13T15:00:00.000Z",
        endIso: "2026-06-13T15:30:00.000Z",
        rescheduled: true
      }
    });
    expect(updateVagaroAppointmentTime).toHaveBeenCalledWith(
      CONN,
      "appt-1",
      "2026-06-13T15:00:00.000Z",
      "2026-06-13T15:30:00.000Z"
    );
  });

  it("maps credential rejections to vagaro_auth_failed and rethrows other errors", async () => {
    vi.mocked(updateVagaroAppointmentTime).mockRejectedValueOnce(apiError("auth_failed", "401"));
    expect(
      await rescheduleVagaroAppointment(
        BIZ,
        "appt-1",
        "2026-06-13T15:00:00.000Z",
        "2026-06-13T15:30:00.000Z"
      )
    ).toEqual({ ok: false, detail: "vagaro_auth_failed" });

    vi.mocked(updateVagaroAppointmentTime).mockRejectedValueOnce(new Error("network"));
    await expect(
      rescheduleVagaroAppointment(
        BIZ,
        "appt-1",
        "2026-06-13T15:00:00.000Z",
        "2026-06-13T15:30:00.000Z"
      )
    ).rejects.toThrow(/network/);
  });
});

describe("cancelVagaroAppointment", () => {
  it("is calendar_not_connected without an active connection", async () => {
    vi.mocked(getActiveVagaroConnection).mockResolvedValue(null);
    expect(await cancelVagaroAppointment(BIZ, "appt-1")).toEqual({
      ok: false,
      detail: "calendar_not_connected"
    });
    expect(deleteVagaroAppointment).not.toHaveBeenCalled();
  });

  it("deletes the appointment on the merchant's book", async () => {
    expect(await cancelVagaroAppointment(BIZ, "appt-1")).toEqual({
      ok: true,
      data: { eventId: "appt-1", provider: "vagaro", canceled: true }
    });
    expect(deleteVagaroAppointment).toHaveBeenCalledWith(CONN, "appt-1");
  });

  it("maps credential rejections to vagaro_auth_failed and rethrows other errors", async () => {
    vi.mocked(deleteVagaroAppointment).mockRejectedValueOnce(apiError("auth_failed", "401"));
    expect(await cancelVagaroAppointment(BIZ, "appt-1")).toEqual({
      ok: false,
      detail: "vagaro_auth_failed"
    });

    vi.mocked(deleteVagaroAppointment).mockRejectedValueOnce(new Error("network"));
    await expect(cancelVagaroAppointment(BIZ, "appt-1")).rejects.toThrow(/network/);
  });
});
