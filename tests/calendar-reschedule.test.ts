import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/voice-tools/connections", () => ({ resolveCalendarConnection: vi.fn() }));
vi.mock("@/lib/workspace/proxy", () => ({ workspaceProxyForBusiness: vi.fn() }));
vi.mock("@/lib/calendar-tools/shared-calendar", () => ({
  moveSharedCalendarMirror: vi.fn(),
  removeSharedCalendarMirror: vi.fn(), getSharedCalendar: vi.fn() }));
vi.mock("@/lib/calendar-tools/booking-dedupe", () => ({
  bookingAttendeeKey: vi.fn(() => "phone:+15485773546"),
  findUpcomingBookingClaim: vi.fn(),
  findUpcomingBookingClaimByPhone: vi.fn(),
  findZoomMeetingIdByEvent: vi.fn(),
  rescheduleBookingClaim: vi.fn(),
  deleteBookingClaim: vi.fn(),
  deleteBookingClaimsByEvent: vi.fn(),
  recordExternalBookingClaim: vi.fn()
}));
vi.mock("@/lib/calendar-tools/handlers", () => ({
  resolveToolTimezone: vi.fn(async () => "America/New_York"),
  wallClockInZone: vi.fn((d: Date, tz: string) => `wall(${d.toISOString()},${tz})`)
}));
vi.mock("@/lib/calendar-tools/calendly", () => ({
  cancelCalendlyAppointment: vi.fn(),
  createCalendlyRescheduleLink: vi.fn()
}));
vi.mock("@/lib/calendar-tools/vagaro", () => ({
  cancelVagaroAppointment: vi.fn(),
  rescheduleVagaroAppointment: vi.fn()
}));
vi.mock("@/lib/calendar-tools/acuity", () => ({
  cancelAcuityAppointment: vi.fn(),
  rescheduleAcuityAppointment: vi.fn()
}));
vi.mock("@/lib/calendar-tools/caldav", () => ({
  cancelCaldavAppointment: vi.fn(),
  rescheduleCaldavAppointment: vi.fn()
}));
vi.mock("@/lib/zoom/meetings", () => ({
  updateZoomMeetingForBooking: vi.fn(),
  deleteZoomMeetingForBooking: vi.fn()
}));
vi.mock("@/lib/calendar-tools/waitlist-fill", () => ({ offerFreedSlot: vi.fn() }));
vi.mock("@/lib/calendar-tools/waitlist-resolve", () => ({
  cancelWaitlistForAttendee: vi.fn(),
  resolveWaitlistAfterBooking: vi.fn()
}));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn() } }));

import {
  cancelCalendarAppointment,
  rescheduleCalendarAppointment
} from "@/lib/calendar-tools/reschedule";
import { resolveCalendarConnection } from "@/lib/voice-tools/connections";
import { workspaceProxyForBusiness } from "@/lib/workspace/proxy";
import { getSharedCalendar } from "@/lib/calendar-tools/shared-calendar";
import {
  deleteBookingClaim,
  deleteBookingClaimsByEvent,
  findUpcomingBookingClaim,
  findUpcomingBookingClaimByPhone,
  findZoomMeetingIdByEvent,
  recordExternalBookingClaim,
  rescheduleBookingClaim
} from "@/lib/calendar-tools/booking-dedupe";
import {
  cancelCalendlyAppointment,
  createCalendlyRescheduleLink
} from "@/lib/calendar-tools/calendly";
import {
  cancelVagaroAppointment,
  rescheduleVagaroAppointment
} from "@/lib/calendar-tools/vagaro";
import {
  moveSharedCalendarMirror,
  removeSharedCalendarMirror
} from "@/lib/calendar-tools/shared-calendar";
import {
  cancelAcuityAppointment,
  rescheduleAcuityAppointment
} from "@/lib/calendar-tools/acuity";
import {
  cancelCaldavAppointment,
  rescheduleCaldavAppointment
} from "@/lib/calendar-tools/caldav";
import {
  deleteZoomMeetingForBooking,
  updateZoomMeetingForBooking
} from "@/lib/zoom/meetings";
import { offerFreedSlot } from "@/lib/calendar-tools/waitlist-fill";
import {
  cancelWaitlistForAttendee,
  resolveWaitlistAfterBooking
} from "@/lib/calendar-tools/waitlist-resolve";

/**
 * Appointment lifecycle cores (Truly Issue 4): a reschedule PATCHes the
 * existing provider event (updated invitation, not a second one) and a
 * cancel DELETEs it (single cancellation email). Event resolution is ledger
 * first, provider search second.
 */

const BIZ = "11111111-1111-4111-8111-111111111111";
const PHONE = "+15485773546";

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
const CALENDLY_CONN = { provider: "calendly", connectionId: "c", providerConfigKey: "k" } as never;
const VAGARO_CONN = { provider: "vagaro", connectionId: "v", providerConfigKey: "vk" } as never;
const ACUITY_CONN = { provider: "acuity", connectionId: "a", providerConfigKey: "acuity" } as never;
const CALDAV_CONN = { provider: "caldav", connectionId: "d", providerConfigKey: "dk" } as never;

const RESCHEDULE_ARGS = {
  newStartIso: "2026-07-15T20:00:00.000Z",
  newEndIso: "2026-07-15T20:30:00.000Z",
  attendeePhone: PHONE
};

const CLAIM = {
  id: "claim-1",
  eventId: "evt-1",
  startAt: "2026-07-13T20:00:00Z",
  zoomMeetingId: null
};
const ZOOM_CLAIM = { ...CLAIM, zoomMeetingId: "zm-1" };
const MIRROR_CLAIM = { ...CLAIM, sharedCalendarEventId: "mirror-1" };

beforeEach(() => {
  vi.clearAllMocks();
  // Full reset (not just clear): clearAllMocks leaves mockResolvedValueOnce
  // queues intact, so a test that queues more responses than it consumes
  // would silently shift the next test's queue.
  vi.mocked(workspaceProxyForBusiness).mockReset();
  vi.mocked(getSharedCalendar).mockResolvedValue(null);
  vi.mocked(findUpcomingBookingClaim).mockResolvedValue(null);
  vi.mocked(findUpcomingBookingClaimByPhone).mockResolvedValue(null);
  vi.mocked(findZoomMeetingIdByEvent).mockResolvedValue(null);
});

