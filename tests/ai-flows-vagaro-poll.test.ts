/**
 * Tests for the Vagaro calendar-trigger fetcher (src/lib/ai-flows/vagaro-poll.ts):
 * appointment → CalendarEventInput normalization and the windowed
 * list/dedupe/due-filter/failure-isolation behavior of
 * fetchVagaroCandidateEvents.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));
vi.mock("@/lib/db/vagaro-connections", () => ({ getActiveVagaroConnection: vi.fn() }));
vi.mock("@/lib/vagaro/client", () => ({ listVagaroAppointments: vi.fn() }));

import {
  fetchVagaroCandidateEvents,
  vagaroAppointmentToCalendarEvent,
  VAGARO_CANCELED_LIST_STATUS,
  VAGARO_CANCELED_SCAN_BACK_DAYS,
  VAGARO_CANCELED_SCAN_FORWARD_DAYS,
  VAGARO_CREATED_SCAN_BACK_DAYS,
  VAGARO_CREATED_SCAN_DAYS,
  VAGARO_END_MAX_EVENT_MINUTES,
  VAGARO_POLL_MAX_EVENTS
} from "@/lib/ai-flows/vagaro-poll";
import type { VagaroAppointmentItem } from "@/lib/vagaro/client";
import { logger } from "@/lib/logger";

const BIZ = "11111111-1111-4111-8111-111111111111";
const NOW = Date.parse("2026-07-21T12:00:00.000Z");

const CONN = { id: "vg-1", business_id: BIZ } as never;

function appt(overrides: Partial<VagaroAppointmentItem> = {}): VagaroAppointmentItem {
  return {
    id: "appt-1",
    startIso: "2026-07-21T15:00:00.000Z",
    endIso: "2026-07-21T15:30:00.000Z",
    createdIso: "2026-07-21T11:55:00.000Z",
    updatedIso: null,
    status: "confirmed",
    cancelled: false,
    serviceId: "svc-1",
    serviceName: "Gel Manicure",
    customerName: "Dana Doe",
    customerPhone: "+16025550000",
    customerEmail: "dana@example.com",
    ...overrides
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("vagaroAppointmentToCalendarEvent", () => {
  it("maps the full shape: title, customer context lines, attendee, timestamps", () => {
    expect(vagaroAppointmentToCalendarEvent(appt())).toEqual({
      id: "appt-1",
      title: "Gel Manicure",
      description:
        "customer name: Dana Doe\n" +
        "customer phone: +16025550000\n" +
        "customer email: dana@example.com\n" +
        "service: Gel Manicure",
      attendees: ["Dana Doe <dana@example.com>"],
      startIso: "2026-07-21T15:00:00.000Z",
      endIso: "2026-07-21T15:30:00.000Z",
      createdIso: "2026-07-21T11:55:00.000Z",
      cancelled: false,
      calendar: "primary"
    });
  });

  it("degrades attendee/description honestly for partial customer identity", () => {
    // Name without email.
    expect(
      vagaroAppointmentToCalendarEvent(
        appt({ customerEmail: null, customerPhone: null, serviceName: null, endIso: null })
      )
    ).toEqual({
      id: "appt-1",
      title: "Appointment",
      description: "customer name: Dana Doe",
      attendees: ["Dana Doe"],
      startIso: "2026-07-21T15:00:00.000Z",
      createdIso: "2026-07-21T11:55:00.000Z",
      cancelled: false,
      calendar: "primary"
    });
    // Email without name.
    expect(
      vagaroAppointmentToCalendarEvent(appt({ customerName: null }))
    ).toMatchObject({ attendees: ["dana@example.com"] });
    // No identity at all: no attendees key, no customer lines.
    const bare = vagaroAppointmentToCalendarEvent(
      appt({
        customerName: null,
        customerEmail: null,
        customerPhone: null,
        serviceName: null,
        createdIso: null
      })
    );
    expect(bare.attendees).toBeUndefined();
    expect(bare.description).toBeUndefined();
    expect(bare.createdIso).toBeUndefined();
  });

  it("carries the cancelled flag and updatedIso for canceled-mode gating", () => {
    const ev = vagaroAppointmentToCalendarEvent(
      appt({ cancelled: true, status: "cancelled", updatedIso: "2026-07-21T11:59:00.000Z" })
    );
    expect(ev.cancelled).toBe(true);
    expect(ev.updatedIso).toBe("2026-07-21T11:59:00.000Z");
  });
});

describe("fetchVagaroCandidateEvents", () => {
  const iso = (ms: number) => new Date(ms).toISOString();
  const dayMs = 24 * 60 * 60_000;
  const minuteMs = 60_000;

  function deps(overrides: Record<string, unknown> = {}) {
    return {
      getConnection: vi.fn().mockResolvedValue(CONN),
      list: vi.fn().mockResolvedValue([]),
      ...overrides
    };
  }

  it("throws calendar_not_connected when the connection row is gone", async () => {
    await expect(
      fetchVagaroCandidateEvents(
        {
          businessId: BIZ,
          nowMs: NOW,
          windows: {
            createdScan: true,
            startHorizonMinutes: null,
            endBackMinutes: null,
            canceledScan: false
          },
          dueFilter: () => true
        },
        deps({ getConnection: vi.fn().mockResolvedValue(null) })
      )
    ).rejects.toThrow("calendar_not_connected");
  });

  it("uses the module-level lookups when no deps are injected", async () => {
    // The mocked module's getActiveVagaroConnection answers undefined,
    // which reads as "no connection row".
    await expect(
      fetchVagaroCandidateEvents({
        businessId: BIZ,
        nowMs: NOW,
        windows: {
          createdScan: false,
          startHorizonMinutes: null,
          endBackMinutes: null,
          canceledScan: false
        },
        dueFilter: () => true
      })
    ).rejects.toThrow("calendar_not_connected");
  });

  it("lists nothing when no window is requested", async () => {
    const d = deps();
    const res = await fetchVagaroCandidateEvents(
      {
        businessId: BIZ,
        nowMs: NOW,
        windows: {
          createdScan: false,
          startHorizonMinutes: null,
          endBackMinutes: null,
          canceledScan: false
        },
        dueFilter: () => true
      },
      d
    );
    expect(d.list).not.toHaveBeenCalled();
    expect(res).toEqual({ events: [], overflowed: false });
  });

  it("lists each requested window with the right bounds and dedupes across them", async () => {
    const d = deps({
      list: vi.fn().mockResolvedValue([appt(), appt({ id: "appt-2" })])
    });
    const res = await fetchVagaroCandidateEvents(
      {
        businessId: BIZ,
        nowMs: NOW,
        windows: {
          createdScan: true,
          startHorizonMinutes: 125,
          endBackMinutes: 45,
          canceledScan: true
        },
        dueFilter: () => true
      },
      d
    );
    // Four windows listed, but each appointment id appears once.
    expect(d.list).toHaveBeenCalledTimes(4);
    expect(res.events.map((e) => e.id)).toEqual(["appt-1", "appt-2"]);
    expect(res.overflowed).toBe(false);

    const [created, start, end, canceled] = d.list.mock.calls.map((c) => c[1]);
    expect(created).toEqual({
      startIso: iso(NOW - VAGARO_CREATED_SCAN_BACK_DAYS * dayMs),
      endIso: iso(NOW + VAGARO_CREATED_SCAN_DAYS * dayMs)
    });
    expect(start).toEqual({ startIso: iso(NOW), endIso: iso(NOW + 125 * minuteMs) });
    expect(end).toEqual({
      startIso: iso(NOW - (45 + VAGARO_END_MAX_EVENT_MINUTES) * minuteMs),
      endIso: iso(NOW)
    });
    expect(canceled).toEqual({
      startIso: iso(NOW - VAGARO_CANCELED_SCAN_BACK_DAYS * dayMs),
      endIso: iso(NOW + VAGARO_CANCELED_SCAN_FORWARD_DAYS * dayMs),
      status: VAGARO_CANCELED_LIST_STATUS
    });
  });

  it("applies the due filter and flags a full page as overflow", async () => {
    const fullPage = Array.from({ length: VAGARO_POLL_MAX_EVENTS }, (_, i) =>
      appt({ id: `appt-${i}` })
    );
    const d = deps({ list: vi.fn().mockResolvedValue(fullPage) });
    const res = await fetchVagaroCandidateEvents(
      {
        businessId: BIZ,
        nowMs: NOW,
        windows: {
          createdScan: true,
          startHorizonMinutes: null,
          endBackMinutes: null,
          canceledScan: false
        },
        dueFilter: (ev) => ev.id === "appt-7"
      },
      d
    );
    expect(res.overflowed).toBe(true);
    expect(res.events.map((e) => e.id)).toEqual(["appt-7"]);
  });

  it("isolates one window's failure and keeps the others' events", async () => {
    const d = deps({
      list: vi
        .fn()
        .mockRejectedValueOnce(new Error("created window down"))
        .mockResolvedValueOnce([appt()])
    });
    const res = await fetchVagaroCandidateEvents(
      {
        businessId: BIZ,
        nowMs: NOW,
        windows: {
          createdScan: true,
          startHorizonMinutes: 60,
          endBackMinutes: null,
          canceledScan: false
        },
        dueFilter: () => true
      },
      d
    );
    expect(res.events).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalledWith(
      "vagaro poll: window listing failed",
      expect.objectContaining({ businessId: BIZ, window: "created", error: "created window down" })
    );
  });

  it("propagates the failure when every window failed and nothing was collected", async () => {
    const d = deps({ list: vi.fn().mockRejectedValue(new Error("all down")) });
    await expect(
      fetchVagaroCandidateEvents(
        {
          businessId: BIZ,
          nowMs: NOW,
          windows: {
            createdScan: true,
            startHorizonMinutes: null,
            endBackMinutes: null,
            canceledScan: false
          },
          dueFilter: () => true
        },
        d
      )
    ).rejects.toThrow("all down");
    // Non-Error window failures are stringified on the way out.
    const d2 = deps({ list: vi.fn().mockRejectedValue("string sad") });
    await expect(
      fetchVagaroCandidateEvents(
        {
          businessId: BIZ,
          nowMs: NOW,
          windows: {
            createdScan: true,
            startHorizonMinutes: null,
            endBackMinutes: null,
            canceledScan: false
          },
          dueFilter: () => true
        },
        d2
      )
    ).rejects.toThrow("string sad");
  });
});
