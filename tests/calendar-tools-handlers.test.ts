/**
 * Direct tests for the shared calendar cores
 * (src/lib/calendar-tools/handlers.ts) used by the voice adapters and the
 * Rowboat tool webhook.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/voice-tools/connections", () => ({ resolveCalendarConnection: vi.fn() }));
vi.mock("@/lib/workspace/proxy", () => ({
  workspaceProxyForBusiness: vi.fn(),
  workspaceProxyStatusForBusiness: vi.fn()
}));
// Meet defaults OFF here, matching the column default, so every pre-existing
// Google booking assertion in this file keeps describing a Meet-free insert.
// The Meet cases below opt in explicitly.
vi.mock("@/lib/db/businesses", () => ({
  getBusinessTimezone: vi.fn(),
  isGoogleMeetEnabled: vi.fn(async () => false),
  // Hours unset by default, so findCalendarSlots falls back to weekdays
  // 09:00-17:00 exactly as it does for a tenant who never filled them in.
  getBusiness: vi.fn(async () => ({ business_hours: null }))
}));
vi.mock("@/lib/calendar-tools/shared-calendar", () => ({
  mirrorBookingToSharedCalendar: vi.fn(async () => null),
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
vi.mock("@/lib/calendar-tools/acuity", () => ({
  findAcuitySlots: vi.fn(),
  bookAcuityAppointment: vi.fn()
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
vi.mock("@/lib/calendar-tools/attendee-bookings", () => ({
  findUpcomingBookingsForAttendee: vi.fn()
}));
vi.mock("@/lib/calendar-tools/unassigned-booking-alert", () => ({
  maybeAlertUnassignedBooking: vi.fn()
}));
vi.mock("@/lib/calendar-tools/waitlist-resolve", () => ({
  resolveWaitlistAfterBooking: vi.fn()
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
  openRunsWithin,
  formatBookingStartLocal,
  getWorkspaceBusyBlocks,
  wallClockInZone
} from "@/lib/calendar-tools/handlers";
import { resolveCalendarConnection } from "@/lib/voice-tools/connections";
import { resolveWaitlistAfterBooking } from "@/lib/calendar-tools/waitlist-resolve";
import {
  workspaceProxyForBusiness,
  workspaceProxyStatusForBusiness
} from "@/lib/workspace/proxy";
import { isGoogleMeetEnabled } from "@/lib/db/businesses";
import { getBusiness, getBusinessTimezone } from "@/lib/db/businesses";
import {
  ensureSharedCalendar,
  getSharedCalendar,
  mirrorBookingToSharedCalendar
} from "@/lib/calendar-tools/shared-calendar";
import {
  createCalendlyBookingLink,
  findCalendlySlots
} from "@/lib/calendar-tools/calendly";
import { bookVagaroAppointment, findVagaroSlots } from "@/lib/calendar-tools/vagaro";
import { bookAcuityAppointment, findAcuitySlots } from "@/lib/calendar-tools/acuity";
import { bookCaldavAppointment, getCaldavBusyBlocks } from "@/lib/calendar-tools/caldav";
import {
  bookingAttendeeKey,
  claimBookingDedupe,
  confirmBookingDedupe,
  releaseBookingDedupe
} from "@/lib/calendar-tools/booking-dedupe";
import { findUpcomingBookingsForAttendee } from "@/lib/calendar-tools/attendee-bookings";
import { maybeAlertUnassignedBooking } from "@/lib/calendar-tools/unassigned-booking-alert";
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
const ACUITY_CONN = {
  provider: "acuity",
  connectionId: "acuity-row-1",
  providerConfigKey: "acuity"
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
  // Default: nothing mirrored, so the ledger confirm carries a null handle.
  vi.mocked(mirrorBookingToSharedCalendar).mockResolvedValue(null);
  vi.mocked(ensureSharedCalendar).mockResolvedValue(null);
  // Default: dedupe ledger unavailable (fail-open), bookings proceed exactly
  // as before the idempotency guard, which is what the pre-guard tests pin.
  vi.mocked(bookingAttendeeKey).mockReturnValue("key-under-test");
  vi.mocked(claimBookingDedupe).mockResolvedValue(null);
  // Default: the attendee holds no other upcoming booking, the duplicate
  // guard passes through and bookings behave exactly as the pre-guard
  // tests pin.
  vi.mocked(findUpcomingBookingsForAttendee).mockResolvedValue([]);
  vi.mocked(maybeAlertUnassignedBooking).mockResolvedValue("sent_unowned");
  // Default: no stored contact, the model-supplied attendeeName is used, as
  // pre-preferred-name tests pin.
  vi.mocked(getCustomerMemory).mockResolvedValue(null);
  // Default: no Zoom connection, bookings behave exactly as pre-Zoom tests pin.
  vi.mocked(createZoomMeetingForBooking).mockResolvedValue(null);
});

/**
 * Business-hours clipping. Before this, calendar_find_slots would happily
 * offer a customer a 2 AM appointment: it never read the business's hours,
 * and it emitted at most ONE slot per free gap, so a near-empty calendar
 * answered "what is open this week?" with a single odd-hour time.
 *
 * The default (weekdays 09:00-17:00 when hours are unset) is deliberately the
 * SAME default the public booking page uses. The two surfaces both answer
 * "when can I come in?" for one tenant, so they must not disagree.
 */
describe("business hours clipping", () => {
  const HOURS = {
    mon: { open: "09:00", close: "17:00" },
    tue: { open: "09:00", close: "17:00" },
    wed: { open: "09:00", close: "17:00" },
    thu: { open: "09:00", close: "17:00" },
    fri: { open: "09:00", close: "16:00" },
    sat: null,
    sun: null
  };
  const HOUR = 60 * 60 * 1000;
  // 2026-06-12 is a Friday. Phoenix is UTC-7 and never observes DST.
  const utc = (day: number, h: number, m = 0) =>
    new Date(Date.UTC(2026, 5, day, h, m, 0));
  /**
   * Built from parts rather than toLocaleString: the separator between
   * weekday and time varies by ICU build (some emit "Fri 9:00 AM", some
   * "Fri 9:00 AM"), and a slot assertion must not depend on that.
   */
  const phx = (iso: string) => {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Phoenix",
      weekday: "short",
      hour: "numeric",
      minute: "2-digit",
      hour12: true
    }).formatToParts(new Date(iso));
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
    return `${get("weekday")} ${get("hour")}:${get("minute")} ${get("dayPeriod")}`;
  };

  it("refuses a window that sits entirely before opening", () => {
    // 09:00-12:00 UTC is 02:00-05:00 Phoenix. This is the exact bug: the
    // old code offered 02:00 AM.
    const slots = computeFreeSlots(
      utc(12, 9),
      utc(12, 12),
      [],
      HOUR,
      3,
      "America/Phoenix",
      { hours: HOURS, timeZone: "America/Phoenix" }
    );
    expect(slots).toEqual([]);
  });

  it("offers the first open time instead of the requested overnight one", () => {
    // Asking from 02:00 Phoenix Friday through Saturday morning: the only
    // open stretch is Friday 09:00-16:00.
    const slots = computeFreeSlots(
      utc(12, 9),
      utc(13, 9),
      [],
      HOUR,
      3,
      "America/Phoenix",
      { hours: HOURS, timeZone: "America/Phoenix" }
    );
    expect(slots).toHaveLength(1);
    expect(phx(slots[0].startIso)).toBe("Fri 9:00 AM");
  });

  it("spreads offers across days rather than returning one for the whole gap", () => {
    // A completely empty week. The old behaviour was ONE slot, because the
    // whole window is a single gap.
    const slots = computeFreeSlots(
      utc(12, 16),
      utc(17, 23),
      [],
      HOUR,
      3,
      "America/Phoenix",
      { hours: HOURS, timeZone: "America/Phoenix" }
    );
    expect(slots.map((s) => phx(s.startIso))).toEqual([
      "Fri 9:00 AM",
      "Mon 9:00 AM",
      "Tue 9:00 AM"
    ]);
  });

  it("skips closed days entirely", () => {
    // Saturday and Sunday are explicit nulls; the window covers only them.
    const slots = computeFreeSlots(
      utc(13, 16),
      utc(15, 3),
      [],
      HOUR,
      3,
      "America/Phoenix",
      { hours: HOURS, timeZone: "America/Phoenix" }
    );
    expect(slots).toEqual([]);
  });

  it("will not start an appointment that runs past closing", () => {
    // Friday closes at 16:00 Phoenix (23:00 UTC). A 2-hour request cannot
    // start at 15:00, and the last legal start is 14:00.
    const twoHours = 2 * HOUR;
    const slots = computeFreeSlots(
      utc(12, 21), // 14:00 Phoenix
      utc(12, 23), // 16:00 Phoenix
      [],
      twoHours,
      3,
      "America/Phoenix",
      { hours: HOURS, timeZone: "America/Phoenix" }
    );
    expect(slots.map((s) => phx(s.startIso))).toEqual(["Fri 2:00 PM"]);

    const tooLate = computeFreeSlots(
      utc(12, 22), // 15:00 Phoenix, only one hour before close
      utc(12, 23),
      [],
      twoHours,
      3,
      "America/Phoenix",
      { hours: HOURS, timeZone: "America/Phoenix" }
    );
    expect(tooLate).toEqual([]);
  });

  it("still splits around busy blocks inside the open window", () => {
    const busy = [{ start: utc(12, 17), end: utc(12, 18) }]; // 10-11 Phoenix
    const slots = computeFreeSlots(
      utc(12, 16),
      utc(12, 20),
      busy,
      HOUR,
      3,
      "America/Phoenix",
      { hours: HOURS, timeZone: "America/Phoenix" }
    );
    expect(slots.map((s) => phx(s.startIso))).toEqual(["Fri 9:00 AM", "Fri 11:00 AM"]);
  });

  it("leaves behaviour untouched when no hours are supplied", () => {
    // The CalDAV path and every pre-existing caller pass no hours, and must
    // keep the original unclipped walk.
    const slots = computeFreeSlots(utc(12, 9), utc(12, 12), [], HOUR, 3, "America/Phoenix");
    expect(slots).toHaveLength(1);
    expect(phx(slots[0].startIso)).toBe("Fri 2:00 AM");
  });

  it("treats a day whose close precedes its open as closed", () => {
    const broken = { fri: { open: "17:00", close: "09:00" } };
    const slots = computeFreeSlots(
      utc(12, 16),
      utc(12, 23),
      [],
      HOUR,
      3,
      "America/Phoenix",
      { hours: broken, timeZone: "America/Phoenix" }
    );
    expect(slots).toEqual([]);
  });

  describe("openRunsWithin", () => {
    it("returns one run per open stretch, ending at the last legal start", () => {
      const runs = openRunsWithin(utc(12, 16), utc(12, 23), HOURS, HOUR, "America/Phoenix");
      expect(runs).toHaveLength(1);
      expect(phx(runs[0].start.toISOString())).toBe("Fri 9:00 AM");
      // Friday closes at 16:00 Phoenix, so the last 60-minute start is
      // 15:00 and the run ends when that appointment would.
      expect(phx(runs[0].end.toISOString())).toBe("Fri 4:00 PM");
    });

    it("returns nothing when the gap is too short for the appointment", () => {
      expect(
        openRunsWithin(utc(12, 16), utc(12, 16, 30), HOURS, HOUR, "America/Phoenix")
      ).toEqual([]);
    });

    it("stops scanning a pathologically long window", () => {
      // Six weeks of quarter-hours is the runaway guard. A year-long window
      // must return promptly rather than walking 35,000 steps.
      const runs = openRunsWithin(
        utc(12, 16),
        new Date(Date.UTC(2027, 5, 12, 16)),
        HOURS,
        HOUR,
        "America/Phoenix"
      );
      expect(runs.length).toBeGreaterThan(0);
      // Six weeks of weekdays, not a year of them.
      expect(runs.length).toBeLessThan(35);
    });
  });
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