describe("rescheduleCalendarAppointment", () => {
  it("rejects an inverted window before touching anything", async () => {
    const result = await rescheduleCalendarAppointment(BIZ, {
      ...RESCHEDULE_ARGS,
      newEndIso: RESCHEDULE_ARGS.newStartIso
    });
    expect(result).toEqual({ ok: false, detail: "invalid_window" });
    expect(vi.mocked(resolveCalendarConnection)).not.toHaveBeenCalled();
  });

  it("returns calendar_not_connected when no calendar is linked", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(null as never);
    expect(await rescheduleCalendarAppointment(BIZ, RESCHEDULE_ARGS)).toEqual({
      ok: false,
      detail: "calendar_not_connected"
    });
  });

  it("CalDAV: moves the ledger-resolved event and shifts the claim on success", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(CALDAV_CONN);
    vi.mocked(findUpcomingBookingClaim).mockResolvedValue(CLAIM);
    const moved = {
      ok: true,
      data: { eventId: "evt-1", provider: "caldav", rescheduled: true }
    } as never;
    vi.mocked(rescheduleCaldavAppointment).mockResolvedValue(moved);

    expect(await rescheduleCalendarAppointment(BIZ, RESCHEDULE_ARGS)).toBe(moved);
    expect(vi.mocked(rescheduleCaldavAppointment)).toHaveBeenCalledWith(
      BIZ,
      "evt-1",
      RESCHEDULE_ARGS.newStartIso,
      RESCHEDULE_ARGS.newEndIso
    );
    expect(vi.mocked(rescheduleBookingClaim)).toHaveBeenCalledWith(
      BIZ,
      "phone:+15485773546",
      "claim-1",
      "2026-07-15T20:00:00.000Z"
    );
    expect(vi.mocked(workspaceProxyForBusiness)).not.toHaveBeenCalled();
    expect(vi.mocked(rescheduleVagaroAppointment)).not.toHaveBeenCalled();
  });

  it("CalDAV: booking_not_found without a ledger claim (no provider search exists)", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(CALDAV_CONN);
    expect(await rescheduleCalendarAppointment(BIZ, RESCHEDULE_ARGS)).toEqual({
      ok: false,
      detail: "booking_not_found"
    });
    expect(vi.mocked(rescheduleCaldavAppointment)).not.toHaveBeenCalled();
  });

  it("CalDAV: drops the stale claim when the provider event vanished upstream", async () => {
    // The ledger row survived but the .ics was deleted on the server: the
    // core reports booking_not_found and the dead claim must not keep
    // resolving future lifecycle calls to a gone event.
    vi.mocked(resolveCalendarConnection).mockResolvedValue(CALDAV_CONN);
    vi.mocked(findUpcomingBookingClaim).mockResolvedValue(CLAIM);
    vi.mocked(rescheduleCaldavAppointment).mockResolvedValue({
      ok: false,
      detail: "booking_not_found"
    } as never);
    expect(await rescheduleCalendarAppointment(BIZ, RESCHEDULE_ARGS)).toEqual({
      ok: false,
      detail: "booking_not_found"
    });
    expect(vi.mocked(deleteBookingClaim)).toHaveBeenCalledWith("claim-1");
    expect(vi.mocked(rescheduleBookingClaim)).not.toHaveBeenCalled();
  });

  it("Calendly: delegates to the reschedule-link core with the caller's identity", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(CALENDLY_CONN);
    const linkResult = {
      ok: true,
      detail: "reschedule_link_created",
      data: { rescheduleLink: "https://calendly.com/reschedulings/abc" }
    } as never;
    vi.mocked(createCalendlyRescheduleLink).mockResolvedValue(linkResult);

    expect(await rescheduleCalendarAppointment(BIZ, RESCHEDULE_ARGS)).toBe(linkResult);
    expect(vi.mocked(createCalendlyRescheduleLink)).toHaveBeenCalledWith(BIZ, CALENDLY_CONN, {
      phone: PHONE,
      email: null
    });
    expect(vi.mocked(workspaceProxyForBusiness)).not.toHaveBeenCalled();
    // No ledger writes: Calendly link bookings never hold ledger rows.
    expect(vi.mocked(rescheduleBookingClaim)).not.toHaveBeenCalled();
  });

  it("Calendly: forwards the attendee email when provided", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(CALENDLY_CONN);
    vi.mocked(createCalendlyRescheduleLink).mockResolvedValue({
      ok: false,
      detail: "booking_not_found"
    } as never);
    await rescheduleCalendarAppointment(BIZ, {
      ...RESCHEDULE_ARGS,
      attendeeEmail: "joe@acme.com"
    });
    expect(vi.mocked(createCalendlyRescheduleLink)).toHaveBeenCalledWith(BIZ, CALENDLY_CONN, {
      phone: PHONE,
      email: "joe@acme.com"
    });
  });

  it("Vagaro: moves the ledger-resolved appointment and shifts the claim on success", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(VAGARO_CONN);
    vi.mocked(findUpcomingBookingClaim).mockResolvedValue(CLAIM);
    const moved = {
      ok: true,
      data: { eventId: "evt-1", provider: "vagaro", rescheduled: true }
    } as never;
    vi.mocked(rescheduleVagaroAppointment).mockResolvedValue(moved);

    expect(await rescheduleCalendarAppointment(BIZ, RESCHEDULE_ARGS)).toBe(moved);
    expect(vi.mocked(rescheduleVagaroAppointment)).toHaveBeenCalledWith(
      BIZ,
      "evt-1",
      RESCHEDULE_ARGS.newStartIso,
      RESCHEDULE_ARGS.newEndIso
    );
    expect(vi.mocked(rescheduleBookingClaim)).toHaveBeenCalledWith(
      BIZ,
      "phone:+15485773546",
      "claim-1",
      "2026-07-15T20:00:00.000Z"
    );
  });

  it("Acuity: moves the ledger-resolved appointment and shifts the claim on success", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(ACUITY_CONN);
    vi.mocked(findUpcomingBookingClaim).mockResolvedValue(CLAIM);
    const moved = {
      ok: true,
      data: { eventId: "evt-1", provider: "acuity", rescheduled: true }
    } as never;
    vi.mocked(rescheduleAcuityAppointment).mockResolvedValue(moved);

    expect(await rescheduleCalendarAppointment(BIZ, RESCHEDULE_ARGS)).toBe(moved);
    expect(vi.mocked(rescheduleAcuityAppointment)).toHaveBeenCalledWith(
      BIZ,
      "evt-1",
      RESCHEDULE_ARGS.newStartIso,
      RESCHEDULE_ARGS.newEndIso
    );
    expect(vi.mocked(rescheduleBookingClaim)).toHaveBeenCalled();
  });

  it("Acuity: drops a stale claim when the provider no longer has the appointment", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(ACUITY_CONN);
    vi.mocked(findUpcomingBookingClaim).mockResolvedValue(CLAIM);
    vi.mocked(rescheduleAcuityAppointment).mockResolvedValue({
      ok: false,
      detail: "booking_not_found"
    } as never);
    await rescheduleCalendarAppointment(BIZ, RESCHEDULE_ARGS);
    expect(vi.mocked(deleteBookingClaim)).toHaveBeenCalledWith("claim-1");
  });

  it("moves the shared-calendar mirror with the appointment", async () => {
    // A mirror left at the old time is worse than none: the team plans
    // around an appointment that is no longer there.
    vi.mocked(resolveCalendarConnection).mockResolvedValue(VAGARO_CONN);
    vi.mocked(findUpcomingBookingClaim).mockResolvedValue(MIRROR_CLAIM);
    vi.mocked(rescheduleVagaroAppointment).mockResolvedValue({ ok: true, data: {} } as never);
    await rescheduleCalendarAppointment(BIZ, RESCHEDULE_ARGS);
    expect(vi.mocked(moveSharedCalendarMirror)).toHaveBeenCalledWith(
      BIZ,
      "mirror-1",
      RESCHEDULE_ARGS.newStartIso,
      RESCHEDULE_ARGS.newEndIso
    );
  });

  it("removes the mirror when the provider says the appointment is GONE", async () => {
    // booking_not_found drops the stale claim; the mirror must go with it,
    // or the team calendar keeps showing an appointment that no longer
    // exists anywhere.
    vi.mocked(resolveCalendarConnection).mockResolvedValue(VAGARO_CONN);
    vi.mocked(findUpcomingBookingClaim).mockResolvedValue(MIRROR_CLAIM);
    vi.mocked(rescheduleVagaroAppointment).mockResolvedValue({
      ok: false,
      detail: "booking_not_found"
    } as never);
    await rescheduleCalendarAppointment(BIZ, RESCHEDULE_ARGS);
    expect(vi.mocked(removeSharedCalendarMirror)).toHaveBeenCalledWith(BIZ, "mirror-1");
    expect(vi.mocked(deleteBookingClaim)).toHaveBeenCalledWith("claim-1");
  });

  it("touches no mirror when the booking never had one", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(VAGARO_CONN);
    vi.mocked(findUpcomingBookingClaim).mockResolvedValue(CLAIM);
    vi.mocked(rescheduleVagaroAppointment).mockResolvedValue({ ok: true, data: {} } as never);
    await rescheduleCalendarAppointment(BIZ, RESCHEDULE_ARGS);
    expect(vi.mocked(moveSharedCalendarMirror)).not.toHaveBeenCalled();
  });

  it("Vagaro: keeps the claim in place when the provider move fails", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(VAGARO_CONN);
    vi.mocked(findUpcomingBookingClaim).mockResolvedValue(CLAIM);
    vi.mocked(rescheduleVagaroAppointment).mockResolvedValue({
      ok: false,
      detail: "vagaro_auth_failed"
    } as never);
    expect(await rescheduleCalendarAppointment(BIZ, RESCHEDULE_ARGS)).toEqual({
      ok: false,
      detail: "vagaro_auth_failed"
    });
    expect(vi.mocked(rescheduleBookingClaim)).not.toHaveBeenCalled();
  });

  it("Vagaro: booking_not_found without a ledger claim (no provider search exists)", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(VAGARO_CONN);
    expect(await rescheduleCalendarAppointment(BIZ, RESCHEDULE_ARGS)).toEqual({
      ok: false,
      detail: "booking_not_found"
    });
    expect(vi.mocked(rescheduleVagaroAppointment)).not.toHaveBeenCalled();
    // The tolerant fallback ran (a phone exists), it just found nothing.
    expect(vi.mocked(findUpcomingBookingClaimByPhone)).toHaveBeenCalledWith(BIZ, PHONE);
  });

  it("Vagaro: the phone-tolerant fallback resolves format drift and moves the ROW's key", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(VAGARO_CONN);
    // Exact key misses (booking stored a different phone shape) …
    vi.mocked(findUpcomingBookingClaim).mockResolvedValue(null);
    // … the digits-tolerant lookup finds the row, carrying ITS stored key.
    vi.mocked(findUpcomingBookingClaimByPhone).mockResolvedValue({
      ...CLAIM,
      attendeeKey: "phone:5485773546"
    });
    vi.mocked(rescheduleVagaroAppointment).mockResolvedValue({
      ok: true,
      data: { eventId: "evt-1" }
    } as never);

    expect((await rescheduleCalendarAppointment(BIZ, RESCHEDULE_ARGS)).ok).toBe(true);
    // Ledger move targets the key the row is stored under, not the caller's.
    expect(vi.mocked(rescheduleBookingClaim)).toHaveBeenCalledWith(
      BIZ,
      "phone:5485773546",
      "claim-1",
      "2026-07-15T20:00:00.000Z"
    );
  });

  it("Vagaro: no tolerant fallback without a phone (email-only identity)", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(VAGARO_CONN);
    expect(
      await rescheduleCalendarAppointment(BIZ, {
        newStartIso: RESCHEDULE_ARGS.newStartIso,
        newEndIso: RESCHEDULE_ARGS.newEndIso,
        attendeeEmail: "joe@acme.com"
      })
    ).toEqual({ ok: false, detail: "booking_not_found" });
    expect(vi.mocked(findUpcomingBookingClaimByPhone)).not.toHaveBeenCalled();
  });

  it("booking_not_found when neither the ledger nor the provider search locates an event", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(GOOGLE_CONN);
    vi.mocked(workspaceProxyForBusiness).mockResolvedValue({ data: { items: [] } } as never);
    expect(await rescheduleCalendarAppointment(BIZ, RESCHEDULE_ARGS)).toEqual({
      ok: false,
      detail: "booking_not_found"
    });
  });

  it("booking_not_found with NO provider search when the caller gives no identity at all", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(GOOGLE_CONN);
    const result = await rescheduleCalendarAppointment(BIZ, {
      newStartIso: RESCHEDULE_ARGS.newStartIso,
      newEndIso: RESCHEDULE_ARGS.newEndIso
    });
    expect(result).toEqual({ ok: false, detail: "booking_not_found" });
    expect(vi.mocked(workspaceProxyForBusiness)).not.toHaveBeenCalled();
  });

  it("PATCHes the Google event from the ledger claim and moves the claim to the new start", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(GOOGLE_CONN);
    vi.mocked(findUpcomingBookingClaim).mockResolvedValue(CLAIM);
    vi.mocked(workspaceProxyForBusiness).mockResolvedValue({ data: {} } as never);

    const result = await rescheduleCalendarAppointment(BIZ, RESCHEDULE_ARGS);
    expect(result).toEqual({
      ok: true,
      data: {
        eventId: "evt-1",
        provider: "google",
        startIso: "2026-07-15T20:00:00.000Z",
        endIso: "2026-07-15T20:30:00.000Z",
        rescheduled: true
      }
    });
    const [, , config] = vi.mocked(workspaceProxyForBusiness).mock.calls[0];
    expect(config).toMatchObject({
      endpoint: "/calendar/v3/calendars/primary/events/evt-1",
      method: "PATCH",
      data: {
        start: { dateTime: "2026-07-15T20:00:00.000Z", timeZone: "America/New_York" },
        end: { dateTime: "2026-07-15T20:30:00.000Z", timeZone: "America/New_York" }
      }
    });
    expect(vi.mocked(rescheduleBookingClaim)).toHaveBeenCalledWith(
      BIZ,
      "phone:+15485773546",
      "claim-1",
      "2026-07-15T20:00:00.000Z"
    );
    expect(vi.mocked(recordExternalBookingClaim)).not.toHaveBeenCalled();
  });

  it("tries the shared NewCoworker calendar first, falling back to primary when it 404s", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(GOOGLE_CONN);
    vi.mocked(findUpcomingBookingClaim).mockResolvedValue(CLAIM);
    vi.mocked(getSharedCalendar).mockResolvedValue({ calendarId: "shared-cal" } as never);
    vi.mocked(workspaceProxyForBusiness)
      .mockRejectedValueOnce(new Error("404 not found"))
      .mockResolvedValueOnce({ data: {} } as never);

    const result = await rescheduleCalendarAppointment(BIZ, RESCHEDULE_ARGS);
    expect(result.ok).toBe(true);
    const endpoints = vi
      .mocked(workspaceProxyForBusiness)
      .mock.calls.map((c) => (c[2] as { endpoint: string }).endpoint);
    expect(endpoints).toEqual([
      "/calendar/v3/calendars/shared-cal/events/evt-1",
      "/calendar/v3/calendars/primary/events/evt-1"
    ]);
  });

  it("calendar_reschedule_failed when every Google calendar attempt fails", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(GOOGLE_CONN);
    vi.mocked(findUpcomingBookingClaim).mockResolvedValue(CLAIM);
    vi.mocked(workspaceProxyForBusiness).mockRejectedValue(new Error("boom"));
    expect(await rescheduleCalendarAppointment(BIZ, RESCHEDULE_ARGS)).toEqual({
      ok: false,
      detail: "calendar_reschedule_failed"
    });
    expect(vi.mocked(rescheduleBookingClaim)).not.toHaveBeenCalled();
  });

  it("a null Google mutate response counts as a failed attempt (not a success)", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(GOOGLE_CONN);
    vi.mocked(findUpcomingBookingClaim).mockResolvedValue(CLAIM);
    vi.mocked(workspaceProxyForBusiness).mockResolvedValue(null as never);
    expect(await rescheduleCalendarAppointment(BIZ, RESCHEDULE_ARGS)).toEqual({
      ok: false,
      detail: "calendar_reschedule_failed"
    });
  });

  it("PATCHes the Microsoft event with naive wall time and records an external claim for a searched event", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(MS_CONN);
    // Not in the ledger (pre-ledger booking) → provider search finds it via
    // the FULL body: long notes push the Phone: marker out of bodyPreview
    // (Graph truncates it), so the truncated preview alone must not decide.
    vi.mocked(workspaceProxyForBusiness)
      .mockResolvedValueOnce({
        data: {
          value: [
            {
              id: "evt-search",
              bodyPreview: "Very long free-form notes that crowd out the marker…",
              body: {
                content: `<html>Very long notes…\nAttendee: Joe\nPhone: ${PHONE}</html>`
              }
            }
          ]
        }
      } as never)
      .mockResolvedValueOnce({ data: {} } as never);

    const result = await rescheduleCalendarAppointment(BIZ, RESCHEDULE_ARGS);
    expect(result.ok).toBe(true);
    expect((result.data as { eventId: string }).eventId).toBe("evt-search");
    const patchCall = vi.mocked(workspaceProxyForBusiness).mock.calls[1][2] as {
      endpoint: string;
      method: string;
      data: { start: { dateTime: string; timeZone: string } };
    };
    expect(patchCall.endpoint).toBe("/v1.0/me/events/evt-search");
    expect(patchCall.method).toBe("PATCH");
    expect(patchCall.data.start.dateTime).toBe("wall(2026-07-15T20:00:00.000Z,America/New_York)");
    // A searched event may hold a ledger row under a DIFFERENT attendee key
    // (booked by phone, rescheduled by email): stale rows are dropped by
    // event id before the fresh claim is recorded.
    expect(vi.mocked(deleteBookingClaimsByEvent)).toHaveBeenCalledWith(BIZ, "evt-search");
    expect(vi.mocked(recordExternalBookingClaim)).toHaveBeenCalledWith(
      BIZ,
      "phone:+15485773546",
      "2026-07-15T20:00:00.000Z",
      "evt-search"
    );
  });

  it("Microsoft search scans the shared calendar view first and skips non-matching events", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(MS_CONN);
    vi.mocked(getSharedCalendar).mockResolvedValue({ calendarId: "shared-ms" } as never);
    vi.mocked(workspaceProxyForBusiness)
      // Shared view: an event for someone else, no match (bodyPreview-only
      // rows still match when short enough; id-less rows are skipped).
      .mockResolvedValueOnce({
        data: { value: [{ id: "evt-other", bodyPreview: "Phone: +15550000000" }, { bodyPreview: PHONE }] }
      } as never)
      // Default view: the match.
      .mockResolvedValueOnce({
        data: { value: [{ id: "evt-mine", bodyPreview: `Phone: ${PHONE}` }] }
      } as never)
      .mockResolvedValueOnce({ data: {} } as never);

    const result = await rescheduleCalendarAppointment(BIZ, RESCHEDULE_ARGS);
    expect(result.ok).toBe(true);
    const endpoints = vi
      .mocked(workspaceProxyForBusiness)
      .mock.calls.map((c) => (c[2] as { endpoint: string }).endpoint);
    expect(endpoints[0]).toBe("/v1.0/me/calendars/shared-ms/calendarView");
    expect(endpoints[1]).toBe("/v1.0/me/calendarView");
  });

  it("Microsoft search tolerates per-view failures and empty bodies", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(MS_CONN);
    vi.mocked(workspaceProxyForBusiness)
      .mockRejectedValueOnce(new Error("view down"))
      .mockResolvedValueOnce(null as never);
    expect(await rescheduleCalendarAppointment(BIZ, RESCHEDULE_ARGS)).toEqual({
      ok: false,
      detail: "booking_not_found"
    });
  });

  it("Microsoft search tolerates non-Error throws, missing value arrays, and preview-less events", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(MS_CONN);
    vi.mocked(getSharedCalendar).mockResolvedValue({ calendarId: "shared-ms" } as never);
    vi.mocked(workspaceProxyForBusiness)
      .mockRejectedValueOnce("raw view failure" as never) // shared view: non-Error throw
      .mockResolvedValueOnce({ data: { value: [{ id: "evt-no-preview" }] } } as never); // no bodyPreview → no match
    expect(await rescheduleCalendarAppointment(BIZ, RESCHEDULE_ARGS)).toEqual({
      ok: false,
      detail: "booking_not_found"
    });

    vi.mocked(getSharedCalendar).mockResolvedValue(null);
    vi.mocked(workspaceProxyForBusiness).mockReset();
    vi.mocked(workspaceProxyForBusiness).mockResolvedValueOnce({ data: {} } as never); // no value key
    expect(await rescheduleCalendarAppointment(BIZ, RESCHEDULE_ARGS)).toEqual({
      ok: false,
      detail: "booking_not_found"
    });

    vi.mocked(workspaceProxyForBusiness).mockReset();
    vi.mocked(workspaceProxyForBusiness).mockResolvedValueOnce({ data: undefined } as never); // response without data
    expect(await rescheduleCalendarAppointment(BIZ, RESCHEDULE_ARGS)).toEqual({
      ok: false,
      detail: "booking_not_found"
    });
  });

  it("Google search tolerates null responses, missing items, and non-Error throws", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(GOOGLE_CONN);
    vi.mocked(getSharedCalendar).mockResolvedValue({ calendarId: "shared-cal" } as never);
    vi.mocked(workspaceProxyForBusiness)
      .mockResolvedValueOnce(null as never) // shared search: null response
      .mockResolvedValueOnce({ data: undefined } as never); // primary: response without data
    expect(await rescheduleCalendarAppointment(BIZ, RESCHEDULE_ARGS)).toEqual({
      ok: false,
      detail: "booking_not_found"
    });

    vi.mocked(workspaceProxyForBusiness).mockReset();
    vi.mocked(getSharedCalendar).mockResolvedValue(null);
    vi.mocked(workspaceProxyForBusiness).mockRejectedValueOnce("raw search failure" as never);
    expect(await rescheduleCalendarAppointment(BIZ, RESCHEDULE_ARGS)).toEqual({
      ok: false,
      detail: "booking_not_found"
    });
  });

  it("Google mutate tolerates a non-Error throw on one calendar attempt", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(GOOGLE_CONN);
    vi.mocked(findUpcomingBookingClaim).mockResolvedValue(CLAIM);
    vi.mocked(getSharedCalendar).mockResolvedValue({ calendarId: "shared-cal" } as never);
    vi.mocked(workspaceProxyForBusiness)
      .mockRejectedValueOnce("raw patch failure" as never)
      .mockResolvedValueOnce({ data: {} } as never);
    expect((await rescheduleCalendarAppointment(BIZ, RESCHEDULE_ARGS)).ok).toBe(true);
  });

  it("a null Microsoft PATCH response is a FAILED MUTATION, never calendar_not_connected", async () => {
    // The connection resolved moments earlier, misreporting it as missing
    // would steer the model to "you cannot change any appointment".
    vi.mocked(resolveCalendarConnection).mockResolvedValue(MS_CONN);
    vi.mocked(findUpcomingBookingClaim).mockResolvedValue(CLAIM);
    vi.mocked(workspaceProxyForBusiness).mockResolvedValue(null as never);
    expect(await rescheduleCalendarAppointment(BIZ, RESCHEDULE_ARGS)).toEqual({
      ok: false,
      detail: "calendar_reschedule_failed"
    });
  });

  it("marker matching is boundary-guarded: a longer number or wrapping email never matches", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(MS_CONN);
    vi.mocked(workspaceProxyForBusiness).mockResolvedValueOnce({
      data: {
        value: [
          // The lead's E.164 as a PREFIX of a longer number, not a match.
          { id: "evt-longer", bodyPreview: `Phone: ${PHONE}789` },
          // The email marker inside a longer address, not a match either.
          { id: "evt-wrapped", bodyPreview: "Email: notjoe@acme.com" }
        ]
      }
    } as never);
    expect(await rescheduleCalendarAppointment(BIZ, RESCHEDULE_ARGS)).toEqual({
      ok: false,
      detail: "booking_not_found"
    });
  });

  it("Google search falls back to the email marker and tolerates search errors", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(GOOGLE_CONN);
    vi.mocked(getSharedCalendar).mockResolvedValue({ calendarId: "shared-cal" } as never);
    vi.mocked(workspaceProxyForBusiness)
      .mockRejectedValueOnce(new Error("search boom")) // shared search fails
      .mockResolvedValueOnce({
        // Primary search: a loose q hit WITHOUT the marker in its description
        // must be rejected; only the verified event wins.
        data: {
          items: [
            { id: "evt-fuzzy", description: "unrelated event that q matched loosely" },
            { id: "evt-bare" }, // no description at all, also rejected
            // Stored with the form's original casing; the lowercased marker
            // must still match (case-insensitive verification).
            { id: "evt-mail", description: "Attendee: Joe\nEmail: Joe@Acme.com" }
          ]
        }
      } as never)
      .mockResolvedValueOnce({ data: {} } as never); // PATCH shared succeeds

    const result = await rescheduleCalendarAppointment(BIZ, {
      newStartIso: RESCHEDULE_ARGS.newStartIso,
      newEndIso: RESCHEDULE_ARGS.newEndIso,
      attendeeEmail: "joe@acme.com"
    });
    expect(result.ok).toBe(true);
    const searchCall = vi.mocked(workspaceProxyForBusiness).mock.calls[1][2] as unknown as {
      params: { q: string };
    };
    expect(searchCall.params.q).toBe("joe@acme.com");
    // The unverified fuzzy hit lost; the marker-verified event was mutated.
    const patchCall = vi.mocked(workspaceProxyForBusiness).mock.calls[2][2] as { endpoint: string };
    expect(patchCall.endpoint).toContain("evt-mail");
    expect(patchCall.endpoint).not.toContain("evt-fuzzy");
  });

  it("uses the surface fallback phone when the model omits attendee identity", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(MS_CONN);
    vi.mocked(findUpcomingBookingClaim).mockResolvedValue(CLAIM);
    vi.mocked(workspaceProxyForBusiness).mockResolvedValue({ data: {} } as never);
    const result = await rescheduleCalendarAppointment(
      BIZ,
      { newStartIso: RESCHEDULE_ARGS.newStartIso, newEndIso: RESCHEDULE_ARGS.newEndIso },
      PHONE
    );
    expect(result.ok).toBe(true);
  });

  it("maps unexpected throws (Error and non-Error) to calendar_reschedule_failed", async () => {
    vi.mocked(resolveCalendarConnection).mockRejectedValue(new Error("resolver down"));
    expect((await rescheduleCalendarAppointment(BIZ, RESCHEDULE_ARGS)).detail).toBe(
      "calendar_reschedule_failed"
    );
    vi.mocked(resolveCalendarConnection).mockRejectedValue("string failure");
    expect((await rescheduleCalendarAppointment(BIZ, RESCHEDULE_ARGS)).detail).toBe(
      "calendar_reschedule_failed"
    );
  });
});

