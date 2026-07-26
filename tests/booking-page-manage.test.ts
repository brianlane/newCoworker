/**
 * Invitee self-serve: viewing, rescheduling, and cancelling one booking by
 * its manage token, across both calendars of record (provider event vs the
 * platform ledger) and the minimum-notice window that closes the door.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/businesses", () => ({ getBusiness: vi.fn() }));
vi.mock("@/lib/calendar-tools/reschedule", () => ({
  cancelCalendarAppointment: vi.fn(),
  rescheduleCalendarAppointment: vi.fn()
}));
vi.mock("@/lib/zoom/meetings", () => ({
  deleteZoomMeetingForBooking: vi.fn(),
  getZoomJoinUrl: vi.fn(),
  updateZoomMeetingForBooking: vi.fn()
}));
vi.mock("@/lib/calendar-tools/waitlist-fill", () => ({ offerFreedSlot: vi.fn() }));
vi.mock("@/lib/calendar-tools/waitlist-resolve", () => ({
  cancelWaitlistForAttendee: vi.fn(),
  resolveWaitlistAfterBooking: vi.fn()
}));
vi.mock("@/lib/calendar-tools/booking-dedupe", () => ({
  claimBookingDedupe: vi.fn(),
  findUpcomingBookingClaim: vi.fn(),
  releaseBookingDedupe: vi.fn(),
  releaseParkedSlotClaims: vi.fn()
}));
vi.mock("@/lib/booking-page/db", () => ({
  getBookingPageForBusiness: vi.fn(),
  getBookingByManageToken: vi.fn(),
  moveManagedBooking: vi.fn(),
  deleteManagedBooking: vi.fn()
}));
vi.mock("@/lib/booking-page/service", () => ({
  listSlotsForBusiness: vi.fn(),
  dailyCapReached: vi.fn(),
  PUBLIC_SLOT_CLAIM_KEY: "slot:public-booking-page"
}));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

import {
  cancelManagedBooking,
  getManagedBooking,
  rescheduleManagedBooking
} from "@/lib/booking-page/manage";
import { getBusiness } from "@/lib/db/businesses";
import {
  cancelCalendarAppointment,
  rescheduleCalendarAppointment
} from "@/lib/calendar-tools/reschedule";
import {
  deleteZoomMeetingForBooking,
  getZoomJoinUrl,
  updateZoomMeetingForBooking
} from "@/lib/zoom/meetings";
import { offerFreedSlot } from "@/lib/calendar-tools/waitlist-fill";
import {
  cancelWaitlistForAttendee,
  resolveWaitlistAfterBooking
} from "@/lib/calendar-tools/waitlist-resolve";
import {
  claimBookingDedupe,
  findUpcomingBookingClaim,
  releaseBookingDedupe,
  releaseParkedSlotClaims
} from "@/lib/calendar-tools/booking-dedupe";
import {
  deleteManagedBooking,
  getBookingByManageToken,
  getBookingPageForBusiness,
  moveManagedBooking
} from "@/lib/booking-page/db";
import { dailyCapReached, listSlotsForBusiness } from "@/lib/booking-page/service";

const BIZ = "11111111-1111-4111-8111-111111111111";
const TOKEN = `ncbm_${"a".repeat(64)}`;
/** Far enough out that the default notice window never bites. */
const FUTURE = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();
const NEW_START = new Date(Date.now() + 6 * 24 * 60 * 60 * 1000).toISOString();