describe("formatBookingStartLocal", () => {
  it("renders the weekday, date, time, and a named timezone", () => {
    expect(formatBookingStartLocal("2026-07-22T16:00:00.000Z", "America/New_York")).toBe(
      "Wednesday, July 22, 2026 at 12:00 PM EDT"
    );
  });

  it("falls back to the raw string rather than throwing on junk input", () => {
    expect(formatBookingStartLocal("not-a-date", "America/New_York")).toBe("not-a-date");
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
    expect(vi.mocked(workspaceProxyForBusiness)).not.toHaveBeenCalled();
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
    expect(vi.mocked(workspaceProxyForBusiness)).not.toHaveBeenCalled();
    expect(vi.mocked(getSharedCalendar)).not.toHaveBeenCalled();
  });

  it("delegates an Acuity connection to findAcuitySlots with the resolved timezone", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(ACUITY_CONN);
    const delegated = { ok: true, data: { slots: [], provider: "acuity" } };
    vi.mocked(findAcuitySlots).mockResolvedValue(delegated as never);
    const result = await findCalendarSlots(BIZ, { durationMinutes: 30 });
    expect(result).toBe(delegated);
    const passed = vi.mocked(findAcuitySlots).mock.calls[0][1];
    expect(passed).toMatchObject({ durationMinutes: 30, timezone: "UTC" });
    expect(vi.mocked(workspaceProxyForBusiness)).not.toHaveBeenCalled();
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
    expect(vi.mocked(workspaceProxyForBusiness)).not.toHaveBeenCalled();
    expect(vi.mocked(getSharedCalendar)).not.toHaveBeenCalled();
  });

  it("falls back to 9-to-5 when the business row cannot be read", async () => {
    // Fail-safe direction matters: an unreadable row must mean "assume
    // normal working hours", never "no constraint". The latter is how a
    // customer gets offered 2 AM.
    vi.mocked(getBusiness).mockRejectedValueOnce(new Error("db down"));
    vi.mocked(resolveCalendarConnection).mockResolvedValue(GOOGLE_CONN);
    vi.mocked(workspaceProxyForBusiness).mockResolvedValue({
      data: { calendars: { primary: { busy: [] } } }
    } as never);
    const result = await findCalendarSlots(BIZ, {
      // 02:00-05:00 Phoenix on a Friday.
      earliest: "2026-06-12T09:00:00.000Z",
      latest: "2026-06-12T12:00:00.000Z",
      durationMinutes: 60,
      timezone: "America/Phoenix"
    });
    expect(result.ok).toBe(true);
    expect((result.data as { slots: unknown[] }).slots).toEqual([]);
  });

  it("honours hours the owner actually set, over the default", async () => {
    vi.mocked(getBusiness).mockResolvedValueOnce({
      business_hours: { fri: { open: "06:00", close: "20:00" } }
    } as never);
    vi.mocked(resolveCalendarConnection).mockResolvedValue(GOOGLE_CONN);
    vi.mocked(workspaceProxyForBusiness).mockResolvedValue({
      data: { calendars: { primary: { busy: [] } } }
    } as never);
    const result = await findCalendarSlots(BIZ, {
      // 07:00-09:00 Phoenix: before the 9-to-5 default, inside a 6 AM open.
      earliest: "2026-06-12T14:00:00.000Z",
      latest: "2026-06-12T16:00:00.000Z",
      durationMinutes: 60,
      timezone: "America/Phoenix"
    });
    expect(result.ok).toBe(true);
    expect((result.data as { slots: unknown[] }).slots).toHaveLength(1);
  });

  it("clips hours in the BUSINESS zone even when the model asks for another", async () => {
    // The bug this pins: resolveToolTimezone prefers the model's `timezone`
    // argument, which on a call routed from another region is the CUSTOMER's
    // zone. Opening hours are stored in the owner's clock, so evaluating
    // them in the caller's clock shifts the whole window.
    //
    // 22:00-23:00 UTC is 15:00-16:00 in Phoenix (open, 9-5) but 18:00-19:00
    // in New York (shut). A Phoenix business must still offer it.
    vi.mocked(getBusiness).mockResolvedValueOnce({
      timezone: "America/Phoenix",
      business_hours: { fri: { open: "09:00", close: "17:00" } }
    } as never);
    vi.mocked(resolveCalendarConnection).mockResolvedValue(GOOGLE_CONN);
    vi.mocked(workspaceProxyForBusiness).mockResolvedValue({
      data: { calendars: { primary: { busy: [] } } }
    } as never);
    const result = await findCalendarSlots(BIZ, {
      earliest: "2026-06-12T22:00:00.000Z",
      latest: "2026-06-12T23:00:00.000Z",
      durationMinutes: 60,
      timezone: "America/New_York"
    });
    expect(result.ok).toBe(true);
    expect((result.data as { slots: unknown[] }).slots).toHaveLength(1);
  });

  it("computes slots from Google FreeBusy", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(GOOGLE_CONN);
    vi.mocked(workspaceProxyForBusiness).mockResolvedValue({
      data: {
        calendars: {
          primary: {
            busy: [{ start: "2026-06-12T17:00:00.000Z", end: "2026-06-12T18:00:00.000Z" }]
          }
        }
      }
    } as never);
    // 16:00-19:00 UTC is 09:00-12:00 in Phoenix (UTC-7), i.e. inside the
    // 9-to-5 default. Do NOT "simplify" these back to 09:00-12:00 UTC: that
    // is 02:00-05:00 local, and the whole point of the business-hours clip
    // is that we no longer offer it.
    const result = await findCalendarSlots(BIZ, {
      earliest: "2026-06-12T16:00:00.000Z",
      latest: "2026-06-12T19:00:00.000Z",
      durationMinutes: 60,
      timezone: "America/Phoenix",
      purpose: "estimate"
    });
    expect(result.ok).toBe(true);
    const data = result.data as { slots: unknown[]; timezone: string; purpose: string };
    expect(data.slots).toHaveLength(2);
    expect(data.timezone).toBe("America/Phoenix");
    expect(data.purpose).toBe("estimate");
    expect(vi.mocked(workspaceProxyForBusiness)).toHaveBeenCalledWith(
      BIZ,
      { connectionId: "conn-1", providerConfigKey: "google-calendar" },
      expect.objectContaining({ endpoint: "/calendar/v3/freeBusy" })
    );
  });

  it("tolerates a FreeBusy body with calendars missing busy arrays", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(GOOGLE_CONN);
    vi.mocked(workspaceProxyForBusiness).mockResolvedValue({
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
    vi.mocked(workspaceProxyForBusiness).mockResolvedValue(null as never);
    const result = await findCalendarSlots(BIZ, { durationMinutes: 30 });
    expect(result).toEqual({ ok: false, detail: "calendar_not_connected" });
  });

  it("computes slots from Microsoft getSchedule, filtering malformed items", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(MS_CONN);
    vi.mocked(workspaceProxyForBusiness).mockResolvedValue({
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
    expect(vi.mocked(workspaceProxyForBusiness)).toHaveBeenCalledWith(
      BIZ,
      { connectionId: "conn-2", providerConfigKey: "microsoft-calendar" },
      expect.objectContaining({ endpoint: "/v1.0/me/calendar/getSchedule" })
    );
  });

  it("tolerates an empty Graph schedule body", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(MS_CONN);
    vi.mocked(workspaceProxyForBusiness).mockResolvedValue({ data: {} } as never);
    const result = await findCalendarSlots(BIZ, { durationMinutes: 30 });
    expect(result.ok).toBe(true);
  });

  it("treats a null Microsoft proxy response as not connected", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(MS_CONN);
    vi.mocked(workspaceProxyForBusiness).mockResolvedValue(null as never);
    const result = await findCalendarSlots(BIZ, { durationMinutes: 30 });
    expect(result).toEqual({ ok: false, detail: "calendar_not_connected" });
  });

  it("falls back to the default window for malformed earliest/latest strings", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(GOOGLE_CONN);
    vi.mocked(workspaceProxyForBusiness).mockResolvedValue({ data: {} } as never);
    const result = await findCalendarSlots(BIZ, {
      earliest: "not a date",
      latest: "also not a date",
      durationMinutes: 30
    });
    expect(result.ok).toBe(true);
  });

  it("maps proxy failures to calendar_lookup_failed", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(GOOGLE_CONN);
    vi.mocked(workspaceProxyForBusiness).mockRejectedValue(new Error("nango 502"));
    const result = await findCalendarSlots(BIZ, { durationMinutes: 30 });
    expect(result).toEqual({ ok: false, detail: "calendar_lookup_failed" });
  });

  it("defaults the echoed timezone to the business timezone when the model omits one", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(GOOGLE_CONN);
    vi.mocked(workspaceProxyForBusiness).mockResolvedValue({ data: {} } as never);
    vi.mocked(getBusinessTimezone).mockResolvedValue("America/Denver");
    const result = await findCalendarSlots(BIZ, { durationMinutes: 30 });
    expect(result.ok).toBe(true);
    expect((result.data as { timezone: string }).timezone).toBe("America/Denver");
  });

  it("degrades the timezone default to UTC when the business lookup throws", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(GOOGLE_CONN);
    vi.mocked(workspaceProxyForBusiness).mockResolvedValue({ data: {} } as never);
    vi.mocked(getBusinessTimezone).mockRejectedValue(new Error("db down"));
    const result = await findCalendarSlots(BIZ, { durationMinutes: 30 });
    expect(result.ok).toBe(true);
    expect((result.data as { timezone: string }).timezone).toBe("UTC");
  });

  it("echoes UTC when neither the model nor the business provides a timezone", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(GOOGLE_CONN);
    vi.mocked(workspaceProxyForBusiness).mockResolvedValue({ data: {} } as never);
    const result = await findCalendarSlots(BIZ, { durationMinutes: 30 });
    expect(result.ok).toBe(true);
    expect((result.data as { timezone: string }).timezone).toBe("UTC");
  });

  it("rejects a non-IANA explicit timezone in favor of the business zone", async () => {
    // Models sometimes send abbreviations ("EDT") that Intl can't resolve;
    // silently using them would blow up the wall-clock conversion later.
    vi.mocked(resolveCalendarConnection).mockResolvedValue(GOOGLE_CONN);
    vi.mocked(workspaceProxyForBusiness).mockResolvedValue({ data: {} } as never);
    vi.mocked(getBusinessTimezone).mockResolvedValue("America/Toronto");
    const result = await findCalendarSlots(BIZ, { durationMinutes: 30, timezone: "EDT" });
    expect(result.ok).toBe(true);
    expect((result.data as { timezone: string }).timezone).toBe("America/Toronto");
  });

  it("degrades to UTC when the stored business timezone is itself invalid", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(GOOGLE_CONN);
    vi.mocked(workspaceProxyForBusiness).mockResolvedValue({ data: {} } as never);
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
    vi.mocked(workspaceProxyForBusiness).mockResolvedValue({
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
    const payload = vi.mocked(workspaceProxyForBusiness).mock.calls[0][2] as {
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
    vi.mocked(workspaceProxyForBusiness)
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
    expect(vi.mocked(workspaceProxyForBusiness)).toHaveBeenCalledWith(
      BIZ,
      { connectionId: "conn-2", providerConfigKey: "microsoft-calendar" },
      expect.objectContaining({
        endpoint: "/v1.0/me/calendars/shared-ms/calendarView",
        method: "GET"
      })
    );
  });

  it("refuses to offer slots from an incomplete busy read", async () => {
    // Unlike the booking page, this tool has no ledger or cached snapshot to
    // union underneath a partial answer. Offering from an under-report means
    // offering a time that is free only because its event went unread, so it
    // declines instead and the coworker says it cannot check the calendar.
    vi.mocked(resolveCalendarConnection).mockResolvedValue(MS_CONN);
    vi.mocked(getSharedCalendar).mockResolvedValue(null as never);
    vi.mocked(workspaceProxyForBusiness).mockResolvedValue({
      status: 200,
      data: {
        value: [
          {
            start: { dateTime: "2026-06-12T10:00:00" },
            end: { dateTime: "2026-06-12T11:00:00" }
          }
        ],
        "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/calendarView?$skiptoken=X"
      }
    } as never);
    // Force the calendarView path: getSchedule rejected by a personal account.
    vi.mocked(workspaceProxyForBusiness).mockRejectedValueOnce(
      Object.assign(new Error("Provider request failed (403)"), { response: { status: 403 } })
    );

    const result = await findCalendarSlots(BIZ, { durationMinutes: 30 });

    expect(result.ok).toBe(false);
    expect((result as { detail: string }).detail).toBe("calendar_lookup_failed");
  });

  it("refuses to offer slots when the Microsoft shared calendar cannot be read", async () => {
    // This asserted `ok: true` from #149 (Jun 2026) until the direct transport
    // landed, and the flip is deliberate. Back then a null second response was
    // unreachable: null meant "no such connection", and the getSchedule call
    // just before it succeeded on that same connection. Tolerating an
    // impossible case cost nothing.
    //
    // src/lib/workspace/proxy.ts now documents null as ALSO covering "the
    // connection exists but its token is unusable", so a grant dying between
    // the two calls is real. Tolerating it means computing availability from
    // half the data, and the missing half is the shared calendar, where our own
    // bookings live. Fail closed: a missed booking is visible and recoverable,
    // a double-booked customer is neither.
    vi.mocked(resolveCalendarConnection).mockResolvedValue(MS_CONN);
    vi.mocked(getSharedCalendar).mockResolvedValue({
      calendarId: "shared-ms",
      conn: MS_CONN
    } as never);
    vi.mocked(workspaceProxyForBusiness)
      .mockResolvedValueOnce({ data: {} } as never)
      .mockResolvedValueOnce(null as never);
    const result = await findCalendarSlots(BIZ, { durationMinutes: 30 });
    expect(result.ok).toBe(false);
    expect((result as { detail: string }).detail).toBe("calendar_not_connected");
  });
});