describe("cancelCalendarAppointment", () => {
  const CANCEL_ARGS = { attendeePhone: PHONE };

  it("returns calendar_not_connected when no calendar is linked", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(null as never);
    expect(await cancelCalendarAppointment(BIZ, CANCEL_ARGS)).toEqual({
      ok: false,
      detail: "calendar_not_connected"
    });
  });

  it("CalDAV: cancels the ledger-resolved event and drops the claim", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(CALDAV_CONN);
    vi.mocked(findUpcomingBookingClaim).mockResolvedValue(CLAIM);
    const canceled = {
      ok: true,
      data: { eventId: "evt-1", provider: "caldav", canceled: true }
    } as never;
    vi.mocked(cancelCaldavAppointment).mockResolvedValue(canceled);

    expect(await cancelCalendarAppointment(BIZ, CANCEL_ARGS)).toBe(canceled);
    expect(vi.mocked(cancelCaldavAppointment)).toHaveBeenCalledWith(BIZ, "evt-1");
    expect(vi.mocked(deleteBookingClaim)).toHaveBeenCalledWith("claim-1");
    expect(vi.mocked(cancelVagaroAppointment)).not.toHaveBeenCalled();
  });

  it("CalDAV: keeps the claim when the provider cancel fails", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(CALDAV_CONN);
    vi.mocked(findUpcomingBookingClaim).mockResolvedValue(CLAIM);
    vi.mocked(cancelCaldavAppointment).mockResolvedValue({
      ok: false,
      detail: "calendar_cancel_failed"
    } as never);
    expect(await cancelCalendarAppointment(BIZ, CANCEL_ARGS)).toEqual({
      ok: false,
      detail: "calendar_cancel_failed"
    });
    expect(vi.mocked(deleteBookingClaim)).not.toHaveBeenCalled();
  });

  it("CalDAV: booking_not_found without a ledger claim", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(CALDAV_CONN);
    expect(await cancelCalendarAppointment(BIZ, CANCEL_ARGS)).toEqual({
      ok: false,
      detail: "booking_not_found"
    });
    expect(vi.mocked(cancelCaldavAppointment)).not.toHaveBeenCalled();
  });

  it("Calendly: delegates to the API-side cancellation core", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(CALENDLY_CONN);
    const canceled = {
      ok: true,
      data: { eventId: "uuid-1", provider: "calendly", canceled: true }
    } as never;
    vi.mocked(cancelCalendlyAppointment).mockResolvedValue(canceled);

    expect(await cancelCalendarAppointment(BIZ, { ...CANCEL_ARGS, attendeeEmail: "joe@acme.com" })).toBe(
      canceled
    );
    expect(vi.mocked(cancelCalendlyAppointment)).toHaveBeenCalledWith(BIZ, CALENDLY_CONN, {
      phone: PHONE,
      email: "joe@acme.com"
    });
    expect(vi.mocked(workspaceProxyForBusiness)).not.toHaveBeenCalled();
  });

  it("Calendly: null email when the model omits it", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(CALENDLY_CONN);
    vi.mocked(cancelCalendlyAppointment).mockResolvedValue({
      ok: false,
      detail: "booking_not_found"
    } as never);
    await cancelCalendarAppointment(BIZ, CANCEL_ARGS);
    expect(vi.mocked(cancelCalendlyAppointment)).toHaveBeenCalledWith(BIZ, CALENDLY_CONN, {
      phone: PHONE,
      email: null
    });
  });

  it("Vagaro: cancels the ledger-resolved appointment and drops the claim", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(VAGARO_CONN);
    vi.mocked(findUpcomingBookingClaim).mockResolvedValue(CLAIM);
    const canceled = {
      ok: true,
      data: { eventId: "evt-1", provider: "vagaro", canceled: true }
    } as never;
    vi.mocked(cancelVagaroAppointment).mockResolvedValue(canceled);

    expect(await cancelCalendarAppointment(BIZ, CANCEL_ARGS)).toBe(canceled);
    expect(vi.mocked(cancelVagaroAppointment)).toHaveBeenCalledWith(BIZ, "evt-1");
    expect(vi.mocked(deleteBookingClaim)).toHaveBeenCalledWith("claim-1");
  });

  it("Acuity: cancels with the LEDGER START so an irreversible cancel cannot hit the wrong appointment", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(ACUITY_CONN);
    vi.mocked(findUpcomingBookingClaim).mockResolvedValue(CLAIM);
    const canceled = {
      ok: true,
      data: { eventId: "evt-1", provider: "acuity", canceled: true }
    } as never;
    vi.mocked(cancelAcuityAppointment).mockResolvedValue(canceled);

    expect(await cancelCalendarAppointment(BIZ, CANCEL_ARGS)).toBe(canceled);
    // The third argument is the guard: the core refuses if the appointment
    // it finds does not start when the ledger says it should.
    expect(vi.mocked(cancelAcuityAppointment)).toHaveBeenCalledWith(
      BIZ,
      "evt-1",
      "2026-07-13T20:00:00.000Z"
    );
    expect(vi.mocked(deleteBookingClaim)).toHaveBeenCalledWith("claim-1");
  });

  it("removes the shared-calendar mirror when the appointment is canceled", async () => {
    // The half that makes mirroring safe: a mirror surviving its
    // cancellation shows the team an appointment that is not happening.
    vi.mocked(resolveCalendarConnection).mockResolvedValue(VAGARO_CONN);
    vi.mocked(findUpcomingBookingClaim).mockResolvedValue(MIRROR_CLAIM);
    vi.mocked(cancelVagaroAppointment).mockResolvedValue({ ok: true, data: {} } as never);
    await cancelCalendarAppointment(BIZ, CANCEL_ARGS);
    expect(vi.mocked(removeSharedCalendarMirror)).toHaveBeenCalledWith(BIZ, "mirror-1");
  });

  it("drops the stale claim AND its mirror when cancel says the appointment is gone", async () => {
    // The symmetric case to the reschedule path: booking_not_found means the
    // row points at something the provider cannot find, so both the claim
    // and the mirror representing it must go.
    vi.mocked(resolveCalendarConnection).mockResolvedValue(VAGARO_CONN);
    vi.mocked(findUpcomingBookingClaim).mockResolvedValue(MIRROR_CLAIM);
    vi.mocked(cancelVagaroAppointment).mockResolvedValue({
      ok: false,
      detail: "booking_not_found"
    } as never);
    await cancelCalendarAppointment(BIZ, CANCEL_ARGS);
    expect(vi.mocked(removeSharedCalendarMirror)).toHaveBeenCalledWith(BIZ, "mirror-1");
    expect(vi.mocked(deleteBookingClaim)).toHaveBeenCalledWith("claim-1");
  });

  it("drops a mirror-less stale claim without touching the mirror remover", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(VAGARO_CONN);
    vi.mocked(findUpcomingBookingClaim).mockResolvedValue(CLAIM);
    vi.mocked(cancelVagaroAppointment).mockResolvedValue({
      ok: false,
      detail: "booking_not_found"
    } as never);
    await cancelCalendarAppointment(BIZ, CANCEL_ARGS);
    expect(vi.mocked(removeSharedCalendarMirror)).not.toHaveBeenCalled();
    expect(vi.mocked(deleteBookingClaim)).toHaveBeenCalledWith("claim-1");
  });

  it("keeps the claim and mirror on a mere provider failure", async () => {
    // auth_failed or transport trouble is not "the appointment is gone";
    // the claim must survive for a retry to resolve.
    vi.mocked(resolveCalendarConnection).mockResolvedValue(VAGARO_CONN);
    vi.mocked(findUpcomingBookingClaim).mockResolvedValue(MIRROR_CLAIM);
    vi.mocked(cancelVagaroAppointment).mockResolvedValue({
      ok: false,
      detail: "vagaro_auth_failed"
    } as never);
    await cancelCalendarAppointment(BIZ, CANCEL_ARGS);
    expect(vi.mocked(removeSharedCalendarMirror)).not.toHaveBeenCalled();
    expect(vi.mocked(deleteBookingClaim)).not.toHaveBeenCalled();
  });

  it("removes no mirror when the booking never had one", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(VAGARO_CONN);
    vi.mocked(findUpcomingBookingClaim).mockResolvedValue(CLAIM);
    vi.mocked(cancelVagaroAppointment).mockResolvedValue({ ok: true, data: {} } as never);
    await cancelCalendarAppointment(BIZ, CANCEL_ARGS);
    expect(vi.mocked(removeSharedCalendarMirror)).not.toHaveBeenCalled();
  });

  it("Vagaro: keeps the claim when the provider cancel fails", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(VAGARO_CONN);
    vi.mocked(findUpcomingBookingClaim).mockResolvedValue(CLAIM);
    vi.mocked(cancelVagaroAppointment).mockResolvedValue({
      ok: false,
      detail: "calendar_cancel_failed"
    } as never);
    expect(await cancelCalendarAppointment(BIZ, CANCEL_ARGS)).toEqual({
      ok: false,
      detail: "calendar_cancel_failed"
    });
    expect(vi.mocked(deleteBookingClaim)).not.toHaveBeenCalled();
  });

  it("Vagaro: booking_not_found without a ledger claim", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(VAGARO_CONN);
    expect(await cancelCalendarAppointment(BIZ, CANCEL_ARGS)).toEqual({
      ok: false,
      detail: "booking_not_found"
    });
    expect(vi.mocked(cancelVagaroAppointment)).not.toHaveBeenCalled();
  });

  it("Vagaro: the phone-tolerant fallback resolves format drift on cancel", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(VAGARO_CONN);
    vi.mocked(findUpcomingBookingClaimByPhone).mockResolvedValue({
      ...CLAIM,
      attendeeKey: "phone:5485773546"
    });
    vi.mocked(cancelVagaroAppointment).mockResolvedValue({ ok: true } as never);
    expect((await cancelCalendarAppointment(BIZ, CANCEL_ARGS)).ok).toBe(true);
    expect(vi.mocked(cancelVagaroAppointment)).toHaveBeenCalledWith(BIZ, "evt-1");
    expect(vi.mocked(deleteBookingClaim)).toHaveBeenCalledWith("claim-1");
  });

  it("booking_not_found when nothing locates the event", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(GOOGLE_CONN);
    vi.mocked(workspaceProxyForBusiness).mockResolvedValue({ data: { items: [] } } as never);
    expect(await cancelCalendarAppointment(BIZ, CANCEL_ARGS)).toEqual({
      ok: false,
      detail: "booking_not_found"
    });
  });

  it("falls back to the email marker, the surface phone, or refuses with no identity at all", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(MS_CONN);
    vi.mocked(findUpcomingBookingClaim).mockResolvedValue(CLAIM);
    vi.mocked(workspaceProxyForBusiness).mockResolvedValue({ data: {} } as never);
    // Email-only identity: still resolves via the ledger key.
    expect((await cancelCalendarAppointment(BIZ, { attendeeEmail: "joe@acme.com" })).ok).toBe(true);
    // No model-provided identity: the surface fallback phone carries it.
    expect((await cancelCalendarAppointment(BIZ, {}, PHONE)).ok).toBe(true);

    // No identity at all: no ledger row, no searchable marker → not found.
    vi.mocked(findUpcomingBookingClaim).mockResolvedValue(null);
    expect(await cancelCalendarAppointment(BIZ, {})).toEqual({
      ok: false,
      detail: "booking_not_found"
    });
    expect(await cancelCalendarAppointment(BIZ, { attendeeName: "Joe" })).toEqual({
      ok: false,
      detail: "booking_not_found"
    });
  });

  it("DELETEs the Google event and drops the ledger claim", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(GOOGLE_CONN);
    vi.mocked(findUpcomingBookingClaim).mockResolvedValue(CLAIM);
    vi.mocked(workspaceProxyForBusiness).mockResolvedValue({ data: {} } as never);

    const result = await cancelCalendarAppointment(BIZ, CANCEL_ARGS);
    expect(result).toEqual({
      ok: true,
      data: { eventId: "evt-1", provider: "google", canceled: true }
    });
    const [, , config] = vi.mocked(workspaceProxyForBusiness).mock.calls[0];
    expect(config).toMatchObject({
      endpoint: "/calendar/v3/calendars/primary/events/evt-1",
      method: "DELETE"
    });
    expect(vi.mocked(deleteBookingClaim)).toHaveBeenCalledWith("claim-1");
  });

  it("calendar_cancel_failed when every Google delete attempt fails (claim kept)", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(GOOGLE_CONN);
    vi.mocked(findUpcomingBookingClaim).mockResolvedValue(CLAIM);
    vi.mocked(workspaceProxyForBusiness).mockRejectedValue(new Error("boom"));
    expect(await cancelCalendarAppointment(BIZ, CANCEL_ARGS)).toEqual({
      ok: false,
      detail: "calendar_cancel_failed"
    });
    expect(vi.mocked(deleteBookingClaim)).not.toHaveBeenCalled();
  });

  it("DELETEs the Microsoft event; a searched (ledger-less) event cleans the ledger BY EVENT ID", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(MS_CONN);
    vi.mocked(workspaceProxyForBusiness)
      .mockResolvedValueOnce({
        data: { value: [{ id: "evt-search", bodyPreview: `Phone: ${PHONE}` }] }
      } as never)
      .mockResolvedValueOnce({ data: {} } as never);

    const result = await cancelCalendarAppointment(BIZ, CANCEL_ARGS);
    expect(result).toEqual({
      ok: true,
      data: { eventId: "evt-search", provider: "microsoft", canceled: true }
    });
    const deleteCall = vi.mocked(workspaceProxyForBusiness).mock.calls[1][2] as {
      endpoint: string;
      method: string;
    };
    expect(deleteCall).toMatchObject({ endpoint: "/v1.0/me/events/evt-search", method: "DELETE" });
    // No claim under OUR key, but the event may hold rows under other keys,
    // a canceled slot must not survive as "booked" in the ledger.
    expect(vi.mocked(deleteBookingClaim)).not.toHaveBeenCalled();
    expect(vi.mocked(deleteBookingClaimsByEvent)).toHaveBeenCalledWith(BIZ, "evt-search");
  });

  it("a null Microsoft DELETE response is a FAILED MUTATION, never calendar_not_connected", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(MS_CONN);
    vi.mocked(findUpcomingBookingClaim).mockResolvedValue(CLAIM);
    vi.mocked(workspaceProxyForBusiness).mockResolvedValue(null as never);
    expect(await cancelCalendarAppointment(BIZ, CANCEL_ARGS)).toEqual({
      ok: false,
      detail: "calendar_cancel_failed"
    });
  });

  it("maps unexpected throws (Error and non-Error) to calendar_cancel_failed", async () => {
    vi.mocked(resolveCalendarConnection).mockRejectedValue(new Error("resolver down"));
    expect((await cancelCalendarAppointment(BIZ, CANCEL_ARGS)).detail).toBe(
      "calendar_cancel_failed"
    );
    vi.mocked(resolveCalendarConnection).mockRejectedValue("string failure");
    expect((await cancelCalendarAppointment(BIZ, CANCEL_ARGS)).detail).toBe(
      "calendar_cancel_failed"
    );
  });
});