const mockBusiness = vi.mocked(getBusiness);
const mockCancelCore = vi.mocked(cancelCalendarAppointment);
const mockRescheduleCore = vi.mocked(rescheduleCalendarAppointment);
const mockZoomDelete = vi.mocked(deleteZoomMeetingForBooking);
const mockZoomUpdate = vi.mocked(updateZoomMeetingForBooking);
const mockZoomJoinUrl = vi.mocked(getZoomJoinUrl);
const mockOfferFreed = vi.mocked(offerFreedSlot);
const mockCancelWaitlist = vi.mocked(cancelWaitlistForAttendee);
const mockResolveWaitlist = vi.mocked(resolveWaitlistAfterBooking);
const mockClaim = vi.mocked(claimBookingDedupe);
const mockRelease = vi.mocked(releaseBookingDedupe);
const mockFindClaim = vi.mocked(findUpcomingBookingClaim);
const mockReleaseParked = vi.mocked(releaseParkedSlotClaims);
const mockRow = vi.mocked(getBookingByManageToken);
const mockPage = vi.mocked(getBookingPageForBusiness);
const mockMove = vi.mocked(moveManagedBooking);
const mockDelete = vi.mocked(deleteManagedBooking);
const mockSlots = vi.mocked(listSlotsForBusiness);
const mockCapReached = vi.mocked(dailyCapReached);

function row(over: Record<string, unknown> = {}) {
  return {
    id: "row-1",
    business_id: BIZ,
    attendee_key: "phone:+14805550177",
    start_at: FUTURE,
    event_id: "evt-google-1",
    zoom_meeting_id: null,
    duration_minutes: 30,
    ...over
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRow.mockResolvedValue(row());
  mockPage.mockResolvedValue({ min_notice_minutes: 120, max_daily_bookings: null } as never);
  mockCapReached.mockResolvedValue(false);
  mockBusiness.mockResolvedValue({ name: "New Coworker", timezone: "America/Phoenix" } as never);
  mockCancelCore.mockResolvedValue({ ok: true } as never);
  mockRescheduleCore.mockResolvedValue({ ok: true } as never);
  mockZoomDelete.mockResolvedValue(undefined as never);
  mockZoomUpdate.mockResolvedValue(true);
  mockZoomJoinUrl.mockResolvedValue("https://zoom.us/j/93412345678?pwd=secret");
  mockOfferFreed.mockResolvedValue({ offered: false } as never);
  mockCancelWaitlist.mockResolvedValue(undefined);
  mockResolveWaitlist.mockResolvedValue(undefined);
  mockClaim.mockResolvedValue({ kind: "claimed", id: "claim-1" } as never);
  mockRelease.mockResolvedValue(undefined);
  mockReleaseParked.mockResolvedValue(undefined);
  // By default the core would act on exactly this booking.
  mockFindClaim.mockResolvedValue({ id: "claim-9", eventId: "evt-1", startAt: FUTURE, zoomMeetingId: null } as never);
  mockMove.mockResolvedValue(undefined);
  mockDelete.mockResolvedValue(undefined);
  mockSlots.mockResolvedValue({
    ok: true,
    timezone: "America/Phoenix",
    durationMinutes: 30,
    slots: [{ startIso: NEW_START, endIso: NEW_START }]
  } as never);
});