describe("bookCalendarAppointment, unassigned-booking owner alert (Truly, Jul 21 2026)", () => {
  const ARGS = {
    startIso: "2026-06-12T17:00:00.000Z",
    endIso: "2026-06-12T17:30:00.000Z",
    summary: "Estimate",
    attendeeName: "Joe Plumber"
  };

  function confirmGoogleCreate() {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(GOOGLE_CONN);
    vi.mocked(workspaceProxyForBusiness).mockResolvedValue({
      data: { id: "ev-1", htmlLink: "https://cal/ev-1" }
    } as never);
  }

  it("a confirmed create on a customer surface fires the alert with the booked details", async () => {
    confirmGoogleCreate();
    await bookCalendarAppointment(
      BIZ,
      { ...ARGS, attendeeEmail: "joe@example.com" },
      "+16136067906",
      { alertSurface: "sms" }
    );
    expect(maybeAlertUnassignedBooking).toHaveBeenCalledWith(BIZ, {
      attendeeName: "Joe Plumber",
      attendeePhone: "+16136067906",
      attendeeEmail: "joe@example.com",
      startIso: "2026-06-12T17:00:00.000Z",
      startLocal: "Friday, June 12, 2026 at 5:00 PM UTC",
      summary: "Estimate",
      eventId: "ev-1",
      surface: "sms"
    });
  });

  it("no alertSurface (owner-initiated surfaces) fires nothing", async () => {
    confirmGoogleCreate();
    await bookCalendarAppointment(BIZ, ARGS, "+16136067906");
    expect(maybeAlertUnassignedBooking).not.toHaveBeenCalled();
  });

  it("an already_booked dedupe retry never re-alerts", async () => {
    vi.mocked(claimBookingDedupe).mockResolvedValue({ kind: "duplicate", eventId: "evt-prior" });
    const result = await bookCalendarAppointment(BIZ, ARGS, "+16136067906", {
      alertSurface: "voice"
    });
    expect(result.detail).toBe("already_booked");
    expect(maybeAlertUnassignedBooking).not.toHaveBeenCalled();
  });

  it("failures and no-event results fire nothing", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(null as never);
    await bookCalendarAppointment(BIZ, ARGS, null, { alertSurface: "webchat" });
    expect(maybeAlertUnassignedBooking).not.toHaveBeenCalled();
  });

  it("a Calendly booking-link result (ok, no event) fires nothing", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(CALENDLY_CONN);
    vi.mocked(createCalendlyBookingLink).mockResolvedValue({
      ok: true,
      detail: "booking_link_created",
      data: { bookingLink: "https://calendly.com/x/abc" }
    } as never);
    const result = await bookCalendarAppointment(BIZ, ARGS, null, { alertSurface: "sms" });
    expect(result.ok).toBe(true);
    expect(maybeAlertUnassignedBooking).not.toHaveBeenCalled();
  });

  it("a phoneless, emailless confirmed create alerts with null identities", async () => {
    confirmGoogleCreate();
    await bookCalendarAppointment(BIZ, ARGS, null, { alertSurface: "voice" });
    expect(maybeAlertUnassignedBooking).toHaveBeenCalledWith(
      BIZ,
      expect.objectContaining({ attendeePhone: null, attendeeEmail: null, surface: "voice" })
    );
  });

  it("a whitespace-only attendeeEmail alerts with a null email identity", async () => {
    confirmGoogleCreate();
    await bookCalendarAppointment(BIZ, { ...ARGS, attendeeEmail: "  " }, null, {
      alertSurface: "sms"
    });
    expect(maybeAlertUnassignedBooking).toHaveBeenCalledWith(
      BIZ,
      expect.objectContaining({ attendeeEmail: null })
    );
  });

  it("a dataless ok result fires nothing (defensive shape)", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(VAGARO_CONN);
    vi.mocked(bookVagaroAppointment).mockResolvedValue({ ok: true } as never);
    await bookCalendarAppointment(BIZ, ARGS, null, { alertSurface: "sms" });
    expect(maybeAlertUnassignedBooking).not.toHaveBeenCalled();
  });
});