describe("Zoom meeting lifecycle rides the booking's ledger row", () => {
  const CANCEL_ARGS = { attendeePhone: PHONE };

  it("Google reschedule moves the Zoom meeting with the event", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(GOOGLE_CONN);
    vi.mocked(findUpcomingBookingClaim).mockResolvedValue(ZOOM_CLAIM);
    vi.mocked(workspaceProxyForBusiness).mockResolvedValue({ data: {} } as never);

    expect((await rescheduleCalendarAppointment(BIZ, RESCHEDULE_ARGS)).ok).toBe(true);
    expect(vi.mocked(updateZoomMeetingForBooking)).toHaveBeenCalledWith(BIZ, "zm-1", {
      startIso: RESCHEDULE_ARGS.newStartIso,
      endIso: RESCHEDULE_ARGS.newEndIso
    });
  });

  it("a Zoom-free claim reschedules without touching Zoom", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(GOOGLE_CONN);
    vi.mocked(findUpcomingBookingClaim).mockResolvedValue(CLAIM);
    vi.mocked(workspaceProxyForBusiness).mockResolvedValue({ data: {} } as never);

    expect((await rescheduleCalendarAppointment(BIZ, RESCHEDULE_ARGS)).ok).toBe(true);
    expect(vi.mocked(updateZoomMeetingForBooking)).not.toHaveBeenCalled();
  });

  it("CalDAV reschedule moves the Zoom meeting after a successful provider move", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(CALDAV_CONN);
    vi.mocked(findUpcomingBookingClaim).mockResolvedValue(ZOOM_CLAIM);
    vi.mocked(rescheduleCaldavAppointment).mockResolvedValue({
      ok: true,
      data: { eventId: "evt-1" }
    } as never);

    expect((await rescheduleCalendarAppointment(BIZ, RESCHEDULE_ARGS)).ok).toBe(true);
    expect(vi.mocked(updateZoomMeetingForBooking)).toHaveBeenCalledWith(BIZ, "zm-1", {
      startIso: RESCHEDULE_ARGS.newStartIso,
      endIso: RESCHEDULE_ARGS.newEndIso
    });
  });

  it("Microsoft cancel deletes the Zoom meeting with the event", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(MS_CONN);
    vi.mocked(findUpcomingBookingClaim).mockResolvedValue(ZOOM_CLAIM);
    vi.mocked(workspaceProxyForBusiness).mockResolvedValue({ data: {} } as never);

    expect((await cancelCalendarAppointment(BIZ, CANCEL_ARGS)).ok).toBe(true);
    expect(vi.mocked(deleteZoomMeetingForBooking)).toHaveBeenCalledWith(BIZ, "zm-1");
  });

  it("CalDAV cancel deletes the Zoom meeting after the provider delete succeeds", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(CALDAV_CONN);
    vi.mocked(findUpcomingBookingClaim).mockResolvedValue(ZOOM_CLAIM);
    vi.mocked(cancelCaldavAppointment).mockResolvedValue({
      ok: true,
      data: { eventId: "evt-1", canceled: true }
    } as never);

    expect((await cancelCalendarAppointment(BIZ, CANCEL_ARGS)).ok).toBe(true);
    expect(vi.mocked(deleteZoomMeetingForBooking)).toHaveBeenCalledWith(BIZ, "zm-1");
  });

  it("a provider-search hit recovers the meeting id from the event's row before ledger cleanup (reschedule)", async () => {
    // No ledger row under the caller's key, the event resolves via Google
    // search, but its row under a DIFFERENT key still holds the meeting id.
    vi.mocked(resolveCalendarConnection).mockResolvedValue(GOOGLE_CONN);
    vi.mocked(findZoomMeetingIdByEvent).mockResolvedValue("zm-7");
    vi.mocked(workspaceProxyForBusiness)
      .mockResolvedValueOnce({
        data: { items: [{ id: "evt-search", description: `Phone: ${PHONE}` }] }
      } as never)
      .mockResolvedValueOnce({ data: {} } as never);

    expect((await rescheduleCalendarAppointment(BIZ, RESCHEDULE_ARGS)).ok).toBe(true);
    expect(vi.mocked(findZoomMeetingIdByEvent)).toHaveBeenCalledWith(BIZ, "evt-search");
    expect(vi.mocked(updateZoomMeetingForBooking)).toHaveBeenCalledWith(BIZ, "zm-7", {
      startIso: RESCHEDULE_ARGS.newStartIso,
      endIso: RESCHEDULE_ARGS.newEndIso
    });
    expect(vi.mocked(deleteBookingClaimsByEvent)).toHaveBeenCalledWith(BIZ, "evt-search");
  });

  it("a provider-search hit deletes the recovered meeting on cancel", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(MS_CONN);
    vi.mocked(findZoomMeetingIdByEvent).mockResolvedValue("zm-7");
    vi.mocked(workspaceProxyForBusiness)
      .mockResolvedValueOnce({
        data: { value: [{ id: "evt-search", bodyPreview: `Phone: ${PHONE}` }] }
      } as never)
      .mockResolvedValueOnce({ data: {} } as never);

    expect((await cancelCalendarAppointment(BIZ, CANCEL_ARGS)).ok).toBe(true);
    expect(vi.mocked(deleteZoomMeetingForBooking)).toHaveBeenCalledWith(BIZ, "zm-7");
  });

  it("a failed provider cancel leaves the Zoom meeting alone", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(CALDAV_CONN);
    vi.mocked(findUpcomingBookingClaim).mockResolvedValue(ZOOM_CLAIM);
    vi.mocked(cancelCaldavAppointment).mockResolvedValue({
      ok: false,
      detail: "calendar_cancel_failed"
    } as never);

    expect((await cancelCalendarAppointment(BIZ, CANCEL_ARGS)).ok).toBe(false);
    expect(vi.mocked(deleteZoomMeetingForBooking)).not.toHaveBeenCalled();
  });
});

