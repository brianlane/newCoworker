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
vi.mock("@/lib/zoom/meetings", () => ({ deleteZoomMeetingForBooking: vi.fn() }));
vi.mock("@/lib/calendar-tools/waitlist-fill", () => ({ offerFreedSlot: vi.fn() }));
vi.mock("@/lib/booking-page/db", () => ({
  getBookingPageForBusiness: vi.fn(),
  getBookingByManageToken: vi.fn(),
  moveManagedBooking: vi.fn(),
  deleteManagedBooking: vi.fn()
}));
vi.mock("@/lib/booking-page/service", () => ({ listSlotsForBusiness: vi.fn() }));
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
import { deleteZoomMeetingForBooking } from "@/lib/zoom/meetings";
import { offerFreedSlot } from "@/lib/calendar-tools/waitlist-fill";
import {
  deleteManagedBooking,
  getBookingByManageToken,
  getBookingPageForBusiness,
  moveManagedBooking
} from "@/lib/booking-page/db";
import { listSlotsForBusiness } from "@/lib/booking-page/service";

const BIZ = "11111111-1111-4111-8111-111111111111";
const TOKEN = `ncbm_${"a".repeat(64)}`;
/** Far enough out that the default notice window never bites. */
const FUTURE = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();
const NEW_START = new Date(Date.now() + 6 * 24 * 60 * 60 * 1000).toISOString();

const mockBusiness = vi.mocked(getBusiness);
const mockCancelCore = vi.mocked(cancelCalendarAppointment);
const mockRescheduleCore = vi.mocked(rescheduleCalendarAppointment);
const mockZoomDelete = vi.mocked(deleteZoomMeetingForBooking);
const mockOfferFreed = vi.mocked(offerFreedSlot);
const mockRow = vi.mocked(getBookingByManageToken);
const mockPage = vi.mocked(getBookingPageForBusiness);
const mockMove = vi.mocked(moveManagedBooking);
const mockDelete = vi.mocked(deleteManagedBooking);
const mockSlots = vi.mocked(listSlotsForBusiness);

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
  mockPage.mockResolvedValue({ min_notice_minutes: 120 } as never);
  mockBusiness.mockResolvedValue({ name: "New Coworker", timezone: "America/Phoenix" } as never);
  mockCancelCore.mockResolvedValue({ ok: true } as never);
  mockRescheduleCore.mockResolvedValue({ ok: true } as never);
  mockZoomDelete.mockResolvedValue(undefined as never);
  mockOfferFreed.mockResolvedValue({ offered: false } as never);
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
    expect(out).toEqual({
      ok: true,
      view: {
        businessName: "New Coworker",
        timezone: "America/Phoenix",
        startIso: FUTURE,
        durationMinutes: 30,
        zoomJoinUrl: "https://zoom.us/j/93412345678",
        changeable: true,
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
    // The core handles the ledger, Zoom, and the waitlist offer itself.
    expect(mockDelete).not.toHaveBeenCalled();
    expect(mockOfferFreed).not.toHaveBeenCalled();
  });

  it("platform mode: the ledger row IS the appointment, plus Zoom and waitlist", async () => {
    mockRow.mockResolvedValue(
      row({ event_id: "platform:abc", zoom_meeting_id: "934123", attendee_key: "email:liz@x.co" })
    );
    expect(await cancelManagedBooking(TOKEN)).toEqual({ ok: true });
    expect(mockDelete).toHaveBeenCalledWith("row-1");
    expect(mockZoomDelete).toHaveBeenCalledWith(BIZ, "934123");
    expect(mockOfferFreed).toHaveBeenCalledWith(BIZ, FUTURE);
    expect(mockCancelCore).not.toHaveBeenCalled();
  });

  it("platform mode without a video call skips the Zoom cleanup", async () => {
    mockRow.mockResolvedValue(row({ event_id: "platform:abc", zoom_meeting_id: null }));
    expect(await cancelManagedBooking(TOKEN)).toEqual({ ok: true });
    expect(mockZoomDelete).not.toHaveBeenCalled();
  });

  it("refuses inside the notice window and on an unknown token", async () => {
    mockRow.mockResolvedValue(row({ start_at: new Date(Date.now() + 60_000).toISOString() }));
    expect(await cancelManagedBooking(TOKEN)).toEqual({ ok: false, detail: "too_late" });
    expect(mockCancelCore).not.toHaveBeenCalled();

    mockRow.mockResolvedValue(null);
    expect(await cancelManagedBooking(TOKEN)).toEqual({ ok: false, detail: "not_found" });
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
  });

  it("platform mode: moves the ledger row and frees the old time to the waitlist", async () => {
    mockRow.mockResolvedValue(row({ event_id: "platform:abc" }));
    const out = await rescheduleManagedBooking(TOKEN, NEW_START);
    expect(out).toEqual({ ok: true, startIso: NEW_START });
    expect(mockMove).toHaveBeenCalledWith("row-1", NEW_START);
    expect(mockOfferFreed).toHaveBeenCalledWith(BIZ, FUTURE);
  });

  it("only accepts a time the page is actually offering right now", async () => {
    // The same re-verify the public submit does: a stale tab must not book
    // over someone else.
    const out = await rescheduleManagedBooking(TOKEN, new Date(Date.parse(NEW_START) + 60_000).toISOString());
    expect(out).toEqual({ ok: false, detail: "slot_taken" });
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