describe("bookCalendarAppointment, attendee duplicate guard (Truly double-booking, Jul 21 2026)", () => {
  const ARGS = {
    startIso: "2026-06-12T17:00:00.000Z",
    endIso: "2026-06-12T17:30:00.000Z",
    summary: "Estimate",
    attendeeName: "Joe Plumber"
  };
  const FUTURE_OTHER = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
  const otherBooking = (over: Record<string, unknown> = {}) => ({
    provider: "ledger" as const,
    source: "platform" as const,
    eventId: "evt-existing",
    startIso: FUTURE_OTHER,
    name: null,
    rescheduled: false,
    ...over
  });

  it("refuses with attendee_already_booked when the attendee holds a DIFFERENT upcoming slot", async () => {
    vi.mocked(findUpcomingBookingsForAttendee).mockResolvedValue([otherBooking()]);
    const result = await bookCalendarAppointment(
      BIZ,
      { ...ARGS, attendeeEmail: "Joe@Acme.com" },
      "+16136067906"
    );
    expect(result.ok).toBe(false);
    expect(result.detail).toBe("attendee_already_booked");
    expect(result.data).toMatchObject({
      existingEventId: "evt-existing",
      existingStartIso: FUTURE_OTHER,
      existingProvider: "ledger"
    });
    // The model-facing guidance carries the existing slot's human-readable
    // time and the keep/move/cancel + allowAdditional recovery.
    expect(result.message).toContain("already has an upcoming appointment");
    expect(result.message).toContain("calendar_reschedule_appointment");
    expect(result.message).toContain("allowAdditional");
    expect((result.data as { existingStartLocal: string }).existingStartLocal).toMatch(/\d{4} at \d{1,2}:\d{2} (AM|PM)/);
    // Refused BEFORE the ledger claim or any provider call.
    expect(vi.mocked(claimBookingDedupe)).not.toHaveBeenCalled();
    expect(vi.mocked(resolveCalendarConnection)).not.toHaveBeenCalled();
    // The lookup used the caller phone fallback + normalized email identity.
    expect(vi.mocked(findUpcomingBookingsForAttendee)).toHaveBeenCalledWith(
      BIZ,
      { phones: ["+16136067906"], email: "joe@acme.com", name: "Joe Plumber" },
      {},
      { mode: "detail" }
    );
  });

  it("allowAdditional bypasses the guard entirely", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(null as never);
    const result = await bookCalendarAppointment(BIZ, { ...ARGS, allowAdditional: true });
    expect(vi.mocked(findUpcomingBookingsForAttendee)).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: false, detail: "calendar_not_connected" });
  });

  it("the exact same slot falls through to the idempotency ledger (timeout retries stay already_booked)", async () => {
    vi.mocked(findUpcomingBookingsForAttendee).mockResolvedValue([
      otherBooking({ startIso: ARGS.startIso, eventId: "evt-same" })
    ]);
    vi.mocked(claimBookingDedupe).mockResolvedValue({ kind: "duplicate", eventId: "evt-same" });
    const result = await bookCalendarAppointment(BIZ, ARGS);
    expect(result.ok).toBe(true);
    expect(result.detail).toBe("already_booked");
  });

  it("a retry of ONE of multiple held slots is still a retry, other slots never trip the guard (Bugbot on PR #824)", async () => {
    // The attendee legitimately holds TWO upcoming slots (allowAdditional);
    // a timeout retry repeats one of them exactly. The other slot must not
    // convert the retry into attendee_already_booked.
    vi.mocked(findUpcomingBookingsForAttendee).mockResolvedValue([
      otherBooking({ startIso: FUTURE_OTHER, eventId: "evt-other" }),
      otherBooking({ startIso: ARGS.startIso, eventId: "evt-same" })
    ]);
    vi.mocked(claimBookingDedupe).mockResolvedValue({ kind: "duplicate", eventId: "evt-same" });
    const result = await bookCalendarAppointment(BIZ, ARGS);
    expect(result.ok).toBe(true);
    expect(result.detail).toBe("already_booked");
  });

  it("ignores past-start and unparseable-start lookup rows (no phantom refusals)", async () => {
    vi.mocked(findUpcomingBookingsForAttendee).mockResolvedValue([
      otherBooking({ startIso: new Date(Date.now() - 60_000).toISOString() }),
      otherBooking({ startIso: "" })
    ]);
    vi.mocked(resolveCalendarConnection).mockResolvedValue(null as never);
    const result = await bookCalendarAppointment(BIZ, ARGS);
    expect(result).toEqual({ ok: false, detail: "calendar_not_connected" });
  });

  it("a phoneless, emailless booking still consults the guard with the name key", async () => {
    vi.mocked(findUpcomingBookingsForAttendee).mockResolvedValue([]);
    vi.mocked(resolveCalendarConnection).mockResolvedValue(null as never);
    await bookCalendarAppointment(BIZ, ARGS);
    expect(vi.mocked(findUpcomingBookingsForAttendee)).toHaveBeenCalledWith(
      BIZ,
      { phones: [], email: null, name: "Joe Plumber" },
      {},
      { mode: "detail" }
    );
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
    // Zoom join link can be merged into the data when one exists. CalDAV
    // events email nobody, so inviteEmail is pinned null. Every confirmed
    // booking carries startLocal, the human-readable start the model must
    // read back verbatim (Truly mislabeled-day incident, Jul 21 2026).
    expect(result).toStrictEqual({
      ok: true,
      data: {
        eventId: "newcoworker-1",
        provider: "caldav",
        inviteEmail: null,
        startLocal: "Friday, June 12, 2026 at 5:00 PM UTC"
      }
    });
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
    expect(vi.mocked(workspaceProxyForBusiness)).not.toHaveBeenCalled();
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
    expect(result).toEqual({
      ok: true,
      data: {
        eventId: "appt-1",
        provider: "vagaro",
        startLocal: "Friday, June 12, 2026 at 5:00 PM UTC"
      }
    });
    expect(vi.mocked(bookVagaroAppointment)).toHaveBeenCalledWith(BIZ, ARGS, "+15551230000");
    expect(vi.mocked(workspaceProxyForBusiness)).not.toHaveBeenCalled();
    expect(vi.mocked(ensureSharedCalendar)).not.toHaveBeenCalled();
    // A real Vagaro booking fires the appointment_booked goal for the lead.
    expect(vi.mocked(fireGoalEvent)).toHaveBeenCalledWith(BIZ, "+15551230000", {
      kind: "appointment_booked"
    });
  });

  it("mirrors a Vagaro booking onto the team calendar and stores the handle", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(VAGARO_CONN);
    vi.mocked(bookVagaroAppointment).mockResolvedValue({
      ok: true,
      data: { eventId: "appt-1", provider: "vagaro" }
    } as never);
    // The mirror handle lives on the ledger row, so mirroring only happens
    // when there is a claim to store it against: an unmanageable mirror is
    // exactly what this feature must not create.
    vi.mocked(claimBookingDedupe).mockResolvedValue({ kind: "claimed", id: "claim-9" } as never);
    vi.mocked(mirrorBookingToSharedCalendar).mockResolvedValueOnce("mirror-1" as never);
    await bookCalendarAppointment(BIZ, ARGS, "+15551230000");
    expect(vi.mocked(mirrorBookingToSharedCalendar)).toHaveBeenCalledWith(
      BIZ,
      "vagaro",
      expect.objectContaining({ summary: ARGS.summary, attendeePhone: "+15551230000" })
    );
    // The handle rides the ledger row so reschedule/cancel can keep it in step.
    expect(vi.mocked(confirmBookingDedupe)).toHaveBeenCalledWith("claim-9", "appt-1", {
      zoomMeetingId: null,
      sharedCalendarEventId: "mirror-1",
      meetJoinUrl: null
    });
  });

  it("mirrors with the model's own attendee phone when it supplied one", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(VAGARO_CONN);
    vi.mocked(bookVagaroAppointment).mockResolvedValue({
      ok: true,
      data: { eventId: "appt-2", provider: "vagaro" }
    } as never);
    vi.mocked(claimBookingDedupe).mockResolvedValue({ kind: "claimed", id: "claim-8" } as never);
    await bookCalendarAppointment(
      BIZ,
      { ...ARGS, attendeePhone: "+15559999999", notes: "back entrance" },
      "+15551230000"
    );
    expect(vi.mocked(mirrorBookingToSharedCalendar)).toHaveBeenCalledWith(
      BIZ,
      "vagaro",
      expect.objectContaining({ attendeePhone: "+15559999999", notes: "back entrance" })
    );
  });

  it("mirrors with a null phone when neither the model nor the surface has one", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(VAGARO_CONN);
    vi.mocked(bookVagaroAppointment).mockResolvedValue({
      ok: true,
      data: { eventId: "appt-4", provider: "vagaro" }
    } as never);
    vi.mocked(claimBookingDedupe).mockResolvedValue({ kind: "claimed", id: "claim-6" } as never);
    await bookCalendarAppointment(BIZ, ARGS);
    expect(vi.mocked(mirrorBookingToSharedCalendar)).toHaveBeenCalledWith(
      BIZ,
      "vagaro",
      expect.objectContaining({ attendeePhone: null })
    );
  });

  it("passes an empty provider when the result does not name one", async () => {
    // bookingNeedsSharedCalendarMirror then answers false, so nothing is
    // mirrored rather than mirrored against an unknown provider.
    vi.mocked(resolveCalendarConnection).mockResolvedValue(VAGARO_CONN);
    vi.mocked(bookVagaroAppointment).mockResolvedValue({
      ok: true,
      data: { eventId: "appt-3" }
    } as never);
    vi.mocked(claimBookingDedupe).mockResolvedValue({ kind: "claimed", id: "claim-7" } as never);
    await bookCalendarAppointment(BIZ, ARGS, "+15551230000");
    expect(vi.mocked(mirrorBookingToSharedCalendar)).toHaveBeenCalledWith(
      BIZ,
      "",
      expect.anything()
    );
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

  it("delegates an Acuity connection to bookAcuityAppointment with a resolved timezone", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(ACUITY_CONN);
    const delegated = { ok: true, data: { eventId: "appt-9", provider: "acuity" } };
    vi.mocked(bookAcuityAppointment).mockResolvedValue(delegated as never);
    const result = await bookCalendarAppointment(BIZ, ARGS, "+15551230000");
    expect(result).toMatchObject({ ok: true, data: { eventId: "appt-9", provider: "acuity" } });
    expect(vi.mocked(bookAcuityAppointment)).toHaveBeenCalledWith(
      BIZ,
      { ...ARGS, timezone: "UTC" },
      "+15551230000"
    );
    expect(vi.mocked(workspaceProxyForBusiness)).not.toHaveBeenCalled();
    // Acuity is in-person scheduling: no shared calendar, no Zoom decoration.
    expect(vi.mocked(ensureSharedCalendar)).not.toHaveBeenCalled();
    expect(vi.mocked(fireGoalEvent)).toHaveBeenCalledWith(BIZ, "+15551230000", {
      kind: "appointment_booked"
    });
  });

  it("a failed Acuity booking fires no goal event", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(ACUITY_CONN);
    vi.mocked(bookAcuityAppointment).mockResolvedValue({
      ok: false,
      detail: "acuity_slot_taken"
    } as never);
    await bookCalendarAppointment(BIZ, ARGS, "+15551230000");
    expect(vi.mocked(fireGoalEvent)).not.toHaveBeenCalled();
  });

  it("a success-shaped Acuity response WITHOUT an appointment id fires no goal event", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(ACUITY_CONN);
    vi.mocked(bookAcuityAppointment).mockResolvedValue({
      ok: true,
      data: { provider: "acuity" }
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
    expect(vi.mocked(workspaceProxyForBusiness)).not.toHaveBeenCalled();
    expect(vi.mocked(ensureSharedCalendar)).not.toHaveBeenCalled();
    // A scheduling LINK is not a booking, no goal event.
    expect(vi.mocked(fireGoalEvent)).not.toHaveBeenCalled();
  });

  it("books a Google event with attendee email + caller-phone fallback", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(GOOGLE_CONN);
    vi.mocked(workspaceProxyForBusiness).mockResolvedValue({
      data: { id: "ev-1", htmlLink: "https://cal/ev-1" }
    } as never);
    const result = await bookCalendarAppointment(
      BIZ,
      { ...ARGS, attendeeEmail: "joe@example.com", notes: "gate code 1234", timezone: "America/Phoenix" },
      "+15551230000"
    );
    expect(result).toEqual({
      ok: true,
      data: {
        eventId: "ev-1",
        htmlLink: "https://cal/ev-1",
        provider: "google",
        calendar: "primary",
        inviteEmail: "joe@example.com",
        startLocal: "Friday, June 12, 2026 at 10:00 AM MST"
      }
    });
    const payload = vi.mocked(workspaceProxyForBusiness).mock.calls[0][2] as {
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

  it("a fresh CONFIRMED create resolves the attendee's waitlist entries; a no-event result never does", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(GOOGLE_CONN);
    vi.mocked(workspaceProxyForBusiness).mockResolvedValue({ data: { id: "ev-1" } } as never);
    await bookCalendarAppointment(
      BIZ,
      { ...ARGS, attendeeEmail: "joe@example.com" },
      "+15551230000"
    );
    expect(vi.mocked(resolveWaitlistAfterBooking)).toHaveBeenCalledWith(
      BIZ,
      { phones: ["+15551230000"], email: "joe@example.com" },
      new Date(ARGS.startIso).toISOString()
    );

    vi.mocked(resolveWaitlistAfterBooking).mockClear();
    vi.mocked(workspaceProxyForBusiness).mockResolvedValue({ data: {} } as never);
    await bookCalendarAppointment(BIZ, ARGS);
    expect(vi.mocked(resolveWaitlistAfterBooking)).not.toHaveBeenCalled();
  });

  it("prefers the explicit attendeePhone over the fallback", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(GOOGLE_CONN);
    vi.mocked(workspaceProxyForBusiness).mockResolvedValue({ data: { id: "ev-2" } } as never);
    await bookCalendarAppointment(BIZ, { ...ARGS, attendeePhone: "+15559998888" }, "+15551230000");
    const payload = vi.mocked(workspaceProxyForBusiness).mock.calls[0][2] as {
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
    vi.mocked(workspaceProxyForBusiness).mockResolvedValue({ data: {} } as never);
    const result = await bookCalendarAppointment(BIZ, ARGS);
    expect(result).toEqual({
      ok: true,
      data: { eventId: null, htmlLink: null, provider: "google", calendar: "primary", inviteEmail: null }
    });
    // No confirmed event id → no appointment_booked goal event.
    expect(vi.mocked(fireGoalEvent)).not.toHaveBeenCalled();
    const payload = vi.mocked(workspaceProxyForBusiness).mock.calls[0][2] as {
      data: { description: string; attendees?: unknown };
    };
    expect(payload.data.description).toBe("Attendee: Joe Plumber");
    expect(payload.data.attendees).toBeUndefined();
  });

  it("treats a null Google proxy response as not connected", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(GOOGLE_CONN);
    vi.mocked(workspaceProxyForBusiness).mockResolvedValue(null as never);
    const result = await bookCalendarAppointment(BIZ, ARGS);
    expect(result).toEqual({ ok: false, detail: "calendar_not_connected" });
  });

  it("books in the business timezone when the model omits one", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(GOOGLE_CONN);
    vi.mocked(workspaceProxyForBusiness).mockResolvedValue({ data: { id: "ev-tz" } } as never);
    vi.mocked(getBusinessTimezone).mockResolvedValue("America/Chicago");
    await bookCalendarAppointment(BIZ, ARGS);
    const payload = vi.mocked(workspaceProxyForBusiness).mock.calls[0][2] as {
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
    vi.mocked(workspaceProxyForBusiness).mockResolvedValue({ data: { id: "ev-off" } } as never);
    const result = await bookCalendarAppointment(BIZ, {
      ...ARGS,
      startIso: "2026-06-12T13:00:00-04:00",
      endIso: "2026-06-12T13:30:00-04:00",
      timezone: "America/Toronto"
    });
    expect(result.ok).toBe(true);
    const payload = vi.mocked(workspaceProxyForBusiness).mock.calls[0][2] as {
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
    vi.mocked(workspaceProxyForBusiness).mockResolvedValue({ data: { id: "ms-off" } } as never);
    const result = await bookCalendarAppointment(BIZ, {
      ...ARGS,
      startIso: "2026-06-12T13:00:00-04:00",
      endIso: "2026-06-12T13:30:00-04:00",
      timezone: "America/Toronto"
    });
    expect(result.ok).toBe(true);
    const payload = vi.mocked(workspaceProxyForBusiness).mock.calls[0][2] as {
      data: { start: { dateTime: string; timeZone: string }; end: { dateTime: string } };
    };
    expect(payload.data.start.dateTime).toBe("2026-06-12T13:00:00");
    expect(payload.data.end.dateTime).toBe("2026-06-12T13:30:00");
    expect(payload.data.start.timeZone).toBe("America/Toronto");
  });

  it("books a Microsoft event, falling back to the summary for an empty body", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(MS_CONN);
    vi.mocked(workspaceProxyForBusiness).mockResolvedValue({
      data: { id: "ms-1", webLink: "https://outlook/ms-1" }
    } as never);
    const result = await bookCalendarAppointment(BIZ, {
      ...ARGS,
      attendeeEmail: "joe@example.com"
    });
    expect(result).toEqual({
      ok: true,
      data: {
        eventId: "ms-1",
        htmlLink: "https://outlook/ms-1",
        provider: "microsoft",
        calendar: "primary",
        inviteEmail: "joe@example.com",
        startLocal: "Friday, June 12, 2026 at 5:00 PM UTC"
      }
    });
    const payload = vi.mocked(workspaceProxyForBusiness).mock.calls[0][2] as {
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
    vi.mocked(workspaceProxyForBusiness).mockResolvedValue({ data: {} } as never);
    const result = await bookCalendarAppointment(BIZ, ARGS);
    expect(result).toEqual({
      ok: true,
      data: { eventId: null, htmlLink: null, provider: "microsoft", calendar: "primary", inviteEmail: null }
    });
    const payload = vi.mocked(workspaceProxyForBusiness).mock.calls[0][2] as {
      data: { attendees?: unknown };
    };
    expect(payload.data.attendees).toBeUndefined();
  });

  it("treats a null Microsoft proxy response as not connected", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(MS_CONN);
    vi.mocked(workspaceProxyForBusiness).mockResolvedValue(null as never);
    const result = await bookCalendarAppointment(BIZ, ARGS);
    expect(result).toEqual({ ok: false, detail: "calendar_not_connected" });
  });

  it("maps proxy failures to calendar_book_failed", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(GOOGLE_CONN);
    vi.mocked(workspaceProxyForBusiness).mockRejectedValue(new Error("nango 502"));
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
    vi.mocked(workspaceProxyForBusiness).mockResolvedValue({ data: { id: "ev-s" } } as never);
    const result = await bookCalendarAppointment(BIZ, ARGS);
    expect(result).toEqual({
      ok: true,
      data: {
        eventId: "ev-s",
        htmlLink: null,
        provider: "google",
        calendar: "shared",
        inviteEmail: null,
        startLocal: "Friday, June 12, 2026 at 5:00 PM UTC"
      }
    });
    const payload = vi.mocked(workspaceProxyForBusiness).mock.calls[0][2] as { endpoint: string };
    expect(payload.endpoint).toBe("/calendar/v3/calendars/shared-cal/events");
  });

  it("books Microsoft events onto the shared NewCoworker calendar when available", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(MS_CONN);
    vi.mocked(ensureSharedCalendar).mockResolvedValue({
      calendarId: "shared-ms",
      conn: MS_CONN
    } as never);
    vi.mocked(workspaceProxyForBusiness).mockResolvedValue({ data: { id: "ms-s" } } as never);
    const result = await bookCalendarAppointment(BIZ, ARGS);
    expect(result).toEqual({
      ok: true,
      data: {
        eventId: "ms-s",
        htmlLink: null,
        provider: "microsoft",
        calendar: "shared",
        inviteEmail: null,
        startLocal: "Friday, June 12, 2026 at 5:00 PM UTC"
      }
    });
    const payload = vi.mocked(workspaceProxyForBusiness).mock.calls[0][2] as { endpoint: string };
    expect(payload.endpoint).toBe("/v1.0/me/calendars/shared-ms/events");
  });
});