describe("waitlist hooks", () => {
  const CANCEL_ARGS = { attendeePhone: PHONE };

  it("a ledger-resolved reschedule frees the OLD slot and resolves the attendee's entries", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(CALDAV_CONN);
    vi.mocked(findUpcomingBookingClaim).mockResolvedValue(CLAIM);
    vi.mocked(rescheduleCaldavAppointment).mockResolvedValue({
      ok: true,
      data: { eventId: "evt-1" }
    } as never);
    await rescheduleCalendarAppointment(BIZ, RESCHEDULE_ARGS);
    expect(vi.mocked(offerFreedSlot)).toHaveBeenCalledWith(
      BIZ,
      CLAIM.startAt,
      {},
      { phones: [PHONE], email: null }
    );
    expect(vi.mocked(resolveWaitlistAfterBooking)).toHaveBeenCalledWith(
      BIZ,
      { phones: [PHONE], email: null },
      RESCHEDULE_ARGS.newStartIso
    );
  });

  it("Google ledger reschedule frees the claim's old start; a start-less search hit has nothing to free", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(GOOGLE_CONN);
    vi.mocked(findUpcomingBookingClaim).mockResolvedValue(CLAIM);
    vi.mocked(workspaceProxyForBusiness).mockResolvedValue({ data: {} } as never);
    await rescheduleCalendarAppointment(BIZ, RESCHEDULE_ARGS);
    expect(vi.mocked(offerFreedSlot)).toHaveBeenCalledWith(
      BIZ,
      CLAIM.startAt,
      {},
      { phones: [PHONE], email: null }
    );

    vi.mocked(offerFreedSlot).mockClear();
    vi.mocked(resolveWaitlistAfterBooking).mockClear();
    vi.mocked(findUpcomingBookingClaim).mockResolvedValue(null);
    vi.mocked(workspaceProxyForBusiness).mockReset();
    vi.mocked(workspaceProxyForBusiness)
      .mockResolvedValueOnce({
        data: { items: [{ id: "evt-search", description: `Phone: ${PHONE}` }] }
      } as never)
      .mockResolvedValueOnce({ data: {} } as never);
    await rescheduleCalendarAppointment(BIZ, RESCHEDULE_ARGS);
    expect(vi.mocked(offerFreedSlot)).not.toHaveBeenCalled();
    expect(vi.mocked(resolveWaitlistAfterBooking)).toHaveBeenCalled();
  });

  it("a searched event WITH a listed start frees that slot too (Google reschedule, Graph cancel)", async () => {
    // Google search listing carries the event's start.
    vi.mocked(resolveCalendarConnection).mockResolvedValue(GOOGLE_CONN);
    vi.mocked(workspaceProxyForBusiness)
      .mockResolvedValueOnce({
        data: {
          items: [
            {
              id: "evt-search",
              description: `Phone: ${PHONE}`,
              start: { dateTime: "2026-07-13T20:00:00Z" }
            }
          ]
        }
      } as never)
      .mockResolvedValueOnce({ data: {} } as never);
    await rescheduleCalendarAppointment(BIZ, RESCHEDULE_ARGS);
    expect(vi.mocked(offerFreedSlot)).toHaveBeenCalledWith(
      BIZ,
      "2026-07-13T20:00:00.000Z",
      {},
      { phones: [PHONE], email: null }
    );

    // Graph search listing: zone-less dateTime reads as UTC (graphTimeIso).
    vi.mocked(offerFreedSlot).mockClear();
    vi.mocked(resolveCalendarConnection).mockResolvedValue(MS_CONN);
    vi.mocked(workspaceProxyForBusiness).mockReset();
    vi.mocked(workspaceProxyForBusiness)
      .mockResolvedValueOnce({
        data: {
          value: [
            {
              id: "evt-search",
              bodyPreview: `Phone: ${PHONE}`,
              start: { dateTime: "2026-07-13T20:00:00.0000000" }
            }
          ]
        }
      } as never)
      .mockResolvedValueOnce({ data: {} } as never);
    await cancelCalendarAppointment(BIZ, { attendeePhone: PHONE });
    expect(vi.mocked(offerFreedSlot)).toHaveBeenCalledWith(
      BIZ,
      "2026-07-13T20:00:00.000Z",
      {},
      { phones: [PHONE], email: null }
    );
  });

  it("cancel frees the slot and drops the canceler's own entries (ledger path); Calendly drops entries only", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(VAGARO_CONN);
    vi.mocked(findUpcomingBookingClaim).mockResolvedValue(CLAIM);
    vi.mocked(cancelVagaroAppointment).mockResolvedValue({ ok: true, data: {} } as never);
    await cancelCalendarAppointment(BIZ, CANCEL_ARGS);
    // The canceler's own entries drop BEFORE the slot is offered, and the
    // offer excludes them so they never get texted their own slot.
    expect(vi.mocked(offerFreedSlot)).toHaveBeenCalledWith(BIZ, CLAIM.startAt, {}, {
      phones: [PHONE],
      email: null
    });
    expect(vi.mocked(cancelWaitlistForAttendee)).toHaveBeenCalledWith(BIZ, {
      phones: [PHONE],
      email: null
    });
    const cancelOrder = vi.mocked(cancelWaitlistForAttendee).mock.invocationCallOrder[0];
    const offerOrder = vi.mocked(offerFreedSlot).mock.invocationCallOrder[0];
    expect(cancelOrder).toBeLessThan(offerOrder);

    vi.mocked(offerFreedSlot).mockClear();
    vi.mocked(cancelWaitlistForAttendee).mockClear();
    vi.mocked(resolveCalendarConnection).mockResolvedValue(CALENDLY_CONN);
    vi.mocked(cancelCalendlyAppointment).mockResolvedValue({ ok: true, data: {} } as never);
    await cancelCalendarAppointment(BIZ, CANCEL_ARGS);
    // The Calendly locate step never learns the event's start; the poll's
    // canceled scan observes the freed slot instead.
    expect(vi.mocked(offerFreedSlot)).not.toHaveBeenCalled();
    expect(vi.mocked(cancelWaitlistForAttendee)).toHaveBeenCalled();
  });

  it("a searched (ledger-less) cancel drops entries but has no start to offer (email-only identity)", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(MS_CONN);
    vi.mocked(workspaceProxyForBusiness)
      .mockResolvedValueOnce({
        data: { value: [{ id: "evt-search", bodyPreview: "Email: joe@acme.com" }] }
      } as never)
      .mockResolvedValueOnce({ data: {} } as never);
    await cancelCalendarAppointment(BIZ, { attendeeEmail: "joe@acme.com" });
    expect(vi.mocked(offerFreedSlot)).not.toHaveBeenCalled();
    expect(vi.mocked(cancelWaitlistForAttendee)).toHaveBeenCalledWith(BIZ, {
      phones: [],
      email: "joe@acme.com"
    });
  });

  it("email-only identities pass an empty phone list to the waitlist hooks (ledger paths)", async () => {
    // CalDAV reschedule.
    vi.mocked(resolveCalendarConnection).mockResolvedValue(CALDAV_CONN);
    vi.mocked(findUpcomingBookingClaim).mockResolvedValue(CLAIM);
    vi.mocked(rescheduleCaldavAppointment).mockResolvedValue({
      ok: true,
      data: { eventId: "evt-1" }
    } as never);
    await rescheduleCalendarAppointment(BIZ, {
      newStartIso: RESCHEDULE_ARGS.newStartIso,
      newEndIso: RESCHEDULE_ARGS.newEndIso,
      attendeeEmail: "joe@acme.com"
    });
    expect(vi.mocked(resolveWaitlistAfterBooking)).toHaveBeenCalledWith(
      BIZ,
      { phones: [], email: "joe@acme.com" },
      RESCHEDULE_ARGS.newStartIso
    );

    // Vagaro cancel.
    vi.mocked(resolveCalendarConnection).mockResolvedValue(VAGARO_CONN);
    vi.mocked(cancelVagaroAppointment).mockResolvedValue({ ok: true, data: {} } as never);
    await cancelCalendarAppointment(BIZ, { attendeeEmail: "joe@acme.com" });
    expect(vi.mocked(cancelWaitlistForAttendee)).toHaveBeenCalledWith(BIZ, {
      phones: [],
      email: "joe@acme.com"
    });

    // Calendly cancel.
    vi.mocked(cancelWaitlistForAttendee).mockClear();
    vi.mocked(resolveCalendarConnection).mockResolvedValue(CALENDLY_CONN);
    vi.mocked(cancelCalendlyAppointment).mockResolvedValue({ ok: true, data: {} } as never);
    await cancelCalendarAppointment(BIZ, { attendeeEmail: "joe@acme.com" });
    expect(vi.mocked(cancelWaitlistForAttendee)).toHaveBeenCalledWith(BIZ, {
      phones: [],
      email: "joe@acme.com"
    });
  });

  it("a FAILED provider mutation never touches the waitlist", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(VAGARO_CONN);
    vi.mocked(findUpcomingBookingClaim).mockResolvedValue(CLAIM);
    vi.mocked(cancelVagaroAppointment).mockResolvedValue({
      ok: false,
      detail: "vagaro_auth_failed"
    } as never);
    await cancelCalendarAppointment(BIZ, CANCEL_ARGS);
    expect(vi.mocked(offerFreedSlot)).not.toHaveBeenCalled();
    expect(vi.mocked(cancelWaitlistForAttendee)).not.toHaveBeenCalled();
  });
});