describe("getManagedBooking", () => {
  it("returns the booking with its join link and change window open", async () => {
    mockRow.mockResolvedValue(row({ zoom_meeting_id: "93412345678" }));
    const out = await getManagedBooking(TOKEN);
    // Read back from Zoom: a rebuilt /j/<id> link drops the pwd a
    // password-protected meeting needs.
    expect(mockZoomJoinUrl).toHaveBeenCalledWith(BIZ, "93412345678");
    expect(out).toEqual({
      ok: true,
      view: {
        businessName: "New Coworker",
        timezone: "America/Phoenix",
        startIso: FUTURE,
        durationMinutes: 30,
        zoomJoinUrl: "https://zoom.us/j/93412345678?pwd=secret",
        changeable: true,
        past: false,
        minNoticeMinutes: 120
      }
    });
  });

  it("assumes a default duration for bookings made before the column existed", async () => {
    mockRow.mockResolvedValue(row({ duration_minutes: null }));
    const out = await getManagedBooking(TOKEN);
    expect(out.ok && out.view.durationMinutes).toBe(30);
  });

  it("closes the change window inside the notice period", async () => {
    mockRow.mockResolvedValue(row({ start_at: new Date(Date.now() + 30 * 60_000).toISOString() }));
    const out = await getManagedBooking(TOKEN);
    expect(out.ok && out.view.changeable).toBe(false);
    expect(out.ok && out.view.past).toBe(false);
  });

  it("flags an appointment that already happened, distinct from the notice window", async () => {
    // An old link should say the appointment passed, not that it is "too
    // soon to change".
    mockRow.mockResolvedValue(row({ start_at: new Date(Date.now() - 60 * 60_000).toISOString() }));
    const out = await getManagedBooking(TOKEN);
    expect(out.ok && out.view.changeable).toBe(false);
    expect(out.ok && out.view.past).toBe(true);
  });

  it("treats a page with no notice setting as always changeable, and a missing page as zero notice", async () => {
    mockPage.mockResolvedValue(null as never);
    mockRow.mockResolvedValue(row({ start_at: new Date(Date.now() + 60_000).toISOString() }));
    const out = await getManagedBooking(TOKEN);
    expect(out.ok && out.view.changeable).toBe(true);
    expect(out.ok && out.view.minNoticeMinutes).toBe(0);
  });

  it("fails closed on a malformed token, an unknown token, and a missing business", async () => {
    expect(await getManagedBooking("not-a-token")).toEqual({ ok: false, detail: "not_found" });
    expect(mockRow).not.toHaveBeenCalled();

    mockRow.mockResolvedValue(null);
    expect(await getManagedBooking(TOKEN)).toEqual({ ok: false, detail: "not_found" });

    mockRow.mockResolvedValue(row());
    mockBusiness.mockResolvedValue(null as never);
    expect(await getManagedBooking(TOKEN)).toEqual({ ok: false, detail: "not_found" });
  });

  it("falls back to UTC when the business has no timezone", async () => {
    mockBusiness.mockResolvedValue({ name: "New Coworker", timezone: "" } as never);
    const out = await getManagedBooking(TOKEN);
    expect(out.ok && out.view.timezone).toBe("UTC");
  });
});