describe("bookCalendarAppointment, retry idempotency guard (2026-07-13 quadruple-booking incident)", () => {
  const ARGS = {
    startIso: "2026-06-12T17:00:00.000Z",
    endIso: "2026-06-12T17:30:00.000Z",
    summary: "Estimate",
    attendeeName: "Joe Plumber"
  };

  it("claims the slot with the attendee key (explicit phone over fallback) and start instant", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(GOOGLE_CONN);
    vi.mocked(workspaceProxyForBusiness).mockResolvedValue({ data: { id: "ev-1" } } as never);
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
    vi.mocked(workspaceProxyForBusiness).mockResolvedValue({ data: { id: "ev-1" } } as never);
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
      data: {
        eventId: "evt-prior",
        deduplicated: true,
        inviteEmail: null,
        startLocal: "Friday, June 12, 2026 at 5:00 PM UTC"
      }
    });
    expect(vi.mocked(resolveCalendarConnection)).not.toHaveBeenCalled();
    expect(vi.mocked(workspaceProxyForBusiness)).not.toHaveBeenCalled();
    expect(vi.mocked(fireGoalEvent)).not.toHaveBeenCalled();
    expect(vi.mocked(confirmBookingDedupe)).not.toHaveBeenCalled();
    expect(vi.mocked(releaseBookingDedupe)).not.toHaveBeenCalled();
  });

  it("a duplicate claim carries the merged inviteEmail (a timeout retry must keep invite language honest)", async () => {
    // Bugbot Medium (PR #705): the already_booked short-circuit omitted
    // inviteEmail, so a retry-after-timeout confirmed the slot while the
    // prompts (which key invite talk off inviteEmail) withheld the invite.
    vi.mocked(claimBookingDedupe).mockResolvedValue({ kind: "duplicate", eventId: "evt-prior" });

    // Explicit model-supplied email.
    const explicit = await bookCalendarAppointment(
      BIZ,
      { ...ARGS, attendeeEmail: "spoken@x.co" },
      "+15551230000"
    );
    expect(explicit.data).toMatchObject({ inviteEmail: "spoken@x.co" });

    // Backfilled from the stored contact, the same merge the original
    // create ran, so it reflects what actually rode the event.
    vi.mocked(getCustomerMemory).mockResolvedValue({
      display_name: "Joe",
      email: "stored@x.co"
    } as never);
    const backfilled = await bookCalendarAppointment(BIZ, ARGS, "+15551230000");
    expect(backfilled.data).toMatchObject({ inviteEmail: "stored@x.co" });
  });

  it("an in-flight claim refuses without touching the provider", async () => {
    vi.mocked(claimBookingDedupe).mockResolvedValue({ kind: "in_flight" });
    const result = await bookCalendarAppointment(BIZ, ARGS, "+15551230000");
    expect(result).toEqual({ ok: false, detail: "booking_in_progress" });
    expect(vi.mocked(resolveCalendarConnection)).not.toHaveBeenCalled();
    expect(vi.mocked(workspaceProxyForBusiness)).not.toHaveBeenCalled();
  });

  it("confirms the claim after a successful provider create", async () => {
    vi.mocked(claimBookingDedupe).mockResolvedValue({ kind: "claimed", id: "claim-1" });
    vi.mocked(resolveCalendarConnection).mockResolvedValue(GOOGLE_CONN);
    vi.mocked(workspaceProxyForBusiness).mockResolvedValue({ data: { id: "ev-1" } } as never);
    const result = await bookCalendarAppointment(BIZ, ARGS, "+15551230000");
    expect(result.ok).toBe(true);
    expect(vi.mocked(confirmBookingDedupe)).toHaveBeenCalledWith("claim-1", "ev-1", {
      zoomMeetingId: null,
      sharedCalendarEventId: null,
      meetJoinUrl: null
    });
    expect(vi.mocked(releaseBookingDedupe)).not.toHaveBeenCalled();
  });

  it("releases the claim when the booking fails, so a later attempt can book cleanly", async () => {
    vi.mocked(claimBookingDedupe).mockResolvedValue({ kind: "claimed", id: "claim-1" });
    vi.mocked(resolveCalendarConnection).mockResolvedValue(GOOGLE_CONN);
    vi.mocked(workspaceProxyForBusiness).mockResolvedValue(null as never);
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

  it("a null claim (ledger unavailable) books without dedupe, fail-open", async () => {
    vi.mocked(claimBookingDedupe).mockResolvedValue(null);
    vi.mocked(resolveCalendarConnection).mockResolvedValue(GOOGLE_CONN);
    vi.mocked(workspaceProxyForBusiness).mockResolvedValue({ data: { id: "ev-1" } } as never);
    const result = await bookCalendarAppointment(BIZ, ARGS, "+15551230000");
    expect(result.ok).toBe(true);
    expect(vi.mocked(confirmBookingDedupe)).not.toHaveBeenCalled();
    expect(vi.mocked(releaseBookingDedupe)).not.toHaveBeenCalled();
  });
});

