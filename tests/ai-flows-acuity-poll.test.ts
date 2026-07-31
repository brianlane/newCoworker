/**
 * Tests for the Acuity candidate-event fetcher
 * (src/lib/ai-flows/acuity-poll.ts).
 *
 * Two things here are Acuity-specific and worth pinning hard: the listing is
 * DATE-granular (so every window boundary converts to a local date in the
 * connection's timezone), and the four windows must run sequentially, because
 * Acuity's rate limit is per egress IP and shared across the whole fleet.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

// Module-level mocks so the fetcher's OWN default wiring can be exercised,
// not just the injected seams the other tests use.
const getActiveAcuityConnectionMock = vi.fn();
const listAcuityAppointmentsMock = vi.fn();
const recordAcuityObservationsMock = vi.fn();
vi.mock("@/lib/db/acuity-connections", () => ({
  getActiveAcuityConnection: (...a: unknown[]) => getActiveAcuityConnectionMock(...a)
}));
vi.mock("@/lib/db/acuity-appointment-state", () => ({
  recordAcuityObservations: (...a: unknown[]) => recordAcuityObservationsMock(...a)
}));
vi.mock("@/lib/acuity/client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/acuity/client")>(
    "@/lib/acuity/client"
  );
  return {
    acuityLocalDate: actual.acuityLocalDate,
    listAcuityAppointments: (...a: unknown[]) => listAcuityAppointmentsMock(...a)
  };
});

import {
  ACUITY_CANCELED_SCAN_BACK_DAYS,
  ACUITY_CREATED_SCAN_BACK_DAYS,
  ACUITY_CREATED_SCAN_DAYS,
  ACUITY_POLL_MAX_EVENTS,
  acuityAppointmentToCalendarEvent,
  fetchAcuityCandidateEvents
} from "@/lib/ai-flows/acuity-poll";

const BIZ = "biz-1";
const NOW = Date.parse("2026-08-04T12:00:00.000Z");

function conn(overrides: Record<string, unknown> = {}) {
  return {
    id: "ac-1",
    business_id: BIZ,
    user_id: "1",
    apiKey: "k",
    api_base_url: "https://acuityscheduling.com",
    webhook_verification_token: "t",
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

function appt(overrides: Record<string, unknown> = {}) {
  return {
    id: "500",
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
    customerEmail: "sam@example.org",
    customerPhone: "+15551234567",
    notes: null,
    timezone: "America/New_York",
    ...overrides
  };
}

const ALL_WINDOWS = {
  createdScan: true,
  startHorizonMinutes: 120,
  endBackMinutes: 60,
  canceledScan: true
};

function deps(over: Record<string, unknown> = {}) {
  return {
    getConnection: vi.fn().mockResolvedValue(conn()),
    list: vi.fn().mockResolvedValue([]),
    recordObservations: vi.fn().mockResolvedValue([]),
    ...over
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("acuityAppointmentToCalendarEvent", () => {
  it("puts the customer identity in the description for conditions to read", () => {
    const ev = acuityAppointmentToCalendarEvent(appt() as never, "2026-08-03T00:00:00.000Z");
    expect(ev).toMatchObject({
      id: "500",
      title: "Consult",
      startIso: "2026-08-04T17:00:00.000Z",
      endIso: "2026-08-04T17:30:00.000Z",
      createdIso: "2026-08-01T13:00:00.000Z",
      updatedIso: "2026-08-03T00:00:00.000Z",
      cancelled: false,
      calendar: "primary",
      attendees: ["Sam Rivera <sam@example.org>"]
    });
    expect(ev.description).toContain("customer phone: +15551234567");
    expect(ev.description).toContain("staff: Ana");
  });

  it("omits updatedIso entirely when the shadow has no moment for it", () => {
    // A brand new appointment has no modification moment; event_created gates
    // on dateCreated instead.
    const ev = acuityAppointmentToCalendarEvent(appt() as never, null);
    expect("updatedIso" in ev).toBe(false);
  });

  it("falls back to a bare name, or the email, or a default title", () => {
    expect(
      acuityAppointmentToCalendarEvent(appt({ customerEmail: null }) as never).attendees
    ).toEqual(["Sam Rivera"]);
    expect(
      acuityAppointmentToCalendarEvent(appt({ customerName: null }) as never).attendees
    ).toEqual(["sam@example.org"]);
    const bare = acuityAppointmentToCalendarEvent(
      appt({ customerName: null, customerEmail: null, appointmentTypeName: null, calendarName: null, customerPhone: null }) as never
    );
    expect(bare.title).toBe("Appointment");
    expect(bare.attendees).toBeUndefined();
    expect(bare.description).toBeUndefined();
  });
});

describe("fetchAcuityCandidateEvents", () => {
  it("throws calendar_not_connected when the row vanished mid-poll", async () => {
    await expect(
      fetchAcuityCandidateEvents(
        { businessId: BIZ, nowMs: NOW, windows: ALL_WINDOWS, dueFilter: () => true },
        deps({ getConnection: vi.fn().mockResolvedValue(null) })
      )
    ).rejects.toThrow(/calendar_not_connected/);
  });

  it("converts every window boundary to a LOCAL date in the connection timezone", async () => {
    const d = deps();
    await fetchAcuityCandidateEvents(
      { businessId: BIZ, nowMs: NOW, windows: ALL_WINDOWS, dueFilter: () => true },
      d
    );
    const calls = (d as never as { list: { mock: { calls: unknown[][] } } }).list.mock.calls;
    expect(calls).toHaveLength(4);
    // 2026-08-04T12:00Z is 08:00 in New York, so "now" is the 4th locally.
    const created = calls[0][1] as { minDate: string; maxDate: string; max: number };
    expect(created.minDate).toBe("2026-08-03"); // now - 1 day
    expect(created.maxDate).toBe("2026-09-03"); // now + 30 days
    expect(created.max).toBe(ACUITY_POLL_MAX_EVENTS);
    expect(ACUITY_CREATED_SCAN_BACK_DAYS).toBe(1);
    expect(ACUITY_CREATED_SCAN_DAYS).toBe(30);
    // The canceled window is the only one asking for canceled rows.
    const canceled = calls[3][1] as { canceled?: boolean; minDate: string };
    expect(canceled.canceled).toBe(true);
    expect(canceled.minDate).toBe("2026-08-03");
    expect(ACUITY_CANCELED_SCAN_BACK_DAYS).toBe(1);
    for (const c of calls.slice(0, 3)) {
      expect((c[1] as { canceled?: boolean }).canceled).toBeUndefined();
    }
  });

  it("runs the windows SEQUENTIALLY, never fanning out", async () => {
    // Acuity's rate limit is per egress IP and shared fleet-wide, so four
    // concurrent listings per tenant is exactly the burst to avoid.
    let inFlight = 0;
    let maxInFlight = 0;
    const list = vi.fn(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return [];
    });
    await fetchAcuityCandidateEvents(
      { businessId: BIZ, nowMs: NOW, windows: ALL_WINDOWS, dueFilter: () => true },
      deps({ list })
    );
    expect(maxInFlight).toBe(1);
  });

  it("skips a window the flow group does not need", async () => {
    const d = deps();
    await fetchAcuityCandidateEvents(
      {
        businessId: BIZ,
        nowMs: NOW,
        windows: {
          createdScan: false,
          startHorizonMinutes: 120,
          endBackMinutes: null,
          canceledScan: false
        },
        dueFilter: () => true
      },
      d
    );
    expect((d as never as { list: { mock: { calls: unknown[] } } }).list.mock.calls).toHaveLength(1);
  });

  it("lets a CANCELED row replace the standing one an earlier window collected", async () => {
    // The canceled window runs last and is the only listing carrying
    // cancellations. Without the replace, event_canceled never becomes due
    // from the poll and the other modes keep treating it as live.
    const list = vi
      .fn()
      .mockResolvedValueOnce([appt()])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([appt({ canceled: true })]);
    const recordObservations = vi
      .fn()
      .mockResolvedValue([{ appointmentId: "500", kind: "canceled", updatedIso: "X" }]);
    const res = await fetchAcuityCandidateEvents(
      { businessId: BIZ, nowMs: NOW, windows: ALL_WINDOWS, dueFilter: () => true },
      deps({ list, recordObservations })
    );
    expect(res.events).toHaveLength(1);
    expect(res.events[0].cancelled).toBe(true);
    expect(res.events[0].updatedIso).toBe("X");
  });

  it("does NOT let a standing row overwrite a canceled one already collected", async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce([appt({ canceled: true })])
      .mockResolvedValueOnce([appt()])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    const res = await fetchAcuityCandidateEvents(
      { businessId: BIZ, nowMs: NOW, windows: ALL_WINDOWS, dueFilter: () => true },
      deps({ list })
    );
    expect(res.events[0].cancelled).toBe(true);
  });

  it("flags an overflow when a listing comes back full", async () => {
    const full = Array.from({ length: ACUITY_POLL_MAX_EVENTS }, (_, i) =>
      appt({ id: `a${i}` })
    );
    const res = await fetchAcuityCandidateEvents(
      { businessId: BIZ, nowMs: NOW, windows: ALL_WINDOWS, dueFilter: () => true },
      deps({ list: vi.fn().mockResolvedValue(full) })
    );
    expect(res.overflowed).toBe(true);
  });

  it("isolates a failing window: the others' events survive", async () => {
    const list = vi
      .fn()
      .mockRejectedValueOnce(new Error("created window down"))
      .mockResolvedValueOnce([appt()])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    const res = await fetchAcuityCandidateEvents(
      { businessId: BIZ, nowMs: NOW, windows: ALL_WINDOWS, dueFilter: () => true },
      deps({ list })
    );
    expect(res.events).toHaveLength(1);
  });

  it("propagates only a TOTAL failure", async () => {
    await expect(
      fetchAcuityCandidateEvents(
        { businessId: BIZ, nowMs: NOW, windows: ALL_WINDOWS, dueFilter: () => true },
        deps({ list: vi.fn().mockRejectedValue(new Error("acuity down")) })
      )
    ).rejects.toThrow(/acuity down/);
  });

  it("returns empty without consulting the shadow when nothing was listed", async () => {
    const d = deps();
    const res = await fetchAcuityCandidateEvents(
      { businessId: BIZ, nowMs: NOW, windows: ALL_WINDOWS, dueFilter: () => true },
      d
    );
    expect(res).toEqual({ events: [], overflowed: false });
    expect(
      (d as never as { recordObservations: { mock: { calls: unknown[] } } }).recordObservations.mock
        .calls
    ).toHaveLength(0);
  });

  it("omits endIso and createdIso when the appointment carries neither", async () => {
    const ev = acuityAppointmentToCalendarEvent(
      appt({ endIso: null, createdIso: null }) as never,
      null
    );
    expect("endIso" in ev).toBe(false);
    expect("createdIso" in ev).toBe(false);
  });

  it("skips the start window when no start-mode flow needs it", async () => {
    const d = deps();
    await fetchAcuityCandidateEvents(
      {
        businessId: BIZ,
        nowMs: NOW,
        windows: { createdScan: true, startHorizonMinutes: null, endBackMinutes: null, canceledScan: false },
        dueFilter: () => true
      },
      d
    );
    expect((d as never as { list: { mock: { calls: unknown[] } } }).list.mock.calls).toHaveLength(1);
  });

  it("survives a non-Error window rejection", async () => {
    await expect(
      fetchAcuityCandidateEvents(
        { businessId: BIZ, nowMs: NOW, windows: ALL_WINDOWS, dueFilter: () => true },
        deps({ list: vi.fn().mockRejectedValue("string failure") })
      )
    ).rejects.toThrow(/string failure/);
  });

  it("uses its own default transports when no deps are injected", async () => {
    getActiveAcuityConnectionMock.mockResolvedValue(conn());
    listAcuityAppointmentsMock.mockResolvedValue([appt()]);
    recordAcuityObservationsMock.mockResolvedValue([
      { appointmentId: "500", kind: "canceled", updatedIso: "2026-08-04T12:00:00.000Z" }
    ]);
    const res = await fetchAcuityCandidateEvents({
      businessId: BIZ,
      nowMs: NOW,
      windows: { createdScan: true, startHorizonMinutes: null, endBackMinutes: null, canceledScan: false },
      dueFilter: () => true
    });
    expect(getActiveAcuityConnectionMock).toHaveBeenCalledWith(BIZ);
    expect(listAcuityAppointmentsMock).toHaveBeenCalled();
    expect(recordAcuityObservationsMock).toHaveBeenCalled();
    expect(res.events).toHaveLength(1);
  });

  it("applies the caller's due filter", async () => {
    const res = await fetchAcuityCandidateEvents(
      { businessId: BIZ, nowMs: NOW, windows: ALL_WINDOWS, dueFilter: () => false },
      deps({ list: vi.fn().mockResolvedValue([appt()]) })
    );
    expect(res.events).toEqual([]);
  });

  it("falls back to UTC dates when the connection carries no calendar timezone", async () => {
    const d = deps({ getConnection: vi.fn().mockResolvedValue(conn({ default_calendar_timezone: null })) });
    await fetchAcuityCandidateEvents(
      {
        businessId: BIZ,
        nowMs: NOW,
        windows: { createdScan: false, startHorizonMinutes: 60, endBackMinutes: null, canceledScan: false },
        dueFilter: () => true
      },
      d
    );
    const args = (d as never as { list: { mock: { calls: unknown[][] } } }).list.mock.calls[0][1];
    expect((args as { minDate: string }).minDate).toBe("2026-08-04");
  });
});