describe("cancelManagedBooking", () => {
  it("provider mode: the cancel CORE owns the change (one provider cancellation)", async () => {
    expect(await cancelManagedBooking(TOKEN)).toEqual({ ok: true });
    expect(mockCancelCore).toHaveBeenCalledWith(
      BIZ,
      { attendeePhone: "+14805550177" },
      null
    );
    // The core handles the ledger, Zoom, and the waitlist offer itself,
    // but the page's parked slot claim is ours to clear.
    expect(mockDelete).not.toHaveBeenCalled();
    expect(mockOfferFreed).not.toHaveBeenCalled();
    expect(mockReleaseParked).toHaveBeenCalledWith(BIZ, "slot:public-booking-page", FUTURE);
  });

  it("platform mode: the ledger row IS the appointment, plus Zoom and waitlist", async () => {
    mockRow.mockResolvedValue(
      row({ event_id: "platform:abc", zoom_meeting_id: "934123", attendee_key: "email:liz@x.co" })
    );
    expect(await cancelManagedBooking(TOKEN)).toEqual({ ok: true });
    expect(mockDelete).toHaveBeenCalledWith("row-1");
    expect(mockZoomDelete).toHaveBeenCalledWith(BIZ, "934123");
    // Their OWN live waitlist entries end with the appointment (parity with
    // the provider cancel core), and only then is the time offered on.
    expect(mockCancelWaitlist).toHaveBeenCalledWith(BIZ, { phones: [], email: "liz@x.co" });
    // The original booking's parked slot claim goes too, or the freed time
    // turns the next booker away until its lease lapses.
    expect(mockReleaseParked).toHaveBeenCalledWith(BIZ, "slot:public-booking-page", FUTURE);
    expect(mockOfferFreed).toHaveBeenCalledWith(BIZ, FUTURE);
    expect(mockCancelCore).not.toHaveBeenCalled();
  });

  it("platform mode without a video call skips the Zoom cleanup", async () => {
    mockRow.mockResolvedValue(row({ event_id: "platform:abc", zoom_meeting_id: null }));
    expect(await cancelManagedBooking(TOKEN)).toEqual({ ok: true });
    expect(mockZoomDelete).not.toHaveBeenCalled();
  });

  it("refuses inside the notice window, on a past appointment, and on an unknown token", async () => {
    mockRow.mockResolvedValue(row({ start_at: new Date(Date.now() + 60_000).toISOString() }));
    expect(await cancelManagedBooking(TOKEN)).toEqual({ ok: false, detail: "too_late" });
    expect(mockCancelCore).not.toHaveBeenCalled();

    // A stale tab acting on a finished appointment hears the truth.
    mockRow.mockResolvedValue(row({ start_at: new Date(Date.now() - 60_000).toISOString() }));
    expect(await cancelManagedBooking(TOKEN)).toEqual({ ok: false, detail: "already_past" });

    mockRow.mockResolvedValue(null);
    expect(await cancelManagedBooking(TOKEN)).toEqual({ ok: false, detail: "not_found" });
  });

  it("refuses rather than cancel the WRONG appointment (attendee holds two)", async () => {
    // The shared cores resolve the attendee's soonest upcoming booking, not
    // this token's row: silently cancelling a different event is the
    // failure this guard exists for.
    mockFindClaim.mockResolvedValue({
      id: "claim-other",
      eventId: "evt-other",
      startAt: new Date(Date.parse(FUTURE) - 24 * 60 * 60 * 1000).toISOString(),
      zoomMeetingId: null
    } as never);
    expect(await cancelManagedBooking(TOKEN)).toEqual({ ok: false, detail: "needs_human" });
    expect(mockCancelCore).not.toHaveBeenCalled();
  });

  it("proceeds when the ledger has no claim to compare (pre-ledger bookings)", async () => {
    mockFindClaim.mockResolvedValue(null);
    expect(await cancelManagedBooking(TOKEN)).toEqual({ ok: true });
    expect(mockCancelCore).toHaveBeenCalled();
  });

  it("reports a refused or thrown provider cancel honestly", async () => {
    mockCancelCore.mockResolvedValue({ ok: false, detail: "booking_not_found" } as never);
    expect(await cancelManagedBooking(TOKEN)).toEqual({ ok: false, detail: "change_failed" });

    mockCancelCore.mockRejectedValue(new Error("provider 500"));
    expect(await cancelManagedBooking(TOKEN)).toEqual({ ok: false, detail: "change_failed" });

    mockCancelCore.mockRejectedValue("string boom");
    expect(await cancelManagedBooking(TOKEN)).toEqual({ ok: false, detail: "change_failed" });
  });
});