describe("bookCalendarAppointment, Zoom decorator", () => {
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
    vi.mocked(workspaceProxyForBusiness).mockResolvedValue({ data: { id: "ev-1" } } as never);

    const result = await bookCalendarAppointment(BIZ, ARGS, "+15551230000");

    expect(vi.mocked(createZoomMeetingForBooking)).toHaveBeenCalledWith(BIZ, {
      topic: "Estimate call",
      startIso: ARGS.startIso,
      endIso: ARGS.endIso,
      agenda: "Kitchen sink"
    });
    const call = vi.mocked(workspaceProxyForBusiness).mock.calls[0][2] as {
      data: { description: string };
    };
    expect(call.data.description).toContain("Video call (Zoom): https://zoom.us/j/123");
    expect(result.data).toMatchObject({
      eventId: "ev-1",
      zoomMeetingId: "zm-1",
      videoJoinUrl: "https://zoom.us/j/123",
      videoProvider: "zoom"
    });
    expect(vi.mocked(confirmBookingDedupe)).toHaveBeenCalledWith("claim-1", "ev-1", {
      zoomMeetingId: "zm-1",
      sharedCalendarEventId: null,
      meetJoinUrl: null
    });
    expect(vi.mocked(deleteZoomMeetingForBooking)).not.toHaveBeenCalled();
  });

  it("omits the agenda when the booking has no notes", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(GOOGLE_CONN);
    vi.mocked(createZoomMeetingForBooking).mockResolvedValue(null);
    vi.mocked(workspaceProxyForBusiness).mockResolvedValue({ data: { id: "ev-1" } } as never);
    const { notes: _unused, ...noNotes } = ARGS;
    await bookCalendarAppointment(BIZ, noNotes, "+15551230000");
    expect(vi.mocked(createZoomMeetingForBooking)).toHaveBeenCalledWith(BIZ, {
      topic: "Estimate call",
      startIso: ARGS.startIso,
      endIso: ARGS.endIso
    });
  });

  it("deletes the meeting and drops the join link when the create confirms no event id", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(GOOGLE_CONN);
    vi.mocked(createZoomMeetingForBooking).mockResolvedValue(ZOOM);
    // Truthy proxy response, but no event id, not a confirmed booking.
    vi.mocked(workspaceProxyForBusiness).mockResolvedValue({ data: {} } as never);

    const result = await bookCalendarAppointment(BIZ, ARGS, "+15551230000");

    expect(result.ok).toBe(true);
    expect(result.data).not.toHaveProperty("videoJoinUrl");
    expect(vi.mocked(deleteZoomMeetingForBooking)).toHaveBeenCalledWith(BIZ, "zm-1");
    expect(vi.mocked(fireGoalEvent)).not.toHaveBeenCalled();
  });

  it("cleans up the meeting when the Google create returns no connection", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(GOOGLE_CONN);
    vi.mocked(createZoomMeetingForBooking).mockResolvedValue(ZOOM);
    vi.mocked(workspaceProxyForBusiness).mockResolvedValue(null as never);
    const result = await bookCalendarAppointment(BIZ, ARGS, "+15551230000");
    expect(result).toEqual({ ok: false, detail: "calendar_not_connected" });
    expect(vi.mocked(deleteZoomMeetingForBooking)).toHaveBeenCalledWith(BIZ, "zm-1");
  });

  it("cleans up the meeting when the Microsoft create returns no connection", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(MS_CONN);
    vi.mocked(createZoomMeetingForBooking).mockResolvedValue(ZOOM);
    vi.mocked(workspaceProxyForBusiness).mockResolvedValue(null as never);
    const result = await bookCalendarAppointment(BIZ, ARGS, "+15551230000");
    expect(result).toEqual({ ok: false, detail: "calendar_not_connected" });
    expect(vi.mocked(deleteZoomMeetingForBooking)).toHaveBeenCalledWith(BIZ, "zm-1");
  });

  it("cleans up the meeting when the provider create throws", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(GOOGLE_CONN);
    vi.mocked(createZoomMeetingForBooking).mockResolvedValue(ZOOM);
    vi.mocked(workspaceProxyForBusiness).mockRejectedValue(new Error("graph 500"));
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
      videoJoinUrl: "https://zoom.us/j/123",
      videoProvider: "zoom"
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

describe("bookCalendarAppointment, stored display name wins (Truly Issue 6)", () => {
  const ARGS = {
    startIso: "2026-06-12T17:00:00.000Z",
    endIso: "2026-06-12T17:30:00.000Z",
    summary: "Estimate",
    attendeeName: "Muhammad Fahad Juhu"
  };

  it("replaces the model-supplied name with the contact's stored display name everywhere", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(GOOGLE_CONN);
    vi.mocked(getCustomerMemory).mockResolvedValue({ display_name: "Juhu" } as never);
    vi.mocked(workspaceProxyForBusiness).mockResolvedValue({ data: { id: "ev-1" } } as never);

    await bookCalendarAppointment(BIZ, { ...ARGS, attendeeEmail: "j@x.co" }, "+15485773546");

    expect(vi.mocked(getCustomerMemory)).toHaveBeenCalledWith(BIZ, "+15485773546");
    // The dedupe key sees the preferred name too.
    expect(vi.mocked(bookingAttendeeKey)).toHaveBeenCalledWith("+15485773546", "j@x.co", "Juhu");
    const payload = vi.mocked(workspaceProxyForBusiness).mock.calls[0][2] as {
      data: { description: string; attendees: Array<{ displayName: string }> };
    };
    expect(payload.data.description).toContain("Attendee: Juhu");
    expect(payload.data.description).not.toContain("Muhammad Fahad Juhu");
    expect(payload.data.attendees[0].displayName).toBe("Juhu");
  });

  it("keeps the model-supplied name when the contact has no stored name or is unknown", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(GOOGLE_CONN);
    vi.mocked(getCustomerMemory).mockResolvedValue({ display_name: "   " } as never);
    vi.mocked(workspaceProxyForBusiness).mockResolvedValue({ data: { id: "ev-1" } } as never);
    await bookCalendarAppointment(BIZ, ARGS, "+15485773546");
    const payload = vi.mocked(workspaceProxyForBusiness).mock.calls[0][2] as {
      data: { description: string };
    };
    expect(payload.data.description).toContain("Attendee: Muhammad Fahad Juhu");
  });

  it("skips the lookup entirely when no phone identity exists", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(GOOGLE_CONN);
    vi.mocked(workspaceProxyForBusiness).mockResolvedValue({ data: { id: "ev-1" } } as never);
    await bookCalendarAppointment(BIZ, ARGS);
    expect(vi.mocked(getCustomerMemory)).not.toHaveBeenCalled();
  });

  it("a lookup failure (Error or not) books with the model-supplied name, never blocks", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(GOOGLE_CONN);
    vi.mocked(workspaceProxyForBusiness).mockResolvedValue({ data: { id: "ev-1" } } as never);

    vi.mocked(getCustomerMemory).mockRejectedValue(new Error("db down"));
    expect((await bookCalendarAppointment(BIZ, ARGS, "+15485773546")).ok).toBe(true);

    vi.mocked(getCustomerMemory).mockRejectedValue("raw failure");
    expect((await bookCalendarAppointment(BIZ, ARGS, "+15485773546")).ok).toBe(true);
  });
});

describe("bookCalendarAppointment, stored contact EMAIL backfill (Truly, Jul 15 2026)", () => {
  // The voice model rarely collects an email mid-call, so bookings shipped
  // with no attendee: the provider sent NO invite while the assistant told
  // the caller "a calendar invite will be sent to you shortly".
  const ARGS = {
    startIso: "2026-06-12T17:00:00.000Z",
    endIso: "2026-06-12T17:30:00.000Z",
    summary: "Estimate",
    attendeeName: "Aurangzeb Khan"
  };

  it("backfills the attendee email from the stored contact so a REAL invite goes out", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(GOOGLE_CONN);
    vi.mocked(getCustomerMemory).mockResolvedValue({
      display_name: "Aurangzeb Khan",
      email: "azkhan15@hotmail.com"
    } as never);
    vi.mocked(workspaceProxyForBusiness).mockResolvedValue({ data: { id: "ev-1" } } as never);

    const result = await bookCalendarAppointment(BIZ, ARGS, "+16138540807");

    const payload = vi.mocked(workspaceProxyForBusiness).mock.calls[0][2] as {
      data: { description: string; attendees: Array<{ email: string }> };
    };
    expect(payload.data.attendees).toEqual([
      { email: "azkhan15@hotmail.com", displayName: "Aurangzeb Khan" }
    ]);
    expect(payload.data.description).toContain("Email: azkhan15@hotmail.com");
    expect(result.data).toMatchObject({ inviteEmail: "azkhan15@hotmail.com" });
  });

  it("the model's explicit attendeeEmail wins over the stored contact email", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(GOOGLE_CONN);
    vi.mocked(getCustomerMemory).mockResolvedValue({
      display_name: "Aurangzeb Khan",
      email: "stored@x.co"
    } as never);
    vi.mocked(workspaceProxyForBusiness).mockResolvedValue({ data: { id: "ev-1" } } as never);

    const result = await bookCalendarAppointment(
      BIZ,
      { ...ARGS, attendeeEmail: "spoken@x.co" },
      "+16138540807"
    );
    const payload = vi.mocked(workspaceProxyForBusiness).mock.calls[0][2] as {
      data: { attendees: Array<{ email: string }> };
    };
    expect(payload.data.attendees[0].email).toBe("spoken@x.co");
    expect(result.data).toMatchObject({ inviteEmail: "spoken@x.co" });
  });

  it("a blank model email is treated as absent (stored email backfills)", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(GOOGLE_CONN);
    vi.mocked(getCustomerMemory).mockResolvedValue({
      display_name: null,
      email: "stored@x.co"
    } as never);
    vi.mocked(workspaceProxyForBusiness).mockResolvedValue({ data: { id: "ev-1" } } as never);

    const result = await bookCalendarAppointment(
      BIZ,
      { ...ARGS, attendeeEmail: "   " },
      "+16138540807"
    );
    expect(result.data).toMatchObject({ inviteEmail: "stored@x.co" });
  });

  it("no stored email and none supplied → no attendees, inviteEmail null (no invite promised)", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(GOOGLE_CONN);
    vi.mocked(getCustomerMemory).mockResolvedValue({
      display_name: "Aurangzeb Khan",
      email: "   "
    } as never);
    vi.mocked(workspaceProxyForBusiness).mockResolvedValue({ data: { id: "ev-1" } } as never);

    const result = await bookCalendarAppointment(BIZ, ARGS, "+16138540807");
    const payload = vi.mocked(workspaceProxyForBusiness).mock.calls[0][2] as {
      data: { attendees?: unknown };
    };
    expect(payload.data.attendees).toBeUndefined();
    expect(result.data).toMatchObject({ inviteEmail: null });
  });
});

describe("bookCalendarAppointment trustProvidedName (public booking page)", () => {
  const ARGS = {
    startIso: "2026-01-05T16:00:00Z",
    endIso: "2026-01-05T16:30:00Z",
    summary: "Meeting",
    attendeeName: "Fresh Form Name"
  };

  it("keeps the caller-supplied name over the stored display name", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(GOOGLE_CONN);
    vi.mocked(getCustomerMemory).mockResolvedValue({
      display_name: "Stale CRM Name",
      email: null
    } as never);
    vi.mocked(workspaceProxyForBusiness).mockResolvedValue({ data: { id: "ev-1" } } as never);

    const result = await bookCalendarAppointment(BIZ, ARGS, "+16138540807", {
      trustProvidedName: true
    });
    expect(result.ok).toBe(true);
    const payload = vi.mocked(workspaceProxyForBusiness).mock.calls[0][2] as {
      data: { summary: string; description?: string };
    };
    expect(JSON.stringify(payload.data)).toContain("Fresh Form Name");
    expect(JSON.stringify(payload.data)).not.toContain("Stale CRM Name");
  });
});

describe("getWorkspaceBusyBlocks (direct, the booking page's busy fetch)", () => {
  const WINDOW_START = new Date("2026-01-05T00:00:00Z");
  const WINDOW_END = new Date("2026-01-06T00:00:00Z");

  it("defaults the Graph availabilityViewInterval to 30 when no options are passed", async () => {
    vi.mocked(workspaceProxyForBusiness).mockResolvedValue({
      data: { value: [{ scheduleItems: [] }] }
    } as never);

    const busy = await getWorkspaceBusyBlocks(BIZ, MS_CONN, WINDOW_START, WINDOW_END);
    expect(busy).toEqual({ busy: [], complete: true });
    const payload = vi.mocked(workspaceProxyForBusiness).mock.calls[0][2] as {
      data: { availabilityViewInterval: number };
    };
    expect(payload.data.availabilityViewInterval).toBe(30);
  });

  it("returns null when the proxy yields nothing (calendar_not_connected shape)", async () => {
    vi.mocked(workspaceProxyForBusiness).mockResolvedValue(null as never);
    expect(await getWorkspaceBusyBlocks(BIZ, GOOGLE_CONN, WINDOW_START, WINDOW_END)).toBeNull();
  });
});

