/**
 * Direct tests for the shared calendar cores
 * (src/lib/calendar-tools/handlers.ts) used by the voice adapters and the
 * Rowboat tool webhook.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/voice-tools/connections", () => ({ resolveCalendarConnection: vi.fn() }));
vi.mock("@/lib/nango/workspace", () => ({ nangoProxyForBusiness: vi.fn() }));
vi.mock("@/lib/db/businesses", () => ({ getBusinessTimezone: vi.fn() }));
vi.mock("@/lib/calendar-tools/shared-calendar", () => ({
  getSharedCalendar: vi.fn(),
  ensureSharedCalendar: vi.fn()
}));
vi.mock("@/lib/calendar-tools/calendly", () => ({
  findCalendlySlots: vi.fn(),
  createCalendlyBookingLink: vi.fn()
}));
vi.mock("@/lib/calendar-tools/vagaro", () => ({
  findVagaroSlots: vi.fn(),
  bookVagaroAppointment: vi.fn()
}));
vi.mock("@/lib/calendar-tools/caldav", () => ({
  getCaldavBusyBlocks: vi.fn(),
  bookCaldavAppointment: vi.fn()
}));
vi.mock("@/lib/calendar-tools/booking-dedupe", () => ({
  bookingAttendeeKey: vi.fn(() => "key-under-test"),
  claimBookingDedupe: vi.fn(),
  confirmBookingDedupe: vi.fn(),
  releaseBookingDedupe: vi.fn()
}));
vi.mock("@/lib/customer-memory/db", () => ({ getCustomerMemory: vi.fn() }));
vi.mock("@/lib/ai-flows/goal-hooks", () => ({ fireGoalEvent: vi.fn() }));
vi.mock("@/lib/zoom/meetings", () => ({
  createZoomMeetingForBooking: vi.fn(),
  deleteZoomMeetingForBooking: vi.fn()
}));

import {
  bookCalendarAppointment,
  computeFreeSlots,
  findCalendarSlots,
  wallClockInZone
} from "@/lib/calendar-tools/handlers";
import { resolveCalendarConnection } from "@/lib/voice-tools/connections";
import { nangoProxyForBusiness } from "@/lib/nango/workspace";
import { getBusinessTimezone } from "@/lib/db/businesses";
import { ensureSharedCalendar, getSharedCalendar } from "@/lib/calendar-tools/shared-calendar";
import {
  createCalendlyBookingLink,
  findCalendlySlots
} from "@/lib/calendar-tools/calendly";
import { bookVagaroAppointment, findVagaroSlots } from "@/lib/calendar-tools/vagaro";
import { bookCaldavAppointment, getCaldavBusyBlocks } from "@/lib/calendar-tools/caldav";
import {
  bookingAttendeeKey,
  claimBookingDedupe,
  confirmBookingDedupe,
  releaseBookingDedupe
} from "@/lib/calendar-tools/booking-dedupe";
import { getCustomerMemory } from "@/lib/customer-memory/db";
import { fireGoalEvent } from "@/lib/ai-flows/goal-hooks";
import {
  createZoomMeetingForBooking,
  deleteZoomMeetingForBooking
} from "@/lib/zoom/meetings";

const BIZ = "11111111-1111-4111-8111-111111111111";

const GOOGLE_CONN = {
  provider: "google",
  connectionId: "conn-1",
  providerConfigKey: "google-calendar"
} as never;
const MS_CONN = {
  provider: "microsoft",
  connectionId: "conn-2",
  providerConfigKey: "microsoft-calendar"
} as never;
const CALENDLY_CONN = {
  provider: "calendly",
  connectionId: "conn-3",
  providerConfigKey: "calendly"
} as never;
const VAGARO_CONN = {
  provider: "vagaro",
  connectionId: "vagaro-row-1",
  providerConfigKey: "vagaro"
} as never;
const CALDAV_CONN = {
  provider: "caldav",
  connectionId: "caldav-row-1",
  providerConfigKey: "caldav-direct"
} as never;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getBusinessTimezone).mockResolvedValue(null);
  // Default: no shared NewCoworker calendar → pre-shared-calendar behavior.
  vi.mocked(getSharedCalendar).mockResolvedValue(null);
  vi.mocked(ensureSharedCalendar).mockResolvedValue(null);
  // Default: dedupe ledger unavailable (fail-open) — bookings proceed exactly
  // as before the idempotency guard, which is what the pre-guard tests pin.
  vi.mocked(bookingAttendeeKey).mockReturnValue("key-under-test");
  vi.mocked(claimBookingDedupe).mockResolvedValue(null);
  // Default: no stored contact — the model-supplied attendeeName is used, as
  // pre-preferred-name tests pin.
  vi.mocked(getCustomerMemory).mockResolvedValue(null);
  // Default: no Zoom connection — bookings behave exactly as pre-Zoom tests pin.
  vi.mocked(createZoomMeetingForBooking).mockResolvedValue(null);
});

describe("computeFreeSlots", () => {
  const t = (h: number) => new Date(Date.UTC(2026, 5, 12, h, 0, 0));
  const HOUR = 60 * 60 * 1000;

  it("finds gaps between busy blocks and caps at maxSlots", () => {
    const busy = [
      { start: t(10), end: t(11) },
      { start: t(12), end: t(13) },
      { start: t(14), end: t(15) },
      { start: t(16), end: t(17) }
    ];
    const slots = computeFreeSlots(t(9), t(20), busy, HOUR, 3);
    expect(slots).toEqual([
      { startIso: t(9).toISOString(), endIso: t(10).toISOString() },
      { startIso: t(11).toISOString(), endIso: t(12).toISOString() },
      { startIso: t(13).toISOString(), endIso: t(14).toISOString() }
    ]);
  });

  it("skips blocks outside the window and already-passed blocks", () => {
    const busy = [
      { start: t(1), end: t(2) }, // ends before windowStart cursor
      { start: t(21), end: t(22) } // starts after windowEnd
    ];
    const slots = computeFreeSlots(t(9), t(20), busy, HOUR);
    // Whole window is free → one leading slot from the cursor.
    expect(slots[0]).toEqual({ startIso: t(9).toISOString(), endIso: t(10).toISOString() });
  });

  it("appends the tail slot only when enough room remains", () => {
    const busy = [{ start: t(9), end: t(19) }];
    expect(computeFreeSlots(t(9), t(20), busy, HOUR)).toEqual([
      { startIso: t(19).toISOString(), endIso: t(20).toISOString() }
    ]);
    expect(computeFreeSlots(t(9), t(20), busy, 2 * HOUR)).toEqual([]);
  });

  it("does not move the cursor backwards across overlapping blocks", () => {
    const busy = [
      { start: t(9), end: t(12) },
      { start: t(10), end: t(11) } // nested inside the first block
    ];
    const slots = computeFreeSlots(t(9), t(20), busy, HOUR, 1);
    expect(slots).toEqual([{ startIso: t(12).toISOString(), endIso: t(13).toISOString() }]);
  });

  const at = (h: number, m: number) => new Date(Date.UTC(2026, 5, 12, h, m, 0));

  it("emits no tail slot when a busy block runs to the window end", () => {
    const busy = [{ start: t(10), end: t(20) }];
    expect(computeFreeSlots(t(9), t(20), busy, HOUR)).toEqual([
      { startIso: t(9).toISOString(), endIso: t(10).toISOString() }
    ]);
  });

  it("never offers an unaligned start: a 10:07 gap opens at 10:30, not 10:07", () => {
    // The Junaid failure mode: windowStart = "now" (5:19 PM) produced a
    // "5:19 PM" offer. Quarter alignment + :00/:30 preference gives :30.
    const slots = computeFreeSlots(at(10, 7), at(12, 0), [], 30 * 60_000, 3);
    expect(slots[0]).toEqual({
      startIso: at(10, 30).toISOString(),
      endIso: at(11, 0).toISOString()
    });
  });

  it("prefers the next hour over an earlier :45 start", () => {
    const slots = computeFreeSlots(at(10, 31), at(12, 0), [], 30 * 60_000, 3);
    expect(slots[0]?.startIso).toBe(at(11, 0).toISOString());
  });

  it("falls back to a :15/:45 start when the preferred :00/:30 no longer fits", () => {
    // Gap 10:07-10:35, 15-minute duration: 10:30 (preferred) would end at
    // 10:45 past the gap; 10:15 fits.
    const slots = computeFreeSlots(at(10, 7), at(10, 35), [], 15 * 60_000, 3);
    expect(slots).toEqual([
      { startIso: at(10, 15).toISOString(), endIso: at(10, 30).toISOString() }
    ]);
  });

  it("skips a gap where no aligned start fits and offers the next gap", () => {
    // 10:07-10:30 can't fit 30 minutes from any quarter boundary; the gap
    // after the busy block can.
    const busy = [{ start: at(10, 30), end: at(11, 10) }];
    const slots = computeFreeSlots(at(10, 7), at(13, 0), busy, 30 * 60_000, 3);
    expect(slots).toEqual([
      { startIso: at(11, 30).toISOString(), endIso: at(12, 0).toISOString() }
    ]);
  });

  it("classifies :00/:30 in the requester's timezone, not UTC", () => {
    // Asia/Kathmandu is UTC+05:45: 10:15Z is 4:00 PM local (preferred),
    // while 10:00Z is 3:45 PM local. UTC classification would pick 10:00Z.
    const slots = computeFreeSlots(
      at(10, 0),
      at(12, 0),
      [],
      30 * 60_000,
      1,
      "Asia/Kathmandu"
    );
    expect(slots[0]?.startIso).toBe(at(10, 15).toISOString());
  });

  it("degrades to UTC minute classification on an invalid timezone", () => {
    const slots = computeFreeSlots(at(10, 7), at(12, 0), [], 30 * 60_000, 1, "not/a-zone");
    expect(slots[0]?.startIso).toBe(at(10, 30).toISOString());
  });
});

describe("wallClockInZone", () => {
  it("renders the naive local wall time Microsoft Graph expects", () => {
    expect(wallClockInZone(new Date("2026-06-12T17:00:00.000Z"), "America/Phoenix")).toBe(
      "2026-06-12T10:00:00"
    );
  });

  it("uses 00 (not 24) at midnight", () => {
    expect(wallClockInZone(new Date("2026-06-12T00:00:00.000Z"), "UTC")).toBe(
      "2026-06-12T00:00:00"
    );
  });
});

describe("findCalendarSlots", () => {
  it("rejects an inverted window", async () => {
    const result = await findCalendarSlots(BIZ, {
      earliest: "2026-06-12T10:00:00.000Z",
      latest: "2026-06-12T09:00:00.000Z",
      durationMinutes: 30
    });
    expect(result).toEqual({ ok: false, detail: "invalid_window" });
    expect(vi.mocked(resolveCalendarConnection)).not.toHaveBeenCalled();
  });

  it("returns calendar_not_connected when no calendar is linked", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(null as never);
    const result = await findCalendarSlots(BIZ, { durationMinutes: 30 });
    expect(result).toEqual({ ok: false, detail: "calendar_not_connected" });
  });

  it("computes slots from CalDAV busy blocks with the shared aligned walk", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(CALDAV_CONN);
    vi.mocked(getBusinessTimezone).mockResolvedValue("UTC");
    vi.mocked(getCaldavBusyBlocks).mockResolvedValue({
      ok: true,
      busy: [
        {
          start: new Date("2026-06-12T09:00:00.000Z"),
          end: new Date("2026-06-12T10:00:00.000Z")
        }
      ]
    } as never);
    const result = await findCalendarSlots(BIZ, {
      earliest: "2026-06-12T09:00:00.000Z",
      latest: "2026-06-12T12:00:00.000Z",
      durationMinutes: 30,
      purpose: "estimate"
    });
    expect(result.ok).toBe(true);
    const data = result.data as {
      slots: Array<{ startIso: string }>;
      timezone: string;
      purpose: string | null;
      durationMinutes: number;
    };
    expect(data.slots[0]?.startIso).toBe("2026-06-12T10:00:00.000Z");
    expect(data.timezone).toBe("UTC");
    expect(data.purpose).toBe("estimate");
    expect(data.durationMinutes).toBe(30);
    expect(vi.mocked(getCaldavBusyBlocks)).toHaveBeenCalledWith(
      BIZ,
      new Date("2026-06-12T09:00:00.000Z"),
      new Date("2026-06-12T12:00:00.000Z")
    );
    // Direct CalDAV never touches Nango or the shared workspace calendar.
    expect(vi.mocked(nangoProxyForBusiness)).not.toHaveBeenCalled();
    expect(vi.mocked(getSharedCalendar)).not.toHaveBeenCalled();
  });

  it("surfaces the CalDAV failure result untouched", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(CALDAV_CONN);
    vi.mocked(getCaldavBusyBlocks).mockResolvedValue({
      ok: false,
      result: { ok: false, detail: "calendar_not_connected" }
    } as never);
    const result = await findCalendarSlots(BIZ, { durationMinutes: 30 });
    expect(result).toEqual({ ok: false, detail: "calendar_not_connected" });
  });

  it("echoes a null purpose on the CalDAV path when none was asked", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(CALDAV_CONN);
    vi.mocked(getCaldavBusyBlocks).mockResolvedValue({ ok: true, busy: [] } as never);
    const result = await findCalendarSlots(BIZ, { durationMinutes: 30 });
    expect(result.ok).toBe(true);
    expect((result.data as { purpose: string | null }).purpose).toBeNull();
  });

  it("delegates a Vagaro connection to findVagaroSlots with the window, serviceId, and resolved timezone", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(VAGARO_CONN);
    vi.mocked(getBusinessTimezone).mockResolvedValue("America/Phoenix");
    const delegated = { ok: true, data: { slots: [] } };
    vi.mocked(findVagaroSlots).mockResolvedValue(delegated as never);
    const result = await findCalendarSlots(BIZ, {
      earliest: "2026-06-12T09:00:00.000Z",
      latest: "2026-06-12T12:00:00.000Z",
      durationMinutes: 45,
      purpose: "color",
      serviceId: "svc-9"
    });
    expect(result).toBe(delegated);
    expect(vi.mocked(findVagaroSlots)).toHaveBeenCalledWith(BIZ, {
      windowStart: new Date("2026-06-12T09:00:00.000Z"),
      windowEnd: new Date("2026-06-12T12:00:00.000Z"),
      durationMinutes: 45,
      purpose: "color",
      serviceId: "svc-9",
      timezone: "America/Phoenix"
    });
    expect(vi.mocked(nangoProxyForBusiness)).not.toHaveBeenCalled();
    expect(vi.mocked(getSharedCalendar)).not.toHaveBeenCalled();
  });

  it("delegates a Calendly connection to findCalendlySlots with the window and resolved timezone", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(CALENDLY_CONN);
    vi.mocked(getBusinessTimezone).mockResolvedValue("America/Phoenix");
    const delegated = { ok: true, data: { slots: [] } };
    vi.mocked(findCalendlySlots).mockResolvedValue(delegated as never);
    const result = await findCalendarSlots(BIZ, {
      earliest: "2026-06-12T09:00:00.000Z",
      latest: "2026-06-12T12:00:00.000Z",
      durationMinutes: 45,
      purpose: "consult"
    });
    expect(result).toBe(delegated);
    expect(vi.mocked(findCalendlySlots)).toHaveBeenCalledWith(BIZ, CALENDLY_CONN, {
      windowStart: new Date("2026-06-12T09:00:00.000Z"),
      windowEnd: new Date("2026-06-12T12:00:00.000Z"),
      durationMinutes: 45,
      purpose: "consult",
      timezone: "America/Phoenix"
    });
    // The Google/Microsoft path (and its shared-calendar read) never runs.
    expect(vi.mocked(nangoProxyForBusiness)).not.toHaveBeenCalled();
    expect(vi.mocked(getSharedCalendar)).not.toHaveBeenCalled();
  });

  it("computes slots from Google FreeBusy", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(GOOGLE_CONN);
    vi.mocked(nangoProxyForBusiness).mockResolvedValue({
      data: {
        calendars: {
          primary: {
            busy: [{ start: "2026-06-12T10:00:00.000Z", end: "2026-06-12T11:00:00.000Z" }]
          }
        }
      }
    } as never);
    const result = await findCalendarSlots(BIZ, {
      earliest: "2026-06-12T09:00:00.000Z",
      latest: "2026-06-12T12:00:00.000Z",
      durationMinutes: 60,
      timezone: "America/Phoenix",
      purpose: "estimate"
    });
    expect(result.ok).toBe(true);
    const data = result.data as { slots: unknown[]; timezone: string; purpose: string };
    expect(data.slots).toHaveLength(2);
    expect(data.timezone).toBe("America/Phoenix");
    expect(data.purpose).toBe("estimate");
    expect(vi.mocked(nangoProxyForBusiness)).toHaveBeenCalledWith(
      BIZ,
      { connectionId: "conn-1", providerConfigKey: "google-calendar" },
      expect.objectContaining({ endpoint: "/calendar/v3/freeBusy" })
    );
  });

  it("tolerates a FreeBusy body with calendars missing busy arrays", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(GOOGLE_CONN);
    vi.mocked(nangoProxyForBusiness).mockResolvedValue({
      data: { calendars: { primary: {} } }
    } as never);
    const result = await findCalendarSlots(BIZ, {
      earliest: "2026-06-12T09:00:00.000Z",
      latest: "2026-06-12T12:00:00.000Z",
      durationMinutes: 30
    });
    expect(result.ok).toBe(true);
    expect((result.data as { slots: unknown[] }).slots.length).toBeGreaterThan(0);
  });

  it("treats a null Google proxy response as not connected", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(GOOGLE_CONN);
    vi.mocked(nangoProxyForBusiness).mockResolvedValue(null as never);
    const result = await findCalendarSlots(BIZ, { durationMinutes: 30 });
    expect(result).toEqual({ ok: false, detail: "calendar_not_connected" });
  });

  it("computes slots from Microsoft getSchedule, filtering malformed items", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(MS_CONN);
    vi.mocked(nangoProxyForBusiness).mockResolvedValue({
      data: {
        value: [
          {
            scheduleItems: [
              {
                start: { dateTime: "2026-06-12T10:00:00.000Z" },
                end: { dateTime: "2026-06-12T11:00:00.000Z" }
              },
              { start: { dateTime: "2026-06-12T13:00:00.000Z" } } // missing end → dropped
            ]
          }
        ]
      }
    } as never);
    const result = await findCalendarSlots(BIZ, {
      earliest: "2026-06-12T09:00:00.000Z",
      latest: "2026-06-12T12:00:00.000Z",
      durationMinutes: 60
    });
    expect(result.ok).toBe(true);
    expect((result.data as { slots: unknown[] }).slots).toHaveLength(2);
    expect(vi.mocked(nangoProxyForBusiness)).toHaveBeenCalledWith(
      BIZ,
      { connectionId: "conn-2", providerConfigKey: "microsoft-calendar" },
      expect.objectContaining({ endpoint: "/v1.0/me/calendar/getSchedule" })
    );
  });

  it("tolerates an empty Graph schedule body", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(MS_CONN);
    vi.mocked(nangoProxyForBusiness).mockResolvedValue({ data: {} } as never);
    const result = await findCalendarSlots(BIZ, { durationMinutes: 30 });
    expect(result.ok).toBe(true);
  });

  it("treats a null Microsoft proxy response as not connected", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(MS_CONN);
    vi.mocked(nangoProxyForBusiness).mockResolvedValue(null as never);
    const result = await findCalendarSlots(BIZ, { durationMinutes: 30 });
    expect(result).toEqual({ ok: false, detail: "calendar_not_connected" });
  });

  it("falls back to the default window for malformed earliest/latest strings", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(GOOGLE_CONN);
    vi.mocked(nangoProxyForBusiness).mockResolvedValue({ data: {} } as never);
    const result = await findCalendarSlots(BIZ, {
      earliest: "not a date",
      latest: "also not a date",
      durationMinutes: 30
    });
    expect(result.ok).toBe(true);
  });

  it("maps proxy failures to calendar_lookup_failed", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(GOOGLE_CONN);
    vi.mocked(nangoProxyForBusiness).mockRejectedValue(new Error("nango 502"));
    const result = await findCalendarSlots(BIZ, { durationMinutes: 30 });
    expect(result).toEqual({ ok: false, detail: "calendar_lookup_failed" });
  });

  it("defaults the echoed timezone to the business timezone when the model omits one", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(GOOGLE_CONN);
    vi.mocked(nangoProxyForBusiness).mockResolvedValue({ data: {} } as never);
    vi.mocked(getBusinessTimezone).mockResolvedValue("America/Denver");
    const result = await findCalendarSlots(BIZ, { durationMinutes: 30 });
    expect(result.ok).toBe(true);
    expect((result.data as { timezone: string }).timezone).toBe("America/Denver");
  });

  it("degrades the timezone default to UTC when the business lookup throws", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(GOOGLE_CONN);
    vi.mocked(nangoProxyForBusiness).mockResolvedValue({ data: {} } as never);
    vi.mocked(getBusinessTimezone).mockRejectedValue(new Error("db down"));
    const result = await findCalendarSlots(BIZ, { durationMinutes: 30 });
    expect(result.ok).toBe(true);
    expect((result.data as { timezone: string }).timezone).toBe("UTC");
  });

  it("echoes UTC when neither the model nor the business provides a timezone", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(GOOGLE_CONN);
    vi.mocked(nangoProxyForBusiness).mockResolvedValue({ data: {} } as never);
    const result = await findCalendarSlots(BIZ, { durationMinutes: 30 });
    expect(result.ok).toBe(true);
    expect((result.data as { timezone: string }).timezone).toBe("UTC");
  });

  it("rejects a non-IANA explicit timezone in favor of the business zone", async () => {
    // Models sometimes send abbreviations ("EDT") that Intl can't resolve;
    // silently using them would blow up the wall-clock conversion later.
    vi.mocked(resolveCalendarConnection).mockResolvedValue(GOOGLE_CONN);
    vi.mocked(nangoProxyForBusiness).mockResolvedValue({ data: {} } as never);
    vi.mocked(getBusinessTimezone).mockResolvedValue("America/Toronto");
    const result = await findCalendarSlots(BIZ, { durationMinutes: 30, timezone: "EDT" });
    expect(result.ok).toBe(true);
    expect((result.data as { timezone: string }).timezone).toBe("America/Toronto");
  });

  it("degrades to UTC when the stored business timezone is itself invalid", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(GOOGLE_CONN);
    vi.mocked(nangoProxyForBusiness).mockResolvedValue({ data: {} } as never);
    vi.mocked(getBusinessTimezone).mockResolvedValue("Mars/Olympus_Mons");
    const result = await findCalendarSlots(BIZ, { durationMinutes: 30 });
    expect(result.ok).toBe(true);
    expect((result.data as { timezone: string }).timezone).toBe("UTC");
  });

  it("tolerates non-Error throw values in the failure log", async () => {
    vi.mocked(resolveCalendarConnection).mockRejectedValue("string failure");
    const result = await findCalendarSlots(BIZ, { durationMinutes: 30 });
    expect(result).toEqual({ ok: false, detail: "calendar_lookup_failed" });
  });

  it("includes the shared calendar in the Google FreeBusy query and merges its busy blocks", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(GOOGLE_CONN);
    vi.mocked(getSharedCalendar).mockResolvedValue({
      calendarId: "shared-cal",
      conn: GOOGLE_CONN
    } as never);
    vi.mocked(nangoProxyForBusiness).mockResolvedValue({
      data: {
        calendars: {
          primary: {
            busy: [{ start: "2026-06-12T09:00:00.000Z", end: "2026-06-12T10:00:00.000Z" }]
          },
          "shared-cal": {
            busy: [{ start: "2026-06-12T10:00:00.000Z", end: "2026-06-12T11:00:00.000Z" }]
          }
        }
      }
    } as never);
    const result = await findCalendarSlots(BIZ, {
      earliest: "2026-06-12T09:00:00.000Z",
      latest: "2026-06-12T12:00:00.000Z",
      durationMinutes: 60
    });
    expect(result.ok).toBe(true);
    // Both calendars' blocks consume 09:00-11:00 → only 11:00-12:00 remains.
    expect((result.data as { slots: Array<{ startIso: string }> }).slots).toEqual([
      {
        startIso: "2026-06-12T11:00:00.000Z",
        endIso: "2026-06-12T12:00:00.000Z"
      }
    ]);
    const payload = vi.mocked(nangoProxyForBusiness).mock.calls[0][2] as {
      data: { items: Array<{ id: string }> };
    };
    expect(payload.data.items).toEqual([{ id: "primary" }, { id: "shared-cal" }]);
  });

  it("merges shared-calendar events into Microsoft busy via calendarView", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(MS_CONN);
    vi.mocked(getSharedCalendar).mockResolvedValue({
      calendarId: "shared-ms",
      conn: MS_CONN
    } as never);
    vi.mocked(nangoProxyForBusiness)
      .mockResolvedValueOnce({
        data: {
          value: [
            {
              scheduleItems: [
                {
                  start: { dateTime: "2026-06-12T09:00:00.000Z" },
                  end: { dateTime: "2026-06-12T10:00:00.000Z" }
                }
              ]
            }
          ]
        }
      } as never)
      .mockResolvedValueOnce({
        data: {
          value: [
            {
              start: { dateTime: "2026-06-12T10:00:00.000Z" },
              end: { dateTime: "2026-06-12T11:00:00.000Z" }
            },
            { start: { dateTime: "2026-06-12T11:00:00.000Z" } } // missing end → dropped
          ]
        }
      } as never);
    const result = await findCalendarSlots(BIZ, {
      earliest: "2026-06-12T09:00:00.000Z",
      latest: "2026-06-12T12:00:00.000Z",
      durationMinutes: 60
    });
    expect(result.ok).toBe(true);
    expect((result.data as { slots: unknown[] }).slots).toEqual([
      {
        startIso: "2026-06-12T11:00:00.000Z",
        endIso: "2026-06-12T12:00:00.000Z"
      }
    ]);
    expect(vi.mocked(nangoProxyForBusiness)).toHaveBeenCalledWith(
      BIZ,
      { connectionId: "conn-2", providerConfigKey: "microsoft-calendar" },
      expect.objectContaining({
        endpoint: "/v1.0/me/calendars/shared-ms/calendarView",
        method: "GET"
      })
    );
  });

  it("tolerates a null calendarView response for the Microsoft shared calendar", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(MS_CONN);
    vi.mocked(getSharedCalendar).mockResolvedValue({
      calendarId: "shared-ms",
      conn: MS_CONN
    } as never);
    vi.mocked(nangoProxyForBusiness)
      .mockResolvedValueOnce({ data: {} } as never)
      .mockResolvedValueOnce(null as never);
    const result = await findCalendarSlots(BIZ, { durationMinutes: 30 });
    expect(result.ok).toBe(true);
  });
});

describe("bookCalendarAppointment", () => {
  const ARGS = {
    startIso: "2026-06-12T17:00:00.000Z",
    endIso: "2026-06-12T17:30:00.000Z",
    summary: "Estimate",
    attendeeName: "Joe Plumber"
  };

  it("rejects an inverted window", async () => {
    const result = await bookCalendarAppointment(BIZ, {
      ...ARGS,
      endIso: ARGS.startIso
    });
    expect(result).toEqual({ ok: false, detail: "invalid_window" });
    expect(vi.mocked(resolveCalendarConnection)).not.toHaveBeenCalled();
  });

  it("returns calendar_not_connected when no calendar is linked", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(null as never);
    const result = await bookCalendarAppointment(BIZ, ARGS);
    expect(result).toEqual({ ok: false, detail: "calendar_not_connected" });
  });

  it("delegates a CalDAV connection to bookCaldavAppointment and fires the goal on a confirmed create", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(CALDAV_CONN);
    const delegated = { ok: true, data: { eventId: "newcoworker-1", provider: "caldav" } };
    vi.mocked(bookCaldavAppointment).mockResolvedValue(delegated as never);
    const result = await bookCalendarAppointment(
      BIZ,
      { ...ARGS, attendeeEmail: "joe@acme.com", notes: "gate code 1234" },
      "+15551230000"
    );
    // Deep equality, not identity: the success path re-wraps the result so a
    // Zoom join link can be merged into the data when one exists.
    expect(result).toStrictEqual(delegated);
    expect(vi.mocked(bookCaldavAppointment)).toHaveBeenCalledWith(BIZ, {
      startIso: ARGS.startIso,
      endIso: ARGS.endIso,
      summary: ARGS.summary,
      description:
        "gate code 1234\nAttendee: Joe Plumber\nPhone: +15551230000\nEmail: joe@acme.com"
    });
    expect(vi.mocked(fireGoalEvent)).toHaveBeenCalledWith(BIZ, "+15551230000", {
      kind: "appointment_booked"
    });
    expect(vi.mocked(nangoProxyForBusiness)).not.toHaveBeenCalled();
    expect(vi.mocked(ensureSharedCalendar)).not.toHaveBeenCalled();
  });

  it("an ok CalDAV result WITHOUT an event id fires no goal event", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(CALDAV_CONN);
    vi.mocked(bookCaldavAppointment).mockResolvedValue({
      ok: true,
      data: { eventId: null, provider: "caldav" }
    } as never);
    await bookCalendarAppointment(BIZ, ARGS);
    expect(vi.mocked(fireGoalEvent)).not.toHaveBeenCalled();
  });

  it("a failed CalDAV booking fires no goal event and omits empty description lines", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(CALDAV_CONN);
    vi.mocked(bookCaldavAppointment).mockResolvedValue({
      ok: false,
      detail: "calendar_book_failed"
    } as never);
    const result = await bookCalendarAppointment(BIZ, ARGS);
    expect(result).toEqual({ ok: false, detail: "calendar_book_failed" });
    expect(vi.mocked(bookCaldavAppointment)).toHaveBeenCalledWith(BIZ, {
      startIso: ARGS.startIso,
      endIso: ARGS.endIso,
      summary: ARGS.summary,
      description: "Attendee: Joe Plumber"
    });
    expect(vi.mocked(fireGoalEvent)).not.toHaveBeenCalled();
  });

  it("delegates a Vagaro connection to bookVagaroAppointment with the raw args + fallback phone", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(VAGARO_CONN);
    const delegated = { ok: true, data: { eventId: "appt-1", provider: "vagaro" } };
    vi.mocked(bookVagaroAppointment).mockResolvedValue(delegated as never);
    const result = await bookCalendarAppointment(BIZ, ARGS, "+15551230000");
    expect(result).toBe(delegated);
    expect(vi.mocked(bookVagaroAppointment)).toHaveBeenCalledWith(BIZ, ARGS, "+15551230000");
    expect(vi.mocked(nangoProxyForBusiness)).not.toHaveBeenCalled();
    expect(vi.mocked(ensureSharedCalendar)).not.toHaveBeenCalled();
    // A real Vagaro booking fires the appointment_booked goal for the lead.
    expect(vi.mocked(fireGoalEvent)).toHaveBeenCalledWith(BIZ, "+15551230000", {
      kind: "appointment_booked"
    });
  });

  it("a failed Vagaro booking fires no goal event", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(VAGARO_CONN);
    vi.mocked(bookVagaroAppointment).mockResolvedValue({
      ok: false,
      detail: "vagaro_slot_taken"
    } as never);
    await bookCalendarAppointment(BIZ, ARGS, "+15551230000");
    expect(vi.mocked(fireGoalEvent)).not.toHaveBeenCalled();
  });

  it("a success-shaped Vagaro response WITHOUT an appointment id fires no goal event", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(VAGARO_CONN);
    vi.mocked(bookVagaroAppointment).mockResolvedValue({
      ok: true,
      data: { provider: "vagaro" }
    } as never);
    await bookCalendarAppointment(BIZ, ARGS, "+15551230000");
    expect(vi.mocked(fireGoalEvent)).not.toHaveBeenCalled();
  });

  it("delegates a Calendly connection to createCalendlyBookingLink", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(CALENDLY_CONN);
    const delegated = {
      ok: true,
      detail: "booking_link_created",
      data: { bookingLink: "https://calendly.com/d/abc" }
    };
    vi.mocked(createCalendlyBookingLink).mockResolvedValue(delegated as never);
    const result = await bookCalendarAppointment(BIZ, ARGS, "+15551230000");
    expect(result).toBe(delegated);
    expect(vi.mocked(createCalendlyBookingLink)).toHaveBeenCalledWith(BIZ, CALENDLY_CONN, {
      startIso: ARGS.startIso,
      endIso: ARGS.endIso
    });
    // Never creates provider events or the shared calendar.
    expect(vi.mocked(nangoProxyForBusiness)).not.toHaveBeenCalled();
    expect(vi.mocked(ensureSharedCalendar)).not.toHaveBeenCalled();
    // A scheduling LINK is not a booking — no goal event.
    expect(vi.mocked(fireGoalEvent)).not.toHaveBeenCalled();
  });

  it("books a Google event with attendee email + caller-phone fallback", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(GOOGLE_CONN);
    vi.mocked(nangoProxyForBusiness).mockResolvedValue({
      data: { id: "ev-1", htmlLink: "https://cal/ev-1" }
    } as never);
    const result = await bookCalendarAppointment(
      BIZ,
      { ...ARGS, attendeeEmail: "joe@example.com", notes: "gate code 1234", timezone: "America/Phoenix" },
      "+15551230000"
    );
    expect(result).toEqual({
      ok: true,
      data: { eventId: "ev-1", htmlLink: "https://cal/ev-1", provider: "google", calendar: "primary" }
    });
    const payload = vi.mocked(nangoProxyForBusiness).mock.calls[0][2] as {
      endpoint: string;
      data: { description: string; attendees: unknown[]; start: { timeZone: string } };
    };
    expect(payload.endpoint).toBe("/calendar/v3/calendars/primary/events");
    expect(payload.data.description).toContain("gate code 1234");
    expect(payload.data.description).toContain("Phone: +15551230000");
    expect(payload.data.description).toContain("Email: joe@example.com");
    expect(payload.data.attendees).toEqual([
      { email: "joe@example.com", displayName: "Joe Plumber" }
    ]);
    expect(payload.data.start.timeZone).toBe("America/Phoenix");
  });

  it("prefers the explicit attendeePhone over the fallback", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(GOOGLE_CONN);
    vi.mocked(nangoProxyForBusiness).mockResolvedValue({ data: { id: "ev-2" } } as never);
    await bookCalendarAppointment(BIZ, { ...ARGS, attendeePhone: "+15559998888" }, "+15551230000");
    const payload = vi.mocked(nangoProxyForBusiness).mock.calls[0][2] as {
      data: { description: string };
    };
    expect(payload.data.description).toContain("Phone: +15559998888");
    expect(payload.data.description).not.toContain("+15551230000");
    // The goal event carries the same phone precedence.
    expect(vi.mocked(fireGoalEvent)).toHaveBeenCalledWith(BIZ, "+15559998888", {
      kind: "appointment_booked"
    });
  });

  it("books without any phone when neither args nor fallback provide one", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(GOOGLE_CONN);
    vi.mocked(nangoProxyForBusiness).mockResolvedValue({ data: {} } as never);
    const result = await bookCalendarAppointment(BIZ, ARGS);
    expect(result).toEqual({
      ok: true,
      data: { eventId: null, htmlLink: null, provider: "google", calendar: "primary" }
    });
    // No confirmed event id → no appointment_booked goal event.
    expect(vi.mocked(fireGoalEvent)).not.toHaveBeenCalled();
    const payload = vi.mocked(nangoProxyForBusiness).mock.calls[0][2] as {
      data: { description: string; attendees?: unknown };
    };
    expect(payload.data.description).toBe("Attendee: Joe Plumber");
    expect(payload.data.attendees).toBeUndefined();
  });

  it("treats a null Google proxy response as not connected", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(GOOGLE_CONN);
    vi.mocked(nangoProxyForBusiness).mockResolvedValue(null as never);
    const result = await bookCalendarAppointment(BIZ, ARGS);
    expect(result).toEqual({ ok: false, detail: "calendar_not_connected" });
  });

  it("books in the business timezone when the model omits one", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(GOOGLE_CONN);
    vi.mocked(nangoProxyForBusiness).mockResolvedValue({ data: { id: "ev-tz" } } as never);
    vi.mocked(getBusinessTimezone).mockResolvedValue("America/Chicago");
    await bookCalendarAppointment(BIZ, ARGS);
    const payload = vi.mocked(nangoProxyForBusiness).mock.calls[0][2] as {
      data: { start: { timeZone: string }; end: { timeZone: string } };
    };
    expect(payload.data.start.timeZone).toBe("America/Chicago");
    expect(payload.data.end.timeZone).toBe("America/Chicago");
  });

  it("accepts an offset-carrying instant and normalizes it per provider (Google)", async () => {
    // The Truly booking failures: the tool contract says "ISO 8601 with
    // timezone offset", so the model sends offsets. Google gets the
    // instant re-serialized as UTC; timeZone drives display.
    vi.mocked(resolveCalendarConnection).mockResolvedValue(GOOGLE_CONN);
    vi.mocked(nangoProxyForBusiness).mockResolvedValue({ data: { id: "ev-off" } } as never);
    const result = await bookCalendarAppointment(BIZ, {
      ...ARGS,
      startIso: "2026-06-12T13:00:00-04:00",
      endIso: "2026-06-12T13:30:00-04:00",
      timezone: "America/Toronto"
    });
    expect(result.ok).toBe(true);
    const payload = vi.mocked(nangoProxyForBusiness).mock.calls[0][2] as {
      data: { start: { dateTime: string; timeZone: string }; end: { dateTime: string } };
    };
    expect(payload.data.start.dateTime).toBe("2026-06-12T17:00:00.000Z");
    expect(payload.data.end.dateTime).toBe("2026-06-12T17:30:00.000Z");
    expect(payload.data.start.timeZone).toBe("America/Toronto");
  });

  it("sends Microsoft Graph naive local wall time, not the raw model string", async () => {
    // Graph's dateTimeTimeZone wants "2026-06-12T13:00:00" + a zone name;
    // an offset-carrying string passed through raw is rejected.
    vi.mocked(resolveCalendarConnection).mockResolvedValue(MS_CONN);
    vi.mocked(nangoProxyForBusiness).mockResolvedValue({ data: { id: "ms-off" } } as never);
    const result = await bookCalendarAppointment(BIZ, {
      ...ARGS,
      startIso: "2026-06-12T13:00:00-04:00",
      endIso: "2026-06-12T13:30:00-04:00",
      timezone: "America/Toronto"
    });
    expect(result.ok).toBe(true);
    const payload = vi.mocked(nangoProxyForBusiness).mock.calls[0][2] as {
      data: { start: { dateTime: string; timeZone: string }; end: { dateTime: string } };
    };
    expect(payload.data.start.dateTime).toBe("2026-06-12T13:00:00");
    expect(payload.data.end.dateTime).toBe("2026-06-12T13:30:00");
    expect(payload.data.start.timeZone).toBe("America/Toronto");
  });

  it("books a Microsoft event, falling back to the summary for an empty body", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(MS_CONN);
    vi.mocked(nangoProxyForBusiness).mockResolvedValue({
      data: { id: "ms-1", webLink: "https://outlook/ms-1" }
    } as never);
    const result = await bookCalendarAppointment(BIZ, {
      ...ARGS,
      attendeeEmail: "joe@example.com"
    });
    expect(result).toEqual({
      ok: true,
      data: { eventId: "ms-1", htmlLink: "https://outlook/ms-1", provider: "microsoft", calendar: "primary" }
    });
    const payload = vi.mocked(nangoProxyForBusiness).mock.calls[0][2] as {
      endpoint: string;
      data: { attendees: unknown[] };
    };
    expect(payload.endpoint).toBe("/v1.0/me/events");
    expect(payload.data.attendees).toEqual([
      {
        emailAddress: { address: "joe@example.com", name: "Joe Plumber" },
        type: "required"
      }
    ]);
  });

  it("handles a Microsoft response missing id/webLink and omitted attendees", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(MS_CONN);
    vi.mocked(nangoProxyForBusiness).mockResolvedValue({ data: {} } as never);
    const result = await bookCalendarAppointment(BIZ, ARGS);
    expect(result).toEqual({
      ok: true,
      data: { eventId: null, htmlLink: null, provider: "microsoft", calendar: "primary" }
    });
    const payload = vi.mocked(nangoProxyForBusiness).mock.calls[0][2] as {
      data: { attendees?: unknown };
    };
    expect(payload.data.attendees).toBeUndefined();
  });

  it("treats a null Microsoft proxy response as not connected", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(MS_CONN);
    vi.mocked(nangoProxyForBusiness).mockResolvedValue(null as never);
    const result = await bookCalendarAppointment(BIZ, ARGS);
    expect(result).toEqual({ ok: false, detail: "calendar_not_connected" });
  });

  it("maps proxy failures to calendar_book_failed", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(GOOGLE_CONN);
    vi.mocked(nangoProxyForBusiness).mockRejectedValue(new Error("nango 502"));
    const result = await bookCalendarAppointment(BIZ, ARGS);
    expect(result).toEqual({ ok: false, detail: "calendar_book_failed" });
  });

  it("tolerates non-Error throw values in the failure log", async () => {
    vi.mocked(resolveCalendarConnection).mockRejectedValue("string failure");
    const result = await bookCalendarAppointment(BIZ, ARGS);
    expect(result).toEqual({ ok: false, detail: "calendar_book_failed" });
  });

  it("books Google events onto the shared NewCoworker calendar when available", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(GOOGLE_CONN);
    vi.mocked(ensureSharedCalendar).mockResolvedValue({
      calendarId: "shared-cal",
      conn: GOOGLE_CONN
    } as never);
    vi.mocked(nangoProxyForBusiness).mockResolvedValue({ data: { id: "ev-s" } } as never);
    const result = await bookCalendarAppointment(BIZ, ARGS);
    expect(result).toEqual({
      ok: true,
      data: { eventId: "ev-s", htmlLink: null, provider: "google", calendar: "shared" }
    });
    const payload = vi.mocked(nangoProxyForBusiness).mock.calls[0][2] as { endpoint: string };
    expect(payload.endpoint).toBe("/calendar/v3/calendars/shared-cal/events");
  });

  it("books Microsoft events onto the shared NewCoworker calendar when available", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(MS_CONN);
    vi.mocked(ensureSharedCalendar).mockResolvedValue({
      calendarId: "shared-ms",
      conn: MS_CONN
    } as never);
    vi.mocked(nangoProxyForBusiness).mockResolvedValue({ data: { id: "ms-s" } } as never);
    const result = await bookCalendarAppointment(BIZ, ARGS);
    expect(result).toEqual({
      ok: true,
      data: { eventId: "ms-s", htmlLink: null, provider: "microsoft", calendar: "shared" }
    });
    const payload = vi.mocked(nangoProxyForBusiness).mock.calls[0][2] as { endpoint: string };
    expect(payload.endpoint).toBe("/v1.0/me/calendars/shared-ms/events");
  });
});

describe("bookCalendarAppointment — retry idempotency guard (2026-07-13 quadruple-booking incident)", () => {
  const ARGS = {
    startIso: "2026-06-12T17:00:00.000Z",
    endIso: "2026-06-12T17:30:00.000Z",
    summary: "Estimate",
    attendeeName: "Joe Plumber"
  };

  it("claims the slot with the attendee key (explicit phone over fallback) and start instant", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(GOOGLE_CONN);
    vi.mocked(nangoProxyForBusiness).mockResolvedValue({ data: { id: "ev-1" } } as never);
    await bookCalendarAppointment(
      BIZ,
      { ...ARGS, attendeePhone: "+15559998888", attendeeEmail: "joe@acme.com" },
      "+15551230000"
    );
    expect(vi.mocked(bookingAttendeeKey)).toHaveBeenCalledWith(
      "+15559998888",
      "joe@acme.com",
      "Joe Plumber"
    );
    expect(vi.mocked(claimBookingDedupe)).toHaveBeenCalledWith(
      BIZ,
      "key-under-test",
      "2026-06-12T17:00:00.000Z"
    );
  });

  it("falls back to the surface phone for the attendee key when the model omits one", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(GOOGLE_CONN);
    vi.mocked(nangoProxyForBusiness).mockResolvedValue({ data: { id: "ev-1" } } as never);
    await bookCalendarAppointment(BIZ, ARGS, "+15551230000");
    expect(vi.mocked(bookingAttendeeKey)).toHaveBeenCalledWith(
      "+15551230000",
      undefined,
      "Joe Plumber"
    );
  });

  it("a duplicate claim returns the recorded event WITHOUT touching the provider or firing goals", async () => {
    vi.mocked(claimBookingDedupe).mockResolvedValue({ kind: "duplicate", eventId: "evt-prior" });
    const result = await bookCalendarAppointment(BIZ, ARGS, "+15551230000");
    expect(result).toEqual({
      ok: true,
      detail: "already_booked",
      data: { eventId: "evt-prior", deduplicated: true }
    });
    expect(vi.mocked(resolveCalendarConnection)).not.toHaveBeenCalled();
    expect(vi.mocked(nangoProxyForBusiness)).not.toHaveBeenCalled();
    expect(vi.mocked(fireGoalEvent)).not.toHaveBeenCalled();
    expect(vi.mocked(confirmBookingDedupe)).not.toHaveBeenCalled();
    expect(vi.mocked(releaseBookingDedupe)).not.toHaveBeenCalled();
  });

  it("an in-flight claim refuses without touching the provider", async () => {
    vi.mocked(claimBookingDedupe).mockResolvedValue({ kind: "in_flight" });
    const result = await bookCalendarAppointment(BIZ, ARGS, "+15551230000");
    expect(result).toEqual({ ok: false, detail: "booking_in_progress" });
    expect(vi.mocked(resolveCalendarConnection)).not.toHaveBeenCalled();
    expect(vi.mocked(nangoProxyForBusiness)).not.toHaveBeenCalled();
  });

  it("confirms the claim after a successful provider create", async () => {
    vi.mocked(claimBookingDedupe).mockResolvedValue({ kind: "claimed", id: "claim-1" });
    vi.mocked(resolveCalendarConnection).mockResolvedValue(GOOGLE_CONN);
    vi.mocked(nangoProxyForBusiness).mockResolvedValue({ data: { id: "ev-1" } } as never);
    const result = await bookCalendarAppointment(BIZ, ARGS, "+15551230000");
    expect(result.ok).toBe(true);
    expect(vi.mocked(confirmBookingDedupe)).toHaveBeenCalledWith("claim-1", "ev-1", null);
    expect(vi.mocked(releaseBookingDedupe)).not.toHaveBeenCalled();
  });

  it("releases the claim when the booking fails, so a later attempt can book cleanly", async () => {
    vi.mocked(claimBookingDedupe).mockResolvedValue({ kind: "claimed", id: "claim-1" });
    vi.mocked(resolveCalendarConnection).mockResolvedValue(GOOGLE_CONN);
    vi.mocked(nangoProxyForBusiness).mockResolvedValue(null as never);
    const result = await bookCalendarAppointment(BIZ, ARGS, "+15551230000");
    expect(result).toEqual({ ok: false, detail: "calendar_not_connected" });
    expect(vi.mocked(releaseBookingDedupe)).toHaveBeenCalledWith("claim-1");
    expect(vi.mocked(confirmBookingDedupe)).not.toHaveBeenCalled();
  });

  it("releases the claim on an ok result WITHOUT a confirmed event id (Calendly link mode)", async () => {
    vi.mocked(claimBookingDedupe).mockResolvedValue({ kind: "claimed", id: "claim-1" });
    vi.mocked(resolveCalendarConnection).mockResolvedValue(CALENDLY_CONN);
    vi.mocked(createCalendlyBookingLink).mockResolvedValue({
      ok: true,
      detail: "booking_link_created",
      data: { bookingLink: "https://calendly.com/d/abc" }
    } as never);
    const result = await bookCalendarAppointment(BIZ, ARGS, "+15551230000");
    expect(result.detail).toBe("booking_link_created");
    expect(vi.mocked(releaseBookingDedupe)).toHaveBeenCalledWith("claim-1");
    expect(vi.mocked(confirmBookingDedupe)).not.toHaveBeenCalled();
  });

  it("a null claim (ledger unavailable) books without dedupe — fail-open", async () => {
    vi.mocked(claimBookingDedupe).mockResolvedValue(null);
    vi.mocked(resolveCalendarConnection).mockResolvedValue(GOOGLE_CONN);
    vi.mocked(nangoProxyForBusiness).mockResolvedValue({ data: { id: "ev-1" } } as never);
    const result = await bookCalendarAppointment(BIZ, ARGS, "+15551230000");
    expect(result.ok).toBe(true);
    expect(vi.mocked(confirmBookingDedupe)).not.toHaveBeenCalled();
    expect(vi.mocked(releaseBookingDedupe)).not.toHaveBeenCalled();
  });
});

describe("bookCalendarAppointment — Zoom decorator", () => {
  const ARGS = {
    startIso: "2026-06-12T17:00:00.000Z",
    endIso: "2026-06-12T17:30:00.000Z",
    summary: "Estimate call",
    attendeeName: "Joe Plumber",
    notes: "Kitchen sink"
  };
  const ZOOM = { meetingId: "zm-1", joinUrl: "https://zoom.us/j/123" };

  it("threads the join link into the event body, result data, and ledger confirm", async () => {
    vi.mocked(claimBookingDedupe).mockResolvedValue({ kind: "claimed", id: "claim-1" });
    vi.mocked(resolveCalendarConnection).mockResolvedValue(GOOGLE_CONN);
    vi.mocked(createZoomMeetingForBooking).mockResolvedValue(ZOOM);
    vi.mocked(nangoProxyForBusiness).mockResolvedValue({ data: { id: "ev-1" } } as never);

    const result = await bookCalendarAppointment(BIZ, ARGS, "+15551230000");

    expect(vi.mocked(createZoomMeetingForBooking)).toHaveBeenCalledWith(BIZ, {
      topic: "Estimate call",
      startIso: ARGS.startIso,
      endIso: ARGS.endIso,
      agenda: "Kitchen sink"
    });
    const call = vi.mocked(nangoProxyForBusiness).mock.calls[0][2] as {
      data: { description: string };
    };
    expect(call.data.description).toContain("Video call (Zoom): https://zoom.us/j/123");
    expect(result.data).toMatchObject({
      eventId: "ev-1",
      zoomMeetingId: "zm-1",
      zoomJoinUrl: "https://zoom.us/j/123"
    });
    expect(vi.mocked(confirmBookingDedupe)).toHaveBeenCalledWith("claim-1", "ev-1", "zm-1");
    expect(vi.mocked(deleteZoomMeetingForBooking)).not.toHaveBeenCalled();
  });

  it("omits the agenda when the booking has no notes", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(GOOGLE_CONN);
    vi.mocked(createZoomMeetingForBooking).mockResolvedValue(null);
    vi.mocked(nangoProxyForBusiness).mockResolvedValue({ data: { id: "ev-1" } } as never);
    const { notes: _unused, ...noNotes } = ARGS;
    await bookCalendarAppointment(BIZ, noNotes, "+15551230000");
    expect(vi.mocked(createZoomMeetingForBooking)).toHaveBeenCalledWith(BIZ, {
      topic: "Estimate call",
      startIso: ARGS.startIso,
      endIso: ARGS.endIso
    });
  });

  it("cleans up the meeting when the Google create returns no connection", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(GOOGLE_CONN);
    vi.mocked(createZoomMeetingForBooking).mockResolvedValue(ZOOM);
    vi.mocked(nangoProxyForBusiness).mockResolvedValue(null as never);
    const result = await bookCalendarAppointment(BIZ, ARGS, "+15551230000");
    expect(result).toEqual({ ok: false, detail: "calendar_not_connected" });
    expect(vi.mocked(deleteZoomMeetingForBooking)).toHaveBeenCalledWith(BIZ, "zm-1");
  });

  it("cleans up the meeting when the Microsoft create returns no connection", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(MS_CONN);
    vi.mocked(createZoomMeetingForBooking).mockResolvedValue(ZOOM);
    vi.mocked(nangoProxyForBusiness).mockResolvedValue(null as never);
    const result = await bookCalendarAppointment(BIZ, ARGS, "+15551230000");
    expect(result).toEqual({ ok: false, detail: "calendar_not_connected" });
    expect(vi.mocked(deleteZoomMeetingForBooking)).toHaveBeenCalledWith(BIZ, "zm-1");
  });

  it("cleans up the meeting when the provider create throws", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(GOOGLE_CONN);
    vi.mocked(createZoomMeetingForBooking).mockResolvedValue(ZOOM);
    vi.mocked(nangoProxyForBusiness).mockRejectedValue(new Error("graph 500"));
    const result = await bookCalendarAppointment(BIZ, ARGS, "+15551230000");
    expect(result).toEqual({ ok: false, detail: "calendar_book_failed" });
    expect(vi.mocked(deleteZoomMeetingForBooking)).toHaveBeenCalledWith(BIZ, "zm-1");
  });

  it("CalDAV: merges the join link into the body and result; keeps the meeting on success", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(CALDAV_CONN);
    vi.mocked(createZoomMeetingForBooking).mockResolvedValue(ZOOM);
    vi.mocked(bookCaldavAppointment).mockResolvedValue({
      ok: true,
      data: { eventId: "ics-1", provider: "caldav" }
    } as never);

    const result = await bookCalendarAppointment(BIZ, ARGS, "+15551230000");

    const caldavCall = vi.mocked(bookCaldavAppointment).mock.calls[0][1] as {
      description: string;
    };
    expect(caldavCall.description).toContain("Video call (Zoom): https://zoom.us/j/123");
    expect(result.data).toMatchObject({
      eventId: "ics-1",
      zoomMeetingId: "zm-1",
      zoomJoinUrl: "https://zoom.us/j/123"
    });
    expect(vi.mocked(fireGoalEvent)).toHaveBeenCalled();
    expect(vi.mocked(deleteZoomMeetingForBooking)).not.toHaveBeenCalled();
  });

  it("CalDAV: cleans up the meeting when the booking fails", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(CALDAV_CONN);
    vi.mocked(createZoomMeetingForBooking).mockResolvedValue(ZOOM);
    vi.mocked(bookCaldavAppointment).mockResolvedValue({
      ok: false,
      detail: "calendar_book_failed"
    } as never);
    const result = await bookCalendarAppointment(BIZ, ARGS, "+15551230000");
    expect(result).toEqual({ ok: false, detail: "calendar_book_failed" });
    expect(vi.mocked(deleteZoomMeetingForBooking)).toHaveBeenCalledWith(BIZ, "zm-1");
  });

  it("Vagaro and Calendly stay Zoom-free", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(VAGARO_CONN);
    vi.mocked(bookVagaroAppointment).mockResolvedValue({ ok: true, data: {} } as never);
    await bookCalendarAppointment(BIZ, ARGS, "+15551230000");
    expect(vi.mocked(createZoomMeetingForBooking)).not.toHaveBeenCalled();

    vi.mocked(resolveCalendarConnection).mockResolvedValue(CALENDLY_CONN);
    vi.mocked(createCalendlyBookingLink).mockResolvedValue({
      ok: true,
      detail: "booking_link_created"
    } as never);
    await bookCalendarAppointment(BIZ, ARGS, "+15551230000");
    expect(vi.mocked(createZoomMeetingForBooking)).not.toHaveBeenCalled();
  });
});

describe("bookCalendarAppointment — stored display name wins (Truly Issue 6)", () => {
  const ARGS = {
    startIso: "2026-06-12T17:00:00.000Z",
    endIso: "2026-06-12T17:30:00.000Z",
    summary: "Estimate",
    attendeeName: "Muhammad Fahad Juhu"
  };

  it("replaces the model-supplied name with the contact's stored display name everywhere", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(GOOGLE_CONN);
    vi.mocked(getCustomerMemory).mockResolvedValue({ display_name: "Juhu" } as never);
    vi.mocked(nangoProxyForBusiness).mockResolvedValue({ data: { id: "ev-1" } } as never);

    await bookCalendarAppointment(BIZ, { ...ARGS, attendeeEmail: "j@x.co" }, "+15485773546");

    expect(vi.mocked(getCustomerMemory)).toHaveBeenCalledWith(BIZ, "+15485773546");
    // The dedupe key sees the preferred name too.
    expect(vi.mocked(bookingAttendeeKey)).toHaveBeenCalledWith("+15485773546", "j@x.co", "Juhu");
    const payload = vi.mocked(nangoProxyForBusiness).mock.calls[0][2] as {
      data: { description: string; attendees: Array<{ displayName: string }> };
    };
    expect(payload.data.description).toContain("Attendee: Juhu");
    expect(payload.data.description).not.toContain("Muhammad Fahad Juhu");
    expect(payload.data.attendees[0].displayName).toBe("Juhu");
  });

  it("keeps the model-supplied name when the contact has no stored name or is unknown", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(GOOGLE_CONN);
    vi.mocked(getCustomerMemory).mockResolvedValue({ display_name: "   " } as never);
    vi.mocked(nangoProxyForBusiness).mockResolvedValue({ data: { id: "ev-1" } } as never);
    await bookCalendarAppointment(BIZ, ARGS, "+15485773546");
    const payload = vi.mocked(nangoProxyForBusiness).mock.calls[0][2] as {
      data: { description: string };
    };
    expect(payload.data.description).toContain("Attendee: Muhammad Fahad Juhu");
  });

  it("skips the lookup entirely when no phone identity exists", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(GOOGLE_CONN);
    vi.mocked(nangoProxyForBusiness).mockResolvedValue({ data: { id: "ev-1" } } as never);
    await bookCalendarAppointment(BIZ, ARGS);
    expect(vi.mocked(getCustomerMemory)).not.toHaveBeenCalled();
  });

  it("a lookup failure (Error or not) books with the model-supplied name — never blocks", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(GOOGLE_CONN);
    vi.mocked(nangoProxyForBusiness).mockResolvedValue({ data: { id: "ev-1" } } as never);

    vi.mocked(getCustomerMemory).mockRejectedValue(new Error("db down"));
    expect((await bookCalendarAppointment(BIZ, ARGS, "+15485773546")).ok).toBe(true);

    vi.mocked(getCustomerMemory).mockRejectedValue("raw failure");
    expect((await bookCalendarAppointment(BIZ, ARGS, "+15485773546")).ok).toBe(true);
  });
});
