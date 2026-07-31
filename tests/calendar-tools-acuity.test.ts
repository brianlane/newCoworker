/**
 * Tests for the Acuity calendar-tool cores (src/lib/calendar-tools/acuity.ts).
 *
 * The properties worth pinning here are the ones that cost money or trust
 * when they break: the availability fan-out staying bounded (Acuity's rate
 * limit is per egress IP and shared fleet-wide), a reschedule never waiving
 * validation it could not perform, and cancel refusing to act on a ledger row
 * that has drifted, because an Acuity cancellation cannot be undone.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

const getActiveAcuityConnectionMock = vi.fn();
vi.mock("@/lib/db/acuity-connections", () => ({
  getActiveAcuityConnection: (businessId: string) => getActiveAcuityConnectionMock(businessId)
}));

const listAcuityAppointmentTypesMock = vi.fn();
const listAcuityAvailableDatesMock = vi.fn();
const listAcuityAvailableTimesMock = vi.fn();
const createAcuityAppointmentMock = vi.fn();
const getAcuityAppointmentMock = vi.fn();
const rescheduleAcuityAppointmentTimeMock = vi.fn();
const cancelAcuityAppointmentByIdMock = vi.fn();
const listAcuityAppointmentsMock = vi.fn();

vi.mock("@/lib/acuity/client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/acuity/client")>(
    "@/lib/acuity/client"
  );
  return {
    // Keep the REAL time helpers: a mocked acuityDateTime would hide exactly
    // the offset bugs those helpers exist to prevent.
    acuityDateTime: actual.acuityDateTime,
    acuityLocalDate: actual.acuityLocalDate,
    AcuityApiError: actual.AcuityApiError,
    listAcuityAppointmentTypes: (...a: unknown[]) => listAcuityAppointmentTypesMock(...a),
    listAcuityAvailableDates: (...a: unknown[]) => listAcuityAvailableDatesMock(...a),
    listAcuityAvailableTimes: (...a: unknown[]) => listAcuityAvailableTimesMock(...a),
    createAcuityAppointment: (...a: unknown[]) => createAcuityAppointmentMock(...a),
    getAcuityAppointment: (...a: unknown[]) => getAcuityAppointmentMock(...a),
    rescheduleAcuityAppointmentTime: (...a: unknown[]) =>
      rescheduleAcuityAppointmentTimeMock(...a),
    cancelAcuityAppointmentById: (...a: unknown[]) => cancelAcuityAppointmentByIdMock(...a),
    listAcuityAppointments: (...a: unknown[]) => listAcuityAppointmentsMock(...a)
  };
});

import { AcuityApiError } from "@/lib/acuity/client";
import {
  ACUITY_MAX_AVAILABILITY_CALLS,
  ACUITY_MAX_AVAILABILITY_DAYS,
  acuityBookingEmail,
  acuityWindowDates,
  bookAcuityAppointment,
  cancelAcuityAppointment,
  findAcuitySlots,
  listAcuityUpcomingForAttendee,
  rescheduleAcuityAppointment,
  resolveAcuityAppointmentType,
  splitAcuityName
} from "@/lib/calendar-tools/acuity";

const BIZ = "biz-1";

function conn(overrides: Record<string, unknown> = {}) {
  return {
    id: "ac-1",
    business_id: BIZ,
    user_id: "12345",
    apiKey: "key",
    api_base_url: "https://acuityscheduling.com",
    webhook_verification_token: "tok",
    default_appointment_type_id: null,
    default_calendar_id: null,
    default_calendar_timezone: "America/New_York",
    suppress_provider_emails: true,
    webhook_registration: {},
    is_active: true,
    created_at: "",
    updated_at: "",
    ...overrides
  };
}

const SERVICE = {
  id: "1",
  name: "Consult",
  durationMinutes: 30,
  type: "service",
  active: true,
  calendarIds: [] as string[]
};

beforeEach(() => {
  vi.clearAllMocks();
  getActiveAcuityConnectionMock.mockResolvedValue(conn());
  listAcuityAppointmentTypesMock.mockResolvedValue([SERVICE]);
  listAcuityAvailableDatesMock.mockResolvedValue([]);
  listAcuityAvailableTimesMock.mockResolvedValue([]);
  // A successful reschedule returns the moved appointment; the core treats a
  // null response as "not moved", so the default here must be a real one.
  rescheduleAcuityAppointmentTimeMock.mockResolvedValue({
    id: "500",
    startIso: "2026-08-05T17:00:00.000Z",
    endIso: "2026-08-05T17:30:00.000Z",
    createdIso: null,
    canceled: false,
    appointmentTypeId: "1",
    appointmentTypeName: "Consult",
    calendarId: "7",
    calendarName: "Ana",
    durationMinutes: 30,
    customerName: "Sam",
    customerEmail: null,
    customerPhone: null,
    notes: null,
    timezone: "America/New_York"
  });
  vi.setSystemTime(new Date("2026-08-04T12:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("splitAcuityName", () => {
  it("gives a single-token name a placeholder last name Acuity will accept", () => {
    expect(splitAcuityName("Cher")).toEqual({ firstName: "Cher", lastName: "-" });
  });

  it("keeps multi-word surnames intact", () => {
    expect(splitAcuityName("Ana de la Cruz")).toEqual({
      firstName: "Ana",
      lastName: "de la Cruz"
    });
  });

  it("falls back for an empty name", () => {
    expect(splitAcuityName("   ")).toEqual({ firstName: "Customer", lastName: "-" });
  });
});

describe("acuityBookingEmail", () => {
  it("prefers the real address", () => {
    expect(acuityBookingEmail(" sam@example.org ", "+15551234567")).toBe("sam@example.org");
  });

  it("mints a non-deliverable placeholder from the phone when none is given", () => {
    // RFC 2606 reserved domain: it cannot deliver anywhere even by accident.
    expect(acuityBookingEmail(null, "+1 (555) 123-4567")).toBe(
      "no-reply+15551234567@example.com"
    );
    expect(acuityBookingEmail(undefined, null)).toBe("no-reply+unknown@example.com");
  });
});

describe("acuityWindowDates", () => {
  it("enumerates local dates in the requested zone, not UTC", () => {
    // 2026-08-04T03:00Z is still Aug 3 in New York.
    const dates = acuityWindowDates(
      Date.parse("2026-08-04T03:00:00Z"),
      Date.parse("2026-08-05T03:00:00Z"),
      "America/New_York",
      7
    );
    expect(dates[0]).toBe("2026-08-03");
  });

  it("respects the day cap", () => {
    const dates = acuityWindowDates(
      Date.parse("2026-08-01T00:00:00Z"),
      Date.parse("2026-09-01T00:00:00Z"),
      "UTC",
      ACUITY_MAX_AVAILABILITY_DAYS
    );
    expect(dates).toHaveLength(ACUITY_MAX_AVAILABILITY_DAYS);
  });

  it("includes the window's final local day for a sub-day window", () => {
    const dates = acuityWindowDates(
      Date.parse("2026-08-04T22:00:00Z"),
      Date.parse("2026-08-05T02:00:00Z"),
      "UTC",
      7
    );
    expect(dates).toEqual(["2026-08-04", "2026-08-05"]);
  });
});

describe("resolveAcuityAppointmentType", () => {
  it("prefers the explicit arg, then the owner default, then closest duration", async () => {
    const types = [
      { ...SERVICE, id: "1", durationMinutes: 30 },
      { ...SERVICE, id: "2", durationMinutes: 60 }
    ];
    listAcuityAppointmentTypesMock.mockResolvedValue(types);

    await expect(resolveAcuityAppointmentType(conn() as never, "2", 30)).resolves.toMatchObject({
      id: "2"
    });
    await expect(
      resolveAcuityAppointmentType(
        conn({ default_appointment_type_id: "2" }) as never,
        undefined,
        30
      )
    ).resolves.toMatchObject({ id: "2" });
    await expect(
      resolveAcuityAppointmentType(conn() as never, undefined, 55)
    ).resolves.toMatchObject({ id: "2" });
  });

  it("still resolves a pinned id against the catalog so the duration is known", async () => {
    // Vagaro short-circuits a pinned id; Acuity cannot, because the type's
    // duration is how a slot's end is computed.
    await expect(resolveAcuityAppointmentType(conn() as never, "1", 30)).resolves.toEqual({
      id: "1",
      name: "Consult",
      durationMinutes: 30
    });
  });

  it("degrades rather than failing when a pinned id was archived", async () => {
    listAcuityAppointmentTypesMock.mockResolvedValue([]);
    await expect(resolveAcuityAppointmentType(conn() as never, "99", 30)).resolves.toEqual({
      id: "99",
      name: null,
      durationMinutes: null
    });
  });

  it("skips classes, series and inactive types", async () => {
    listAcuityAppointmentTypesMock.mockResolvedValue([
      { ...SERVICE, id: "c", type: "class", durationMinutes: 30 },
      { ...SERVICE, id: "s", type: "series", durationMinutes: 30 },
      { ...SERVICE, id: "x", active: false, durationMinutes: 30 },
      { ...SERVICE, id: "ok", durationMinutes: 90 }
    ]);
    await expect(
      resolveAcuityAppointmentType(conn() as never, undefined, 30)
    ).resolves.toMatchObject({ id: "ok" });
  });

  it("honors calendarIDs when the owner pinned a calendar", async () => {
    listAcuityAppointmentTypesMock.mockResolvedValue([
      { ...SERVICE, id: "other", calendarIds: ["9"], durationMinutes: 30 },
      { ...SERVICE, id: "mine", calendarIds: ["7"], durationMinutes: 90 }
    ]);
    await expect(
      resolveAcuityAppointmentType(conn({ default_calendar_id: "7" }) as never, undefined, 30)
    ).resolves.toMatchObject({ id: "mine" });
  });

  it("treats a type with no duration as matching the requested one", async () => {
    // A null duration on the INCUMBENT best...
    listAcuityAppointmentTypesMock.mockResolvedValue([
      { ...SERVICE, id: "nodur", durationMinutes: null },
      { ...SERVICE, id: "far", durationMinutes: 240 }
    ]);
    await expect(
      resolveAcuityAppointmentType(conn() as never, undefined, 30)
    ).resolves.toMatchObject({ id: "nodur" });

    // ...and on a CANDIDATE, which is the other side of the same guard.
    listAcuityAppointmentTypesMock.mockResolvedValue([
      { ...SERVICE, id: "far", durationMinutes: 240 },
      { ...SERVICE, id: "nodur", durationMinutes: null }
    ]);
    await expect(
      resolveAcuityAppointmentType(conn() as never, undefined, 30)
    ).resolves.toMatchObject({ id: "nodur" });
  });

  it("reports no_types when nothing is bookable", async () => {
    listAcuityAppointmentTypesMock.mockResolvedValue([
      { ...SERVICE, id: "c", type: "class" }
    ]);
    await expect(resolveAcuityAppointmentType(conn() as never, undefined, 30)).resolves.toBe(
      "no_types"
    );
  });
});

describe("findAcuitySlots", () => {
  const baseArgs = {
    windowStart: new Date("2026-08-04T13:00:00Z"),
    windowEnd: new Date("2026-08-04T22:00:00Z"),
    durationMinutes: 30,
    timezone: "America/New_York"
  };

  it("refuses without a connection", async () => {
    getActiveAcuityConnectionMock.mockResolvedValue(null);
    await expect(findAcuitySlots(BIZ, baseArgs)).resolves.toEqual({
      ok: false,
      detail: "calendar_not_connected"
    });
  });

  it("rejects an inverted window", async () => {
    await expect(
      findAcuitySlots(BIZ, { ...baseArgs, windowEnd: new Date("2026-08-04T12:00:00Z") })
    ).resolves.toEqual({ ok: false, detail: "invalid_window" });
  });

  it("costs exactly one times-read for a single-day window", async () => {
    listAcuityAvailableTimesMock.mockResolvedValue(["2026-08-04T14:00:00.000Z"]);
    const res = await findAcuitySlots(BIZ, baseArgs);
    expect(listAcuityAvailableTimesMock).toHaveBeenCalledTimes(1);
    expect(listAcuityAvailableDatesMock).not.toHaveBeenCalled();
    expect((res.data as { slots: unknown[] }).slots).toEqual([
      { startIso: "2026-08-04T14:00:00.000Z", endIso: "2026-08-04T14:30:00.000Z" }
    ]);
  });

  it("stops as soon as it has three slots", async () => {
    // A multi-day window runs the month prefilter first; give it two open
    // days so the early exit, not an empty candidate list, is what stops us.
    listAcuityAvailableDatesMock.mockResolvedValue(["2026-08-04", "2026-08-05"]);
    listAcuityAvailableTimesMock.mockResolvedValue([
      "2026-08-04T14:00:00.000Z",
      "2026-08-04T15:00:00.000Z",
      "2026-08-04T16:00:00.000Z",
      "2026-08-04T17:00:00.000Z"
    ]);
    const res = await findAcuitySlots(BIZ, {
      ...baseArgs,
      windowEnd: new Date("2026-08-10T22:00:00Z")
    });
    expect((res.data as { slots: unknown[] }).slots).toHaveLength(3);
    // The first day satisfied the request, so no further days were probed.
    expect(listAcuityAvailableTimesMock).toHaveBeenCalledTimes(1);
  });

  it("prefilters by month on a multi-day window so closed days cost nothing", async () => {
    listAcuityAvailableDatesMock.mockResolvedValue(["2026-08-07"]);
    listAcuityAvailableTimesMock.mockResolvedValue(["2026-08-07T14:00:00.000Z"]);
    await findAcuitySlots(BIZ, {
      ...baseArgs,
      windowEnd: new Date("2026-08-09T22:00:00Z")
    });
    expect(listAcuityAvailableDatesMock).toHaveBeenCalledTimes(1);
    // Only the one open day was probed, not every day in the window.
    expect(listAcuityAvailableTimesMock).toHaveBeenCalledTimes(1);
    expect(listAcuityAvailableTimesMock.mock.calls[0][1]).toMatchObject({ date: "2026-08-07" });
  });

  it("drops times outside the window the model asked about", async () => {
    listAcuityAvailableTimesMock.mockResolvedValue([
      "2026-08-04T11:00:00.000Z", // before windowStart
      "2026-08-04T14:00:00.000Z", // inside
      "2026-08-04T23:00:00.000Z" // after windowEnd
    ]);
    const res = await findAcuitySlots(BIZ, baseArgs);
    expect((res.data as { slots: Array<{ startIso: string }> }).slots.map((s) => s.startIso)).toEqual(
      ["2026-08-04T14:00:00.000Z"]
    );
  });

  it("clamps the window start to now so past slots are never offered", async () => {
    listAcuityAvailableTimesMock.mockResolvedValue(["2026-08-04T11:00:00.000Z"]);
    const res = await findAcuitySlots(BIZ, {
      ...baseArgs,
      windowStart: new Date("2026-08-04T00:00:00Z")
    });
    expect((res.data as { slots: unknown[] }).slots).toEqual([]);
  });

  it("reports no_types when the merchant has nothing bookable", async () => {
    listAcuityAppointmentTypesMock.mockResolvedValue([]);
    await expect(findAcuitySlots(BIZ, baseArgs)).resolves.toEqual({
      ok: false,
      detail: "acuity_no_types"
    });
  });

  it("surfaces a rejected credential as acuity_auth_failed", async () => {
    listAcuityAvailableTimesMock.mockRejectedValue(
      new AcuityApiError("auth_failed", "nope", 401)
    );
    await expect(findAcuitySlots(BIZ, baseArgs)).resolves.toEqual({
      ok: false,
      detail: "acuity_auth_failed"
    });
  });

  it("rethrows transport failures for handlers.ts to map", async () => {
    listAcuityAvailableTimesMock.mockRejectedValue(
      new AcuityApiError("upstream_timeout", "slow")
    );
    await expect(findAcuitySlots(BIZ, baseArgs)).rejects.toMatchObject({
      code: "upstream_timeout"
    });
  });

  it("falls back to the requested duration when the type declares none", async () => {
    listAcuityAppointmentTypesMock.mockResolvedValue([
      { ...SERVICE, durationMinutes: null }
    ]);
    listAcuityAvailableTimesMock.mockResolvedValue(["2026-08-04T14:00:00.000Z"]);
    const res = await findAcuitySlots(BIZ, { ...baseArgs, durationMinutes: 45 });
    expect((res.data as { slots: Array<{ endIso: string }> }).slots[0].endIso).toBe(
      "2026-08-04T14:45:00.000Z"
    );
  });

  it("never exceeds the documented worst-case request count", async () => {
    // 1 catalog read + at most 2 month prefilters + at most 7 day reads. This
    // ceiling is the guarantee that keeps one tool call from eating the
    // fleet-wide per-IP budget.
    const days = Array.from({ length: 40 }, (_, i) => {
      const d = new Date(Date.UTC(2026, 7, 4 + i));
      return d.toISOString().slice(0, 10);
    });
    listAcuityAvailableDatesMock.mockResolvedValue(days);
    listAcuityAvailableTimesMock.mockResolvedValue([]);
    await findAcuitySlots(BIZ, {
      ...baseArgs,
      windowEnd: new Date("2026-09-10T22:00:00Z")
    });
    const total =
      1 + listAcuityAvailableDatesMock.mock.calls.length + listAcuityAvailableTimesMock.mock.calls.length;
    expect(total).toBeLessThanOrEqual(ACUITY_MAX_AVAILABILITY_CALLS);
    expect(listAcuityAvailableTimesMock.mock.calls.length).toBeLessThanOrEqual(
      ACUITY_MAX_AVAILABILITY_DAYS
    );
  });

  it("forwards ignoreAppointmentId for reschedule-time availability", async () => {
    await findAcuitySlots(BIZ, { ...baseArgs, ignoreAppointmentId: "55" });
    expect(listAcuityAvailableTimesMock.mock.calls[0][1]).toMatchObject({
      ignoreAppointmentId: "55"
    });
  });
});

describe("bookAcuityAppointment", () => {
  const bookArgs = {
    startIso: "2026-08-04T17:00:00.000Z",
    endIso: "2026-08-04T17:30:00.000Z",
    summary: "Consult",
    attendeeName: "Sam Rivera",
    timezone: "America/New_York"
  };

  beforeEach(() => {
    createAcuityAppointmentMock.mockResolvedValue({ id: "500" });
  });

  it("books in admin mode only when a calendar can be pinned", async () => {
    getActiveAcuityConnectionMock.mockResolvedValue(conn({ default_calendar_id: "7" }));
    await bookAcuityAppointment(BIZ, bookArgs);
    expect(createAcuityAppointmentMock.mock.calls[0][1]).toMatchObject({
      admin: true,
      calendarId: "7"
    });
  });

  it("falls back to client mode without a calendar, letting Acuity validate", async () => {
    await bookAcuityAppointment(BIZ, bookArgs);
    expect(createAcuityAppointmentMock.mock.calls[0][1]).toMatchObject({ admin: false });
  });

  it("sends the instant with an explicit offset, never a naive local string", async () => {
    await bookAcuityAppointment(BIZ, bookArgs);
    expect(createAcuityAppointmentMock.mock.calls[0][1]).toMatchObject({
      datetime: "2026-08-04T13:00:00-04:00"
    });
  });

  it("uses the caller's resolved timezone over the merchant calendar default", async () => {
    await bookAcuityAppointment(BIZ, { ...bookArgs, timezone: "Asia/Kolkata" });
    expect(createAcuityAppointmentMock.mock.calls[0][1]).toMatchObject({
      timezone: "Asia/Kolkata",
      datetime: "2026-08-04T22:30:00+05:30"
    });
  });

  it("uses the surface-provided phone when the model omits one", async () => {
    await bookAcuityAppointment(BIZ, bookArgs, "+15551234567");
    expect(createAcuityAppointmentMock.mock.calls[0][1]).toMatchObject({
      phone: "+15551234567",
      email: "no-reply+15551234567@example.com"
    });
  });

  it("reports no invite when Acuity's own email is suppressed", async () => {
    const res = await bookAcuityAppointment(BIZ, {
      ...bookArgs,
      attendeeEmail: "sam@example.org"
    });
    expect(res.data).toMatchObject({ eventId: "500", inviteEmail: null });
  });

  it("names the invite recipient when the owner left Acuity's email on", async () => {
    getActiveAcuityConnectionMock.mockResolvedValue(conn({ suppress_provider_emails: false }));
    const res = await bookAcuityAppointment(BIZ, {
      ...bookArgs,
      attendeeEmail: "sam@example.org"
    });
    expect(res.data).toMatchObject({ inviteEmail: "sam@example.org" });
  });

  it("refuses without a connection, and reports no_types with nothing bookable", async () => {
    getActiveAcuityConnectionMock.mockResolvedValue(null);
    await expect(bookAcuityAppointment(BIZ, bookArgs)).resolves.toEqual({
      ok: false,
      detail: "calendar_not_connected"
    });
    getActiveAcuityConnectionMock.mockResolvedValue(conn());
    listAcuityAppointmentTypesMock.mockResolvedValue([]);
    await expect(bookAcuityAppointment(BIZ, bookArgs)).resolves.toEqual({
      ok: false,
      detail: "acuity_no_types"
    });
  });

  it("reports a null eventId when Acuity returns no appointment body", async () => {
    createAcuityAppointmentMock.mockResolvedValue(null);
    const res = await bookAcuityAppointment(BIZ, bookArgs);
    expect(res.data).toMatchObject({ eventId: null });
  });

  it("names no invite recipient when email is on but the attendee gave none", async () => {
    getActiveAcuityConnectionMock.mockResolvedValue(conn({ suppress_provider_emails: false }));
    const res = await bookAcuityAppointment(BIZ, bookArgs);
    expect(res.data).toMatchObject({ inviteEmail: null });
  });

  it("falls back to the connection timezone when the caller resolved none", async () => {
    await bookAcuityAppointment(BIZ, { ...bookArgs, timezone: undefined });
    expect(createAcuityAppointmentMock.mock.calls[0][1]).toMatchObject({
      timezone: "America/New_York"
    });
  });

  it("falls back to UTC when neither the caller nor the connection has a zone", async () => {
    getActiveAcuityConnectionMock.mockResolvedValue(conn({ default_calendar_timezone: null }));
    await bookAcuityAppointment(BIZ, { ...bookArgs, timezone: undefined });
    expect(createAcuityAppointmentMock.mock.calls[0][1]).toMatchObject({
      timezone: "UTC",
      datetime: "2026-08-04T17:00:00+00:00"
    });
  });

  it("rethrows a non-Acuity error untouched", async () => {
    createAcuityAppointmentMock.mockRejectedValue(new Error("boom"));
    await expect(bookAcuityAppointment(BIZ, bookArgs)).rejects.toThrow("boom");
  });

  it("maps a taken slot to acuity_slot_taken with model-facing steering", async () => {
    createAcuityAppointmentMock.mockRejectedValue(
      new AcuityApiError("slot_unavailable", "gone", 400, "not_available")
    );
    const res = await bookAcuityAppointment(BIZ, bookArgs);
    expect(res).toMatchObject({ ok: false, detail: "acuity_slot_taken" });
    expect(String(res.message)).toContain("calendar_find_slots");
  });
});

describe("rescheduleAcuityAppointment", () => {
  const EXISTING = {
    id: "500",
    startIso: "2026-08-04T17:00:00.000Z",
    endIso: "2026-08-04T17:30:00.000Z",
    createdIso: null,
    canceled: false,
    appointmentTypeId: "1",
    appointmentTypeName: "Consult",
    calendarId: "7",
    calendarName: "Ana",
    durationMinutes: 30,
    customerName: "Sam",
    customerEmail: null,
    customerPhone: null,
    notes: null,
    timezone: "America/New_York"
  };

  it("reports booking_not_found for a missing or already-canceled appointment", async () => {
    getAcuityAppointmentMock.mockResolvedValueOnce(null);
    await expect(
      rescheduleAcuityAppointment(BIZ, "500", "2026-08-05T17:00:00Z", "2026-08-05T17:30:00Z")
    ).resolves.toEqual({ ok: false, detail: "booking_not_found" });

    getAcuityAppointmentMock.mockResolvedValueOnce({ ...EXISTING, canceled: true });
    await expect(
      rescheduleAcuityAppointment(BIZ, "500", "2026-08-05T17:00:00Z", "2026-08-05T17:30:00Z")
    ).resolves.toEqual({ ok: false, detail: "booking_not_found" });
    expect(rescheduleAcuityAppointmentTimeMock).not.toHaveBeenCalled();
  });

  it("checks availability while IGNORING the appointment's own slot", async () => {
    getAcuityAppointmentMock.mockResolvedValue(EXISTING);
    listAcuityAvailableTimesMock.mockResolvedValue(["2026-08-04T17:30:00.000Z"]);
    await rescheduleAcuityAppointment(
      BIZ,
      "500",
      "2026-08-04T17:30:00Z",
      "2026-08-04T18:00:00Z"
    );
    // Without the ignore, moving a 30-minute booking by 30 minutes would read
    // as unavailable against itself.
    expect(listAcuityAvailableTimesMock.mock.calls[0][1]).toMatchObject({
      ignoreAppointmentId: "500"
    });
    expect(rescheduleAcuityAppointmentTimeMock).toHaveBeenCalled();
  });

  it("refuses a target the ignore-aware read does not offer, issuing no write", async () => {
    getAcuityAppointmentMock.mockResolvedValue(EXISTING);
    listAcuityAvailableTimesMock.mockResolvedValue(["2026-08-05T19:00:00.000Z"]);
    const res = await rescheduleAcuityAppointment(
      BIZ,
      "500",
      "2026-08-05T17:00:00Z",
      "2026-08-05T17:30:00Z"
    );
    expect(res).toMatchObject({ ok: false, detail: "acuity_slot_taken" });
    expect(rescheduleAcuityAppointmentTimeMock).not.toHaveBeenCalled();
  });

  it("refuses without a connection", async () => {
    getActiveAcuityConnectionMock.mockResolvedValue(null);
    await expect(
      rescheduleAcuityAppointment(BIZ, "500", "2026-08-05T17:00:00Z", "2026-08-05T17:30:00Z")
    ).resolves.toEqual({ ok: false, detail: "calendar_not_connected" });
  });

  it("surfaces a rejected credential as acuity_auth_failed", async () => {
    getAcuityAppointmentMock.mockRejectedValue(new AcuityApiError("auth_failed", "no", 401));
    await expect(
      rescheduleAcuityAppointment(BIZ, "500", "2026-08-05T17:00:00Z", "2026-08-05T17:30:00Z")
    ).resolves.toEqual({ ok: false, detail: "acuity_auth_failed" });
  });

  it("maps an Acuity refusal to acuity_slot_taken", async () => {
    getAcuityAppointmentMock.mockResolvedValue(EXISTING);
    listAcuityAvailableTimesMock.mockResolvedValue(["2026-08-05T17:00:00.000Z"]);
    rescheduleAcuityAppointmentTimeMock.mockRejectedValue(
      new AcuityApiError("slot_unavailable", "too close", 400, "reschedule_too_close")
    );
    const res = await rescheduleAcuityAppointment(
      BIZ,
      "500",
      "2026-08-05T17:00:00Z",
      "2026-08-05T17:30:00Z"
    );
    expect(res).toMatchObject({ ok: false, detail: "acuity_slot_taken" });
  });

  it("falls back to UTC when neither the appointment nor the connection has a zone", async () => {
    getActiveAcuityConnectionMock.mockResolvedValue(conn({ default_calendar_timezone: null }));
    getAcuityAppointmentMock.mockResolvedValue({ ...EXISTING, timezone: null });
    listAcuityAvailableTimesMock.mockResolvedValue(["2026-08-05T17:00:00.000Z"]);
    await rescheduleAcuityAppointment(
      BIZ,
      "500",
      "2026-08-05T17:00:00Z",
      "2026-08-05T17:30:00Z"
    );
    expect(rescheduleAcuityAppointmentTimeMock.mock.calls[0][2]).toMatchObject({
      timezone: "UTC"
    });
  });

  it("falls back to the connection timezone when the appointment carries none", async () => {
    getAcuityAppointmentMock.mockResolvedValue({ ...EXISTING, timezone: null });
    listAcuityAvailableTimesMock.mockResolvedValue(["2026-08-05T17:00:00.000Z"]);
    await rescheduleAcuityAppointment(
      BIZ,
      "500",
      "2026-08-05T17:00:00Z",
      "2026-08-05T17:30:00Z"
    );
    expect(rescheduleAcuityAppointmentTimeMock.mock.calls[0][2]).toMatchObject({
      timezone: "America/New_York"
    });
  });

  it("refuses to report success when Acuity returns no moved appointment", async () => {
    // A 2xx with no parseable body is anomalous for this endpoint. Claiming
    // success would let the caller shift the ledger claim to a time Acuity
    // may never have written, which is the same confirmed-event rule the
    // booking paths already apply.
    getAcuityAppointmentMock.mockResolvedValue(EXISTING);
    listAcuityAvailableTimesMock.mockResolvedValue(["2026-08-05T17:00:00.000Z"]);
    rescheduleAcuityAppointmentTimeMock.mockResolvedValue(null);
    await expect(
      rescheduleAcuityAppointment(BIZ, "500", "2026-08-05T17:00:00Z", "2026-08-05T17:30:00Z")
    ).resolves.toEqual({ ok: false, detail: "calendar_reschedule_failed" });
  });

  it("drops to CLIENT mode when the payload has no appointment type", async () => {
    // Admin mode waives Acuity's own validation. With no type id we cannot
    // run the ignore-aware precheck either, and an unverifiable move plus a
    // waived validation is how a double-booking gets written.
    getAcuityAppointmentMock.mockResolvedValue({ ...EXISTING, appointmentTypeId: null });
    await rescheduleAcuityAppointment(
      BIZ,
      "500",
      "2026-08-05T17:00:00Z",
      "2026-08-05T17:30:00Z"
    );
    expect(listAcuityAvailableTimesMock).not.toHaveBeenCalled();
    expect(rescheduleAcuityAppointmentTimeMock.mock.calls[0][2]).toMatchObject({ admin: false });
  });
});

describe("cancelAcuityAppointment", () => {
  const EXISTING = {
    id: "500",
    startIso: "2026-08-04T17:00:00.000Z",
    endIso: null,
    createdIso: null,
    canceled: false,
    appointmentTypeId: "1",
    appointmentTypeName: "Consult",
    calendarId: "7",
    calendarName: null,
    durationMinutes: 30,
    customerName: null,
    customerEmail: null,
    customerPhone: null,
    notes: null,
    timezone: "America/New_York"
  };

  it("treats an already-canceled appointment as success, not failure", async () => {
    // A webhook retry or a double tool call must not surface a scary error.
    getAcuityAppointmentMock.mockResolvedValue({ ...EXISTING, canceled: true });
    const res = await cancelAcuityAppointment(BIZ, "500", EXISTING.startIso);
    expect(res).toMatchObject({ ok: true });
    expect(res.data).toMatchObject({ alreadyCanceled: true });
    expect(cancelAcuityAppointmentByIdMock).not.toHaveBeenCalled();
  });

  it("REFUSES when the ledger start disagrees, cancelling nothing", async () => {
    // Acuity cancellation is irreversible, so a drifted ledger row must never
    // be acted on. This is the assertion that makes that safe.
    getAcuityAppointmentMock.mockResolvedValue(EXISTING);
    const res = await cancelAcuityAppointment(BIZ, "500", "2026-08-09T17:00:00.000Z");
    expect(res).toEqual({ ok: false, detail: "booking_not_found" });
    expect(cancelAcuityAppointmentByIdMock).not.toHaveBeenCalled();
  });

  it("cancels when the ledger start matches", async () => {
    getAcuityAppointmentMock.mockResolvedValue(EXISTING);
    const res = await cancelAcuityAppointment(BIZ, "500", EXISTING.startIso);
    expect(res).toMatchObject({ ok: true });
    expect(cancelAcuityAppointmentByIdMock).toHaveBeenCalledWith(expect.anything(), "500", {
      noEmail: true
    });
  });

  it("cancels without a ledger start when the caller has none", async () => {
    getAcuityAppointmentMock.mockResolvedValue(EXISTING);
    await expect(cancelAcuityAppointment(BIZ, "500")).resolves.toMatchObject({ ok: true });
    expect(cancelAcuityAppointmentByIdMock).toHaveBeenCalled();
  });

  it("reports booking_not_found for an appointment Acuity no longer has", async () => {
    getAcuityAppointmentMock.mockResolvedValue(null);
    await expect(cancelAcuityAppointment(BIZ, "500")).resolves.toEqual({
      ok: false,
      detail: "booking_not_found"
    });
  });

  it("refuses without a connection", async () => {
    getActiveAcuityConnectionMock.mockResolvedValue(null);
    await expect(cancelAcuityAppointment(BIZ, "500")).resolves.toEqual({
      ok: false,
      detail: "calendar_not_connected"
    });
  });

  it("surfaces a rejected credential as acuity_auth_failed", async () => {
    getAcuityAppointmentMock.mockRejectedValue(new AcuityApiError("auth_failed", "no", 401));
    await expect(cancelAcuityAppointment(BIZ, "500")).resolves.toEqual({
      ok: false,
      detail: "acuity_auth_failed"
    });
  });

  it("rethrows transport failures for handlers.ts to map", async () => {
    getAcuityAppointmentMock.mockRejectedValue(
      new AcuityApiError("upstream_unreachable", "down")
    );
    await expect(cancelAcuityAppointment(BIZ, "500")).rejects.toMatchObject({
      code: "upstream_unreachable"
    });
  });
});

describe("listAcuityUpcomingForAttendee", () => {
  it("reports not_connected without a connection", async () => {
    getActiveAcuityConnectionMock.mockResolvedValue(null);
    await expect(
      listAcuityUpcomingForAttendee(BIZ, { phones: [], email: "sam@example.org" })
    ).resolves.toEqual({ ok: false, reason: "not_connected" });
  });

  it("narrows by email when known, and drops past or canceled rows", async () => {
    listAcuityAppointmentsMock.mockResolvedValue([
      { id: "1", startIso: "2026-08-03T17:00:00.000Z", canceled: false, appointmentTypeName: "A" },
      { id: "2", startIso: "2026-08-06T17:00:00.000Z", canceled: true, appointmentTypeName: "B" },
      { id: "3", startIso: "2026-08-05T17:00:00.000Z", canceled: false, appointmentTypeName: "C" }
    ]);
    const res = await listAcuityUpcomingForAttendee(BIZ, {
      phones: ["+15551234567"],
      email: "sam@example.org"
    });
    expect(listAcuityAppointmentsMock.mock.calls[0][1]).toMatchObject({
      email: "sam@example.org"
    });
    expect(listAcuityAppointmentsMock.mock.calls[0][1].phone).toBeUndefined();
    expect(res).toMatchObject({
      ok: true,
      bookings: [{ eventId: "3", startIso: "2026-08-05T17:00:00.000Z", name: "C" }]
    });
  });

  it("falls back to the phone filter when there is no email", async () => {
    listAcuityAppointmentsMock.mockResolvedValue([]);
    await listAcuityUpcomingForAttendee(BIZ, { phones: ["+15551234567"], email: null });
    expect(listAcuityAppointmentsMock.mock.calls[0][1]).toMatchObject({
      phone: "+15551234567"
    });
  });

  it("returns multiple upcoming bookings soonest first", async () => {
    listAcuityAppointmentsMock.mockResolvedValue([
      { id: "late", startIso: "2026-08-09T17:00:00.000Z", canceled: false, appointmentTypeName: "B" },
      { id: "soon", startIso: "2026-08-05T17:00:00.000Z", canceled: false, appointmentTypeName: "A" }
    ]);
    const res = await listAcuityUpcomingForAttendee(BIZ, {
      phones: [],
      email: "sam@example.org"
    });
    expect((res as { bookings: Array<{ eventId: string }> }).bookings.map((b) => b.eventId)).toEqual(
      ["soon", "late"]
    );
  });

  it("returns EMPTY without listing at all when the attendee has no identifiers", async () => {
    // With no email and no phone there is no server-side filter, so the
    // listing would be the merchant's entire upcoming book. Feeding that to
    // the duplicate guard would refuse a real booking with
    // attendee_already_booked just because the business is busy.
    listAcuityAppointmentsMock.mockResolvedValue([
      { id: "someone-else", startIso: "2026-08-05T17:00:00.000Z", canceled: false }
    ]);
    await expect(
      listAcuityUpcomingForAttendee(BIZ, { phones: [], email: null })
    ).resolves.toEqual({ ok: true, bookings: [] });
    expect(listAcuityAppointmentsMock).not.toHaveBeenCalled();
  });

  it("reports a null eventId when the listing omits an id", async () => {
    listAcuityAppointmentsMock.mockResolvedValue([
      { id: "", startIso: "2026-08-05T17:00:00.000Z", canceled: false, appointmentTypeName: null }
    ]);
    await expect(
      listAcuityUpcomingForAttendee(BIZ, { phones: [], email: "sam@example.org" })
    ).resolves.toMatchObject({ ok: true, bookings: [{ eventId: null, name: null }] });
  });

  it("honors injected transports so callers can test without a network", async () => {
    const getConnection = vi.fn().mockResolvedValue(conn());
    const listAppointments = vi.fn().mockResolvedValue([]);
    await listAcuityUpcomingForAttendee(
      BIZ,
      { phones: [], email: "sam@example.org" },
      { getConnection: getConnection as never, listAppointments: listAppointments as never }
    );
    expect(getConnection).toHaveBeenCalledWith(BIZ);
    expect(listAppointments).toHaveBeenCalled();
    expect(listAcuityAppointmentsMock).not.toHaveBeenCalled();
  });

  it("falls back to UTC dates when the connection has no calendar timezone", async () => {
    getActiveAcuityConnectionMock.mockResolvedValue(conn({ default_calendar_timezone: null }));
    listAcuityAppointmentsMock.mockResolvedValue([]);
    await listAcuityUpcomingForAttendee(BIZ, { phones: [], email: "sam@example.org" });
    expect(listAcuityAppointmentsMock.mock.calls[0][1]).toMatchObject({
      minDate: "2026-08-04"
    });
  });
});