describe("getWorkspaceBusyBlocks: personal Outlook has no getSchedule", () => {
  const conn = {
    provider: "microsoft",
    connectionId: "direct:abc",
    providerConfigKey: "outlook"
  };
  const windowStart = new Date("2026-08-20T09:00:00Z");
  const windowEnd = new Date("2026-08-20T17:00:00Z");

  /** What the transport throws on a provider rejection. */
  function providerRejection(status: number) {
    return Object.assign(new Error(`Provider request failed (${status})`), {
      response: { status, data: { error: { code: "ErrorInvalidUser" } } }
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getSharedCalendar).mockResolvedValue(null as never);
  });

  it("falls back to calendarView when getSchedule is rejected", async () => {
    // A personal Microsoft account rejects getSchedule outright. Before the
    // fallback this threw, every caller caught it, and the tenant silently had
    // no availability at all: no slot offers, an unreadable booking page, and
    // a waitlist that treated every slot as permanently taken.
    vi.mocked(workspaceProxyForBusiness)
      .mockRejectedValueOnce(providerRejection(403))
      .mockResolvedValueOnce({
        status: 200,
        data: {
          value: [
            { start: { dateTime: "2026-08-20T10:00:00" }, end: { dateTime: "2026-08-20T11:00:00" } }
          ]
        }
      } as never);

    const busy = await getWorkspaceBusyBlocks("biz", conn, windowStart, windowEnd);

    expect(busy).toEqual({
      busy: [{ start: new Date("2026-08-20T10:00:00Z"), end: new Date("2026-08-20T11:00:00Z") }],
      complete: true
    });
    const second = vi.mocked(workspaceProxyForBusiness).mock.calls[1];
    expect((second[2] as { endpoint: string }).endpoint).toBe("/v1.0/me/calendarView");
  });

  it("honors showAs: an event marked free does not block a slot", async () => {
    // getSchedule returns availability; calendarView returns EVENTS. Without
    // reading showAs the fallback would invent busy time the primary path
    // would never have reported, quietly deleting real availability.
    vi.mocked(workspaceProxyForBusiness)
      .mockRejectedValueOnce(providerRejection(403))
      .mockResolvedValueOnce({
        status: 200,
        data: {
          value: [
            { start: { dateTime: "2026-08-20T10:00:00" }, end: { dateTime: "2026-08-20T11:00:00" }, showAs: "free" },
            { start: { dateTime: "2026-08-20T12:00:00" }, end: { dateTime: "2026-08-20T13:00:00" }, showAs: "workingElsewhere" },
            { start: { dateTime: "2026-08-20T14:00:00" }, end: { dateTime: "2026-08-20T15:00:00" }, showAs: "busy" },
            { start: { dateTime: "2026-08-20T16:00:00" }, end: { dateTime: "2026-08-20T17:00:00" }, isCancelled: true }
          ]
        }
      } as never);

    const busy = await getWorkspaceBusyBlocks("biz", conn, windowStart, windowEnd);

    expect(busy).toEqual({
      busy: [{ start: new Date("2026-08-20T14:00:00Z"), end: new Date("2026-08-20T15:00:00Z") }],
      complete: true
    });
  });

  it("does NOT fall back on a transport failure, which is not evidence about the mailbox", async () => {
    // No response means we never reached Microsoft. Retrying a different
    // endpoint would turn one timeout into two and delay the caller twice.
    vi.mocked(workspaceProxyForBusiness).mockRejectedValueOnce(new Error("Provider unreachable"));

    await expect(getWorkspaceBusyBlocks("biz", conn, windowStart, windowEnd)).rejects.toThrow(
      "Provider unreachable"
    );
    expect(workspaceProxyForBusiness).toHaveBeenCalledTimes(1);
  });

  it("rethrows a non-object throw instead of reading it as a provider rejection", async () => {
    // A thrown string carries no status, so it is not evidence the mailbox
    // lacks getSchedule. Same reasoning as the transport case above: only a
    // real HTTP status earns a second request.
    vi.mocked(workspaceProxyForBusiness).mockRejectedValueOnce("boom" as never);

    await expect(getWorkspaceBusyBlocks("biz", conn, windowStart, windowEnd)).rejects.toBe("boom");
    expect(workspaceProxyForBusiness).toHaveBeenCalledTimes(1);
  });

  it("returns null when the fallback also finds no connection", async () => {
    vi.mocked(workspaceProxyForBusiness)
      .mockRejectedValueOnce(providerRejection(403))
      .mockResolvedValueOnce(null as never);

    await expect(getWorkspaceBusyBlocks("biz", conn, windowStart, windowEnd)).resolves.toBeNull();
  });

  it("leaves the work/school path untouched when getSchedule succeeds", async () => {
    vi.mocked(workspaceProxyForBusiness).mockResolvedValueOnce({
      status: 200,
      data: {
        value: [
          {
            scheduleItems: [
              { start: { dateTime: "2026-08-20T09:30:00" }, end: { dateTime: "2026-08-20T10:00:00" } }
            ]
          }
        ]
      }
    } as never);

    const busy = await getWorkspaceBusyBlocks("biz", conn, windowStart, windowEnd);

    expect(busy).toEqual({
      busy: [{ start: new Date("2026-08-20T09:30:00Z"), end: new Date("2026-08-20T10:00:00Z") }],
      complete: true
    });
    expect(workspaceProxyForBusiness).toHaveBeenCalledTimes(1);
  });
});

describe("getWorkspaceBusyBlocks: calendarView paging", () => {
  // Graph defaults calendarView to TEN items per page. A busy read that stops
  // at the first page under-reports busy in one direction only: unseen events
  // read as free, so the coworker books on top of real meetings.
  const conn = {
    provider: "microsoft",
    connectionId: "direct:abc",
    providerConfigKey: "outlook"
  };
  const windowStart = new Date("2026-08-20T09:00:00Z");
  const windowEnd = new Date("2026-08-27T17:00:00Z");

  function providerRejection(status: number) {
    return Object.assign(new Error(`Provider request failed (${status})`), {
      response: { status, data: { error: { code: "ErrorInvalidUser" } } }
    });
  }

  function page(events: Array<{ h: number }>, nextLink?: string) {
    return {
      status: 200,
      data: {
        value: events.map((e) => ({
          start: { dateTime: `2026-08-20T${String(e.h).padStart(2, "0")}:00:00` },
          end: { dateTime: `2026-08-20T${String(e.h + 1).padStart(2, "0")}:00:00` }
        })),
        ...(nextLink ? { "@odata.nextLink": nextLink } : {})
      }
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getSharedCalendar).mockResolvedValue(null as never);
  });

  it("asks for a real page size instead of accepting Graph's default of 10", async () => {
    vi.mocked(workspaceProxyForBusiness)
      .mockRejectedValueOnce(providerRejection(403))
      .mockResolvedValueOnce(page([{ h: 10 }]) as never);

    await getWorkspaceBusyBlocks("biz", conn, windowStart, windowEnd);

    const params = (
      vi.mocked(workspaceProxyForBusiness).mock.calls[1][2] as {
        params: Record<string, string>;
      }
    ).params;
    expect(params.$top).toBe("250");
  });

  it("follows @odata.nextLink and merges every page into the busy list", async () => {
    vi.mocked(workspaceProxyForBusiness)
      .mockRejectedValueOnce(providerRejection(403))
      .mockResolvedValueOnce(
        page([{ h: 10 }], "https://graph.microsoft.com/v1.0/me/calendarView?$skiptoken=B2") as never
      )
      .mockResolvedValueOnce(page([{ h: 14 }]) as never);

    const busy = await getWorkspaceBusyBlocks("biz", conn, windowStart, windowEnd);

    // Page two's event must be present. Without paging it reads as free.
    expect(busy).toEqual({
      busy: [
        { start: new Date("2026-08-20T10:00:00Z"), end: new Date("2026-08-20T11:00:00Z") },
        { start: new Date("2026-08-20T14:00:00Z"), end: new Date("2026-08-20T15:00:00Z") }
      ],
      complete: true
    });

    // The follow-up goes to nextLink's path+query with NOTHING merged on top:
    // the link already carries the window and a $skiptoken, and re-merging
    // params onto it risks displacing the token and looping on page one.
    const third = vi.mocked(workspaceProxyForBusiness).mock.calls[2][2] as {
      endpoint: string;
      params?: unknown;
    };
    expect(third.endpoint).toBe("/v1.0/me/calendarView?$skiptoken=B2");
    expect(third.params).toBeUndefined();
  });

  it("reports the read as incomplete, keeping the blocks, when paging runs long", async () => {
    // The blocks gathered so far are real, so they are kept: discarding them
    // would make the booking page fall back on ledger-plus-cache, which blocks
    // LESS. `complete: false` is what stops a caller with no other
    // availability source from reading the unread remainder as free.
    const more = page([{ h: 10 }], "https://graph.microsoft.com/v1.0/me/calendarView?$skiptoken=X");
    vi.mocked(workspaceProxyForBusiness)
      .mockRejectedValueOnce(providerRejection(403))
      .mockResolvedValue(more as never);

    const read = await getWorkspaceBusyBlocks("biz", conn, windowStart, windowEnd);

    expect(read?.complete).toBe(false);
    // One block per page walked, so the partial answer is genuinely populated.
    expect(read?.busy).toHaveLength(4);

    // One getSchedule attempt plus the bounded page budget, and no more.
    expect(workspaceProxyForBusiness).toHaveBeenCalledTimes(1 + 4);
  });

  it("reads a bodyless or empty calendarView page as no events, not as a failure", async () => {
    // Graph can answer with no body at all (a 204 on the direct transport) or
    // with an object carrying no `value`. Neither is an error, and neither is
    // evidence of busy time: the window is simply empty. Distinct from the
    // page-budget case above, which IS a refusal.
    vi.mocked(workspaceProxyForBusiness)
      .mockRejectedValueOnce(providerRejection(403))
      .mockResolvedValueOnce({ status: 200 } as never);
    await expect(getWorkspaceBusyBlocks("biz", conn, windowStart, windowEnd)).resolves.toEqual({
      busy: [],
      complete: true
    });

    vi.clearAllMocks();
    vi.mocked(getSharedCalendar).mockResolvedValue(null as never);
    vi.mocked(workspaceProxyForBusiness)
      .mockRejectedValueOnce(providerRejection(403))
      .mockResolvedValueOnce({ status: 200, data: {} } as never);
    await expect(getWorkspaceBusyBlocks("biz", conn, windowStart, windowEnd)).resolves.toEqual({
      busy: [],
      complete: true
    });
  });

  it("skips an event missing either endpoint rather than minting an Invalid Date", async () => {
    vi.mocked(workspaceProxyForBusiness)
      .mockRejectedValueOnce(providerRejection(403))
      .mockResolvedValueOnce({
        status: 200,
        data: {
          value: [
            { start: { dateTime: "2026-08-20T10:00:00" } },
            { end: { dateTime: "2026-08-20T13:00:00" } },
            {
              start: { dateTime: "2026-08-20T14:00:00" },
              end: { dateTime: "2026-08-20T15:00:00" }
            }
          ]
        }
      } as never);

    await expect(getWorkspaceBusyBlocks("biz", conn, windowStart, windowEnd)).resolves.toEqual({
      busy: [{ start: new Date("2026-08-20T14:00:00Z"), end: new Date("2026-08-20T15:00:00Z") }],
      complete: true
    });
  });

  it("fails the whole lookup when the shared calendar cannot be read", async () => {
    // The shared calendar holds OUR OWN bookings, so skipping it is the single
    // case guaranteed to double-book. getSchedule succeeding does not make a
    // half-answer safe.
    vi.mocked(getSharedCalendar).mockResolvedValue({ calendarId: "shared-1" } as never);
    vi.mocked(workspaceProxyForBusiness)
      .mockResolvedValueOnce({
        status: 200,
        data: {
          value: [
            {
              scheduleItems: [
                { start: { dateTime: "2026-08-20T09:30:00" }, end: { dateTime: "2026-08-20T10:00:00" } }
              ]
            }
          ]
        }
      } as never)
      .mockResolvedValueOnce(null as never);

    await expect(getWorkspaceBusyBlocks("biz", conn, windowStart, windowEnd)).resolves.toBeNull();
  });
});