/**
 * Name-based resolution: owners ask "move John Smith's Tuesday 4pm", not
 * "move +1555…'s appointment". The search matches the `Attendee:` line every
 * booked event carries, `appointmentStartIso` disambiguates, and a name that
 * still matches several appointments comes back as `multiple_matches` so the
 * model asks which one instead of guessing.
 */
describe("resolution by attendee name", () => {
  const NAME = "John Smith";
  const NAME_ARGS = {
    newStartIso: RESCHEDULE_ARGS.newStartIso,
    newEndIso: RESCHEDULE_ARGS.newEndIso,
    attendeeName: NAME
  };
  /** A Google search hit with the `Attendee:` marker line. */
  const namedEvent = (id: string, startDateTime: string) => ({
    id,
    description: `Attendee: ${NAME}\nPhone: ${PHONE}`,
    start: { dateTime: startDateTime }
  });

  it("finds the event by name alone and moves it", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(GOOGLE_CONN);
    vi.mocked(workspaceProxyForBusiness)
      .mockResolvedValueOnce({
        data: { items: [namedEvent("evt-name", "2026-07-28T23:00:00.000Z")] }
      } as never)
      .mockResolvedValueOnce({ data: {} } as never);

    const result = await rescheduleCalendarAppointment(BIZ, NAME_ARGS);
    expect(result.ok).toBe(true);
    const searchCall = vi.mocked(workspaceProxyForBusiness).mock.calls[0][2] as unknown as {
      params: { q: string };
    };
    expect(searchCall.params.q).toBe(NAME);
    const patchCall = vi.mocked(workspaceProxyForBusiness).mock.calls[1][2] as { endpoint: string };
    expect(patchCall.endpoint).toContain("evt-name");
  });

  it("returns multiple_matches with candidate starts (and mutates nothing) when a name is ambiguous", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(GOOGLE_CONN);
    vi.mocked(workspaceProxyForBusiness).mockResolvedValueOnce({
      data: {
        items: [
          namedEvent("evt-a", "2026-07-28T23:00:00.000Z"),
          namedEvent("evt-b", "2026-07-30T17:00:00.000Z")
        ]
      }
    } as never);

    const result = await rescheduleCalendarAppointment(BIZ, NAME_ARGS);
    expect(result.ok).toBe(false);
    expect(result.detail).toBe("multiple_matches");
    expect(result.data).toEqual({
      candidates: [
        { startIso: "2026-07-28T23:00:00.000Z" },
        { startIso: "2026-07-30T17:00:00.000Z" }
      ]
    });
    expect(result.message).toContain("Ask which one");
    // Search only: the ambiguity is reported BEFORE anything is mutated.
    expect(vi.mocked(workspaceProxyForBusiness)).toHaveBeenCalledTimes(1);
  });

  it("appointmentStartIso picks the appointment the owner named out of several", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(GOOGLE_CONN);
    vi.mocked(workspaceProxyForBusiness)
      .mockResolvedValueOnce({
        data: {
          items: [
            namedEvent("evt-a", "2026-07-28T23:00:00.000Z"),
            namedEvent("evt-b", "2026-07-30T17:00:00.000Z")
          ]
        }
      } as never)
      .mockResolvedValueOnce({ data: {} } as never);

    const result = await rescheduleCalendarAppointment(BIZ, {
      ...NAME_ARGS,
      // Same instant as evt-b, written with an offset instead of Z.
      appointmentStartIso: "2026-07-30T10:00:00.000-07:00"
    });
    expect(result.ok).toBe(true);
    const patchCall = vi.mocked(workspaceProxyForBusiness).mock.calls[1][2] as { endpoint: string };
    expect(patchCall.endpoint).toContain("evt-b");
  });

  it("a lone candidate still resolves when no candidate sits at the named time", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(GOOGLE_CONN);
    vi.mocked(workspaceProxyForBusiness)
      // Start-less listing: the narrowing cannot confirm the time, but one
      // candidate is unambiguous (their only upcoming appointment).
      .mockResolvedValueOnce({
        data: { items: [{ id: "evt-only", description: `Attendee: ${NAME}` }] }
      } as never)
      .mockResolvedValueOnce({ data: {} } as never);

    const result = await rescheduleCalendarAppointment(BIZ, {
      ...NAME_ARGS,
      appointmentStartIso: "2026-07-28T23:00:00.000Z"
    });
    expect(result.ok).toBe(true);
    const patchCall = vi.mocked(workspaceProxyForBusiness).mock.calls[1][2] as { endpoint: string };
    expect(patchCall.endpoint).toContain("evt-only");
  });

  it("name matching is anchored to the Attendee line and never partial", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(GOOGLE_CONN);
    vi.mocked(workspaceProxyForBusiness).mockResolvedValueOnce({
      data: {
        items: [
          // A longer name that merely STARTS with the search name.
          { id: "evt-son", description: "Attendee: John Smithson\nPhone: +15550001111" },
          // The name in free-form prose, not as the attendee: someone else's
          // meeting that merely mentions them.
          { id: "evt-prose", description: "Notes: John Smith called about parking" },
          // Unusable ids are skipped before matching (a blank id could not be
          // PATCHed anyway).
          { id: "", description: `Attendee: ${NAME}` }
        ]
      }
    } as never);

    expect(await rescheduleCalendarAppointment(BIZ, NAME_ARGS)).toEqual({
      ok: false,
      detail: "booking_not_found"
    });
  });

  it("collects same-name candidates across the shared AND primary calendars", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(GOOGLE_CONN);
    vi.mocked(getSharedCalendar).mockResolvedValue({ calendarId: "shared-cal" } as never);
    vi.mocked(workspaceProxyForBusiness)
      .mockResolvedValueOnce({
        data: { items: [namedEvent("evt-shared", "2026-07-28T23:00:00.000Z")] }
      } as never)
      .mockResolvedValueOnce({
        data: { items: [namedEvent("evt-primary", "2026-07-30T17:00:00.000Z")] }
      } as never);

    const result = await rescheduleCalendarAppointment(BIZ, NAME_ARGS);
    expect(result.detail).toBe("multiple_matches");
    expect((result.data as { candidates: unknown[] }).candidates).toHaveLength(2);
    // Name mode does NOT short-circuit: both calendars were scanned.
    const endpoints = vi
      .mocked(workspaceProxyForBusiness)
      .mock.calls.map((c) => (c[2] as { endpoint: string }).endpoint);
    expect(endpoints).toEqual([
      "/calendar/v3/calendars/shared-cal/events",
      "/calendar/v3/calendars/primary/events"
    ]);
  });

  it("Microsoft resolves by name from the event body", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(MS_CONN);
    vi.mocked(workspaceProxyForBusiness)
      .mockResolvedValueOnce({
        data: {
          value: [
            { id: "evt-other", bodyPreview: "Attendee: Someone Else" },
            {
              id: "evt-ms",
              body: { content: `<html><div>Attendee: ${NAME}</div></html>` },
              start: { dateTime: "2026-07-28T16:00:00", timeZone: "America/Phoenix" }
            }
          ]
        }
      } as never)
      .mockResolvedValueOnce({ data: {} } as never);

    const result = await rescheduleCalendarAppointment(BIZ, NAME_ARGS);
    expect(result.ok).toBe(true);
    const patchCall = vi.mocked(workspaceProxyForBusiness).mock.calls[1][2] as { endpoint: string };
    expect(patchCall.endpoint).toBe("/v1.0/me/events/evt-ms");
  });

  it("a ledger claim at a DIFFERENT time than the named one falls through to the search", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(GOOGLE_CONN);
    // The ledger holds this person's NEXT appointment (Jul 13), but the owner
    // named the Jul 28 one: the claim must not be moved.
    vi.mocked(findUpcomingBookingClaim).mockResolvedValue(CLAIM);
    vi.mocked(workspaceProxyForBusiness)
      .mockResolvedValueOnce({
        data: { items: [namedEvent("evt-named", "2026-07-28T23:00:00.000Z")] }
      } as never)
      .mockResolvedValueOnce({ data: {} } as never);

    const result = await rescheduleCalendarAppointment(BIZ, {
      ...NAME_ARGS,
      appointmentStartIso: "2026-07-28T23:00:00.000Z"
    });
    expect(result.ok).toBe(true);
    const patchCall = vi.mocked(workspaceProxyForBusiness).mock.calls[1][2] as { endpoint: string };
    expect(patchCall.endpoint).toContain("evt-named");
    expect(patchCall.endpoint).not.toContain("evt-1");
    // Resolved by search, so the ledger row is re-recorded by event id.
    expect(vi.mocked(deleteBookingClaimsByEvent)).toHaveBeenCalledWith(BIZ, "evt-named");
    expect(vi.mocked(rescheduleBookingClaim)).not.toHaveBeenCalled();
  });

  it("a ledger claim AT the named time is used directly, with no provider search", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(GOOGLE_CONN);
    vi.mocked(findUpcomingBookingClaim).mockResolvedValue(CLAIM);
    vi.mocked(workspaceProxyForBusiness).mockResolvedValue({ data: {} } as never);

    const result = await rescheduleCalendarAppointment(BIZ, {
      ...NAME_ARGS,
      // CLAIM.startAt as the same instant in a different format.
      appointmentStartIso: "2026-07-13T16:00:00.000-04:00"
    });
    expect(result.ok).toBe(true);
    expect(vi.mocked(workspaceProxyForBusiness)).toHaveBeenCalledTimes(1);
    const patchCall = vi.mocked(workspaceProxyForBusiness).mock.calls[0][2] as { endpoint: string };
    expect(patchCall.endpoint).toContain("evt-1");
  });

  it("an unparseable claim start never satisfies a named time", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(GOOGLE_CONN);
    vi.mocked(findUpcomingBookingClaim).mockResolvedValue({
      ...CLAIM,
      startAt: "not-a-date"
    } as never);
    // Nothing else matches, so the guard surfaces as booking_not_found rather
    // than moving the claim the caller did not name.
    vi.mocked(workspaceProxyForBusiness).mockResolvedValueOnce({ data: { items: [] } } as never);

    expect(
      await rescheduleCalendarAppointment(BIZ, {
        ...NAME_ARGS,
        appointmentStartIso: "2026-07-28T23:00:00.000Z"
      })
    ).toEqual({ ok: false, detail: "booking_not_found" });
  });

  it("cancel resolves by name and reports ambiguity the same way", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(GOOGLE_CONN);
    vi.mocked(workspaceProxyForBusiness)
      .mockResolvedValueOnce({
        data: { items: [namedEvent("evt-cancel", "2026-07-28T23:00:00.000Z")] }
      } as never)
      .mockResolvedValueOnce({ data: {} } as never);

    const canceled = await cancelCalendarAppointment(BIZ, { attendeeName: NAME });
    expect(canceled.ok).toBe(true);
    const deleteCall = vi.mocked(workspaceProxyForBusiness).mock.calls[1][2] as {
      endpoint: string;
      method: string;
    };
    expect(deleteCall.method).toBe("DELETE");
    expect(deleteCall.endpoint).toContain("evt-cancel");

    vi.mocked(workspaceProxyForBusiness).mockReset();
    vi.mocked(workspaceProxyForBusiness).mockResolvedValueOnce({
      data: {
        items: [
          namedEvent("evt-a", "2026-07-28T23:00:00.000Z"),
          namedEvent("evt-b", "2026-07-30T17:00:00.000Z")
        ]
      }
    } as never);
    const ambiguous = await cancelCalendarAppointment(BIZ, { attendeeName: NAME });
    expect(ambiguous.detail).toBe("multiple_matches");
    // Nothing was deleted while the model still has to ask.
    expect(vi.mocked(workspaceProxyForBusiness)).toHaveBeenCalledTimes(1);
  });
});