describe("rescheduleManagedBooking", () => {
  it("provider mode: moves the SAME event through the reschedule core", async () => {
    const out = await rescheduleManagedBooking(TOKEN, NEW_START);
    expect(out).toEqual({ ok: true, startIso: NEW_START });
    expect(mockRescheduleCore).toHaveBeenCalledWith(
      BIZ,
      expect.objectContaining({
        newStartIso: NEW_START,
        newEndIso: new Date(Date.parse(NEW_START) + 30 * 60_000).toISOString(),
        attendeePhone: "+14805550177"
      }),
      null
    );
    expect(mockReleaseParked).toHaveBeenCalledWith(BIZ, "slot:public-booking-page", FUTURE);
  });

  it("platform mode: claims the slot, moves the row, moves Zoom, and fixes the waitlist", async () => {
    mockRow.mockResolvedValue(row({ event_id: "platform:abc", zoom_meeting_id: "934123" }));
    const out = await rescheduleManagedBooking(TOKEN, NEW_START);
    expect(out).toEqual({ ok: true, startIso: NEW_START });
    expect(mockClaim).toHaveBeenCalledWith(BIZ, "slot:public-booking-page", NEW_START);
    expect(mockMove).toHaveBeenCalledWith("row-1", NEW_START);
    // The meeting has to move too, or the invitee joins a call still
    // scheduled at the old time.
    expect(mockZoomUpdate).toHaveBeenCalledWith(BIZ, "934123", {
      startIso: NEW_START,
      endIso: new Date(Date.parse(NEW_START) + 30 * 60_000).toISOString()
    });
    expect(mockResolveWaitlist).toHaveBeenCalledWith(
      BIZ,
      { phones: ["+14805550177"], email: null },
      NEW_START
    );
    expect(mockReleaseParked).toHaveBeenCalledWith(BIZ, "slot:public-booking-page", FUTURE);
    expect(mockOfferFreed).toHaveBeenCalledWith(BIZ, FUTURE);
  });

  it("platform mode: respects the day's booking cap, excluding the booking being moved", async () => {
    // Concurrent moves onto one day could otherwise push it past the cap a
    // new booking respects.
    mockRow.mockResolvedValue(row({ event_id: "platform:abc" }));
    mockCapReached.mockResolvedValue(true);
    expect(await rescheduleManagedBooking(TOKEN, NEW_START)).toEqual({
      ok: false,
      detail: "slot_taken"
    });
    expect(mockCapReached).toHaveBeenCalledWith(
      BIZ,
      { max_daily_bookings: null },
      "America/Phoenix",
      new Date(NEW_START),
      FUTURE
    );
    expect(mockMove).not.toHaveBeenCalled();
    // The slot claim is handed back so the time is bookable again.
    expect(mockRelease).toHaveBeenCalledWith("claim-1");
  });

  it("platform mode: refuses when another booker already claimed that start", async () => {
    // The availability read can be stale; the claim is what actually stops
    // two people landing on the same slot.
    mockRow.mockResolvedValue(row({ event_id: "platform:abc" }));
    mockClaim.mockResolvedValue({ kind: "duplicate" } as never);
    expect(await rescheduleManagedBooking(TOKEN, NEW_START)).toEqual({
      ok: false,
      detail: "slot_taken"
    });
    expect(mockMove).not.toHaveBeenCalled();
  });

  it("platform mode: releases the claim when the move itself fails", async () => {
    mockRow.mockResolvedValue(row({ event_id: "platform:abc" }));
    mockMove.mockRejectedValue(new Error("locked"));
    expect(await rescheduleManagedBooking(TOKEN, NEW_START)).toEqual({
      ok: false,
      detail: "change_failed"
    });
    expect(mockRelease).toHaveBeenCalledWith("claim-1");

    // A ledger that could not claim has nothing to release on the way out.
    mockRelease.mockClear();
    mockClaim.mockResolvedValue(null as never);
    expect(await rescheduleManagedBooking(TOKEN, NEW_START)).toEqual({
      ok: false,
      detail: "change_failed"
    });
    expect(mockRelease).not.toHaveBeenCalled();
  });

  it("platform mode: books on through a ledger that cannot claim, and skips Zoom when there is none", async () => {
    // Fail-open on a ledger hiccup, matching the booking core's contract.
    mockRow.mockResolvedValue(row({ event_id: "platform:abc", zoom_meeting_id: null }));
    mockClaim.mockResolvedValue(null as never);
    expect(await rescheduleManagedBooking(TOKEN, NEW_START)).toEqual({
      ok: true,
      startIso: NEW_START
    });
    expect(mockZoomUpdate).not.toHaveBeenCalled();
    expect(mockRelease).not.toHaveBeenCalled();
  });

  it("excludes the invitee's OWN booking from availability (their move adds nothing)", async () => {
    // Otherwise their slot blocks itself and counts against the day's cap,
    // so a same-day move can find no times at all.
    await rescheduleManagedBooking(TOKEN, NEW_START);
    expect(mockSlots).toHaveBeenCalledWith(BIZ, 30, { excludeStartIso: FUTURE });
  });

  it("only accepts a time the page is actually offering right now", async () => {
    // The same re-verify the public submit does: a stale tab must not book
    // over someone else.
    const out = await rescheduleManagedBooking(TOKEN, new Date(Date.parse(NEW_START) + 60_000).toISOString());
    expect(out).toEqual({ ok: false, detail: "slot_taken" });
    expect(mockRescheduleCore).not.toHaveBeenCalled();
  });

  it("refuses rather than move the WRONG appointment (attendee holds two)", async () => {
    mockFindClaim.mockResolvedValue({
      id: "claim-other",
      eventId: "evt-other",
      startAt: new Date(Date.parse(FUTURE) - 24 * 60 * 60 * 1000).toISOString(),
      zoomMeetingId: null
    } as never);
    expect(await rescheduleManagedBooking(TOKEN, NEW_START)).toEqual({
      ok: false,
      detail: "needs_human"
    });
    expect(mockRescheduleCore).not.toHaveBeenCalled();
  });

  it("refuses a Calendly link answer rather than showing a time that does not exist yet", async () => {
    mockRescheduleCore.mockResolvedValue({
      ok: true,
      detail: "reschedule_link_created"
    } as never);
    expect(await rescheduleManagedBooking(TOKEN, NEW_START)).toEqual({
      ok: false,
      detail: "change_failed"
    });
  });

  it("validates the requested time, the notice window, and the token", async () => {
    expect(await rescheduleManagedBooking(TOKEN, "not-a-date")).toEqual({
      ok: false,
      detail: "invalid_request"
    });

    mockRow.mockResolvedValue(row({ start_at: new Date(Date.now() + 60_000).toISOString() }));
    expect(await rescheduleManagedBooking(TOKEN, NEW_START)).toEqual({
      ok: false,
      detail: "too_late"
    });

    mockRow.mockResolvedValue(row({ start_at: new Date(Date.now() - 60_000).toISOString() }));
    expect(await rescheduleManagedBooking(TOKEN, NEW_START)).toEqual({
      ok: false,
      detail: "already_past"
    });

    mockRow.mockResolvedValue(null);
    expect(await rescheduleManagedBooking(TOKEN, NEW_START)).toEqual({
      ok: false,
      detail: "not_found"
    });
  });

  it("reports failures from the slot read and the provider move", async () => {
    mockSlots.mockResolvedValue({ ok: false, detail: "not_found" } as never);
    expect(await rescheduleManagedBooking(TOKEN, NEW_START)).toEqual({
      ok: false,
      detail: "change_failed"
    });

    mockSlots.mockResolvedValue({
      ok: true,
      timezone: "UTC",
      durationMinutes: 30,
      slots: [{ startIso: NEW_START, endIso: NEW_START }]
    } as never);
    mockRescheduleCore.mockResolvedValue({ ok: false, detail: "calendar_not_connected" } as never);
    expect(await rescheduleManagedBooking(TOKEN, NEW_START)).toEqual({
      ok: false,
      detail: "change_failed"
    });

    mockRescheduleCore.mockRejectedValue(new Error("provider 500"));
    expect(await rescheduleManagedBooking(TOKEN, NEW_START)).toEqual({
      ok: false,
      detail: "change_failed"
    });

    // Non-Error throw shape.
    mockRescheduleCore.mockRejectedValue("string boom");
    expect(await rescheduleManagedBooking(TOKEN, NEW_START)).toEqual({
      ok: false,
      detail: "change_failed"
    });
  });

  it("reads a null event id as provider mode (only platform: ids are ledger-only)", async () => {
    mockRow.mockResolvedValue(row({ event_id: null }));
    await rescheduleManagedBooking(TOKEN, NEW_START);
    expect(mockRescheduleCore).toHaveBeenCalled();
    expect(mockMove).not.toHaveBeenCalled();
  });

  it("recovers an email-only attendee from the ledger key, and passes neither when unkeyed", async () => {
    mockRow.mockResolvedValue(row({ attendee_key: "email:liz@x.co" }));
    await rescheduleManagedBooking(TOKEN, NEW_START);
    expect(mockRescheduleCore.mock.calls[0][1]).toMatchObject({ attendeeEmail: "liz@x.co" });

    mockRescheduleCore.mockClear();
    mockRow.mockResolvedValue(row({ attendee_key: "name:liz alvarez" }));
    await rescheduleManagedBooking(TOKEN, NEW_START);
    const args = mockRescheduleCore.mock.calls[0][1];
    expect(args).not.toHaveProperty("attendeePhone");
    expect(args).not.toHaveProperty("attendeeEmail");
  });
});