describe("bookCalendarAppointment, Google Meet decorator", () => {
  const ARGS = {
    startIso: "2026-06-12T17:00:00.000Z",
    endIso: "2026-06-12T17:30:00.000Z",
    summary: "Estimate call",
    attendeeName: "Joe Plumber",
    notes: "Kitchen sink"
  };
  const MEET_URL = "https://meet.google.com/abc-defg-hij";

  /** Meet on, Zoom absent, a Google calendar: the only shape that asks. */
  function meetTenant() {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(GOOGLE_CONN);
    vi.mocked(createZoomMeetingForBooking).mockResolvedValue(null);
    vi.mocked(isGoogleMeetEnabled).mockResolvedValue(true);
  }

  /** The conference request as it actually left for Google. */
  function insertPayload() {
    return vi.mocked(workspaceProxyStatusForBusiness).mock.calls[0][2] as {
      params?: Record<string, string>;
      data: { conferenceData?: unknown; description?: string };
    };
  }

  it("asks for a conference and threads the link into the result and the ledger", async () => {
    meetTenant();
    vi.mocked(claimBookingDedupe).mockResolvedValue({ kind: "claimed", id: "claim-1" });
    vi.mocked(workspaceProxyStatusForBusiness).mockResolvedValue({
      status: 200,
      data: { id: "ev-1", hangoutLink: MEET_URL }
    } as never);

    const result = await bookCalendarAppointment(BIZ, ARGS, "+15551230000");

    const payload = insertPayload();
    expect(payload.params).toEqual({ conferenceDataVersion: "1" });
    expect(payload.data.conferenceData).toMatchObject({
      createRequest: { conferenceSolutionKey: { type: "hangoutsMeet" } }
    });
    expect(result.data).toMatchObject({
      eventId: "ev-1",
      videoJoinUrl: MEET_URL,
      videoProvider: "google_meet"
    });
    // The Zoom lifecycle handle must stay empty: every reader of it calls the
    // Zoom API, and a Meet conference has nothing to call.
    expect(result.data).not.toHaveProperty("zoomMeetingId");
    expect(vi.mocked(confirmBookingDedupe)).toHaveBeenCalledWith("claim-1", "ev-1", {
      zoomMeetingId: null,
      sharedCalendarEventId: null,
      meetJoinUrl: MEET_URL
    });
  });

  it("keeps the Meet URL out of the event description", async () => {
    // Google renders its own join control on the event, and the link does
    // not exist until the insert responds, so a description line would cost
    // a second write for nothing.
    meetTenant();
    vi.mocked(workspaceProxyStatusForBusiness).mockResolvedValue({
      status: 200,
      data: { id: "ev-1", hangoutLink: MEET_URL }
    } as never);

    await bookCalendarAppointment(BIZ, ARGS, "+15551230000");

    expect(insertPayload().data.description).not.toContain("meet.google.com");
  });

  it("lets Zoom win: a Zoom booking never asks for a conference", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(GOOGLE_CONN);
    vi.mocked(isGoogleMeetEnabled).mockResolvedValue(true);
    vi.mocked(createZoomMeetingForBooking).mockResolvedValue({
      meetingId: "zm-1",
      joinUrl: "https://zoom.us/j/123"
    });
    vi.mocked(workspaceProxyForBusiness).mockResolvedValue({ data: { id: "ev-1" } } as never);

    const result = await bookCalendarAppointment(BIZ, ARGS, "+15551230000");

    expect(vi.mocked(workspaceProxyStatusForBusiness)).not.toHaveBeenCalled();
    expect(result.data).toMatchObject({ videoProvider: "zoom" });
  });

  it("asks for nothing when the owner has not opted in", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(GOOGLE_CONN);
    vi.mocked(createZoomMeetingForBooking).mockResolvedValue(null);
    vi.mocked(isGoogleMeetEnabled).mockResolvedValue(false);
    vi.mocked(workspaceProxyForBusiness).mockResolvedValue({ data: { id: "ev-1" } } as never);

    const result = await bookCalendarAppointment(BIZ, ARGS, "+15551230000");

    expect(vi.mocked(workspaceProxyStatusForBusiness)).not.toHaveBeenCalled();
    expect(result.data).not.toHaveProperty("videoJoinUrl");
  });

  it("never asks on Microsoft, whose event cannot carry a Meet conference", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(MS_CONN);
    vi.mocked(createZoomMeetingForBooking).mockResolvedValue(null);
    vi.mocked(isGoogleMeetEnabled).mockResolvedValue(true);
    vi.mocked(workspaceProxyForBusiness).mockResolvedValue({ data: { id: "ev-1" } } as never);

    await bookCalendarAppointment(BIZ, ARGS, "+15551230000");

    expect(vi.mocked(workspaceProxyStatusForBusiness)).not.toHaveBeenCalled();
    // The provider check short-circuits before the DB read, so a Microsoft
    // tenant never pays for the flag either.
    expect(vi.mocked(isGoogleMeetEnabled)).not.toHaveBeenCalled();
  });

  it("re-books without the conference when Google refuses it, rather than losing the booking", async () => {
    // The conference rides the SAME request that creates the appointment, so
    // a calendar that does not allow hangoutsMeet would otherwise turn a
    // best-effort video link into a lost booking.
    meetTenant();
    vi.mocked(workspaceProxyStatusForBusiness).mockResolvedValue({
      status: 400,
      data: { error: { message: "Invalid conference type value" } }
    } as never);
    vi.mocked(workspaceProxyForBusiness).mockResolvedValue({ data: { id: "ev-1" } } as never);

    const result = await bookCalendarAppointment(BIZ, ARGS, "+15551230000");

    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ eventId: "ev-1" });
    expect(result.data).not.toHaveProperty("videoJoinUrl");
    const retry = vi.mocked(workspaceProxyForBusiness).mock.calls[0][2] as {
      params?: unknown;
      data: { conferenceData?: unknown };
    };
    expect(retry.data.conferenceData).toBeUndefined();
    expect(retry.params).toBeUndefined();
  });

  it("does NOT retry a 5xx, which may have created the event before failing", async () => {
    // Only a 4xx proves Google created nothing. A 500 may have written the
    // event and then failed to report it, so a blind second insert would
    // book the slot twice. Same treatment as a statusless failure.
    meetTenant();
    vi.mocked(workspaceProxyStatusForBusiness).mockResolvedValue({
      status: 503,
      data: { error: { message: "Backend Error" } }
    } as never);

    const result = await bookCalendarAppointment(BIZ, ARGS, "+15551230000");

    expect(result).toEqual({ ok: false, detail: "calendar_book_failed" });
    expect(vi.mocked(workspaceProxyForBusiness)).not.toHaveBeenCalled();
  });

  it("does NOT retry a transport failure, which could double-book", async () => {
    // A timeout may or may not have created the event. Retrying blind is how
    // one caller ends up with two appointments in the same slot.
    meetTenant();
    vi.mocked(workspaceProxyStatusForBusiness).mockRejectedValue(new Error("socket hang up"));

    const result = await bookCalendarAppointment(BIZ, ARGS, "+15551230000");

    expect(result).toEqual({ ok: false, detail: "calendar_book_failed" });
    expect(vi.mocked(workspaceProxyForBusiness)).not.toHaveBeenCalled();
  });

  it("re-reads once for a still-pending conference", async () => {
    meetTenant();
    vi.mocked(workspaceProxyStatusForBusiness).mockResolvedValue({
      status: 200,
      data: {
        id: "ev-1",
        conferenceData: { createRequest: { status: { statusCode: "pending" } } }
      }
    } as never);
    vi.mocked(workspaceProxyForBusiness).mockResolvedValue({
      data: { id: "ev-1", hangoutLink: MEET_URL }
    } as never);

    const result = await bookCalendarAppointment(BIZ, ARGS, "+15551230000");

    expect(result.data).toMatchObject({ videoJoinUrl: MEET_URL, videoProvider: "google_meet" });
    const reread = vi.mocked(workspaceProxyForBusiness).mock.calls[0][2] as {
      endpoint: string;
      method: string;
    };
    expect(reread.method).toBe("GET");
    expect(reread.endpoint).toContain("/events/ev-1");
  });

  it("books anyway when the link never materializes", async () => {
    meetTenant();
    vi.mocked(workspaceProxyStatusForBusiness).mockResolvedValue({
      status: 200,
      data: {
        id: "ev-1",
        conferenceData: { createRequest: { status: { statusCode: "pending" } } }
      }
    } as never);
    vi.mocked(workspaceProxyForBusiness).mockResolvedValue({ data: { id: "ev-1" } } as never);

    const result = await bookCalendarAppointment(BIZ, ARGS, "+15551230000");

    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ eventId: "ev-1" });
    expect(result.data).not.toHaveProperty("videoJoinUrl");
  });

  it("books anyway when the re-read finds no connection at all", async () => {
    // The grant can be revoked between the insert and the re-read. The
    // appointment is already on the calendar either way.
    meetTenant();
    vi.mocked(workspaceProxyStatusForBusiness).mockResolvedValue({
      status: 200,
      data: {
        id: "ev-1",
        conferenceData: { createRequest: { status: { statusCode: "pending" } } }
      }
    } as never);
    vi.mocked(workspaceProxyForBusiness).mockResolvedValue(null as never);

    const result = await bookCalendarAppointment(BIZ, ARGS, "+15551230000");

    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ eventId: "ev-1" });
    expect(result.data).not.toHaveProperty("videoJoinUrl");
  });

  it("carries no link when the insert produced no event id", async () => {
    meetTenant();
    vi.mocked(workspaceProxyStatusForBusiness).mockResolvedValue({
      status: 200,
      data: { hangoutLink: MEET_URL }
    } as never);

    const result = await bookCalendarAppointment(BIZ, ARGS, "+15551230000");

    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ eventId: null });
    expect(result.data).not.toHaveProperty("videoJoinUrl");
  });

  it("reports calendar_not_connected when the Meet insert finds no connection", async () => {
    meetTenant();
    vi.mocked(workspaceProxyStatusForBusiness).mockResolvedValue(null as never);

    const result = await bookCalendarAppointment(BIZ, ARGS, "+15551230000");

    expect(result).toEqual({ ok: false, detail: "calendar_not_connected" });
  });
});
