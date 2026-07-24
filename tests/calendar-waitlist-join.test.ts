import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/calendar-tools/handlers", () => ({
  formatBookingStartLocal: vi.fn((iso: string) => `local(${iso})`),
  resolveToolTimezone: vi.fn(async () => "America/Phoenix")
}));
vi.mock("@/lib/calendar-tools/attendee-bookings", () => ({
  findUpcomingBookingsForAttendee: vi.fn()
}));
vi.mock("@/lib/db/booking-waitlist", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getWaitlistSettings: vi.fn(),
  upsertLiveWaitlistEntry: vi.fn()
}));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn() } }));

import { joinCalendarWaitlist } from "@/lib/calendar-tools/waitlist-join";
import { findUpcomingBookingsForAttendee } from "@/lib/calendar-tools/attendee-bookings";
import {
  getWaitlistSettings,
  upsertLiveWaitlistEntry,
  WAITLIST_DEFAULT_DURATION_MINUTES
} from "@/lib/db/booking-waitlist";
import { logger } from "@/lib/logger";

/**
 * calendar_join_waitlist core: phone-gated capture ("the offer arrives by
 * text"), owner toggle respected, and the entry linked to the attendee's
 * soonest upcoming booking so "earlier" means earlier than what they hold.
 */

const BIZ = "11111111-1111-4111-8111-111111111111";
const PHONE = "+15485773546";

const mockUpcoming = vi.mocked(findUpcomingBookingsForAttendee);
const mockSettings = vi.mocked(getWaitlistSettings);
const mockUpsert = vi.mocked(upsertLiveWaitlistEntry);

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-01T00:00:00Z"));
  mockSettings.mockResolvedValue({ enabled: true, offerTtlMinutes: 60 });
  mockUpcoming.mockResolvedValue([]);
  mockUpsert.mockResolvedValue({ row: { id: "wl-1" } as never, created: true });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("joinCalendarWaitlist", () => {
  it("refuses without a usable full mobile number (guides the model)", async () => {
    const noPhone = await joinCalendarWaitlist(BIZ, {});
    expect(noPhone.ok).toBe(false);
    expect(noPhone.detail).toBe("phone_required");
    expect(noPhone.message).toContain("mobile number");

    // Short codes normalize fine but are not reachable customer numbers.
    const shortCode = await joinCalendarWaitlist(BIZ, { attendeePhone: "34733" });
    expect(shortCode.detail).toBe("phone_required");
    expect(mockSettings).not.toHaveBeenCalled();
  });

  it("refuses when the owner turned the waitlist off", async () => {
    mockSettings.mockResolvedValue({ enabled: false, offerTtlMinutes: 60 });
    const result = await joinCalendarWaitlist(BIZ, { attendeePhone: PHONE });
    expect(result).toMatchObject({ ok: false, detail: "waitlist_disabled" });
    expect(result.message).toContain("notify_team");
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("links the entry to the soonest FUTURE booking and defaults the window to it", async () => {
    mockUpcoming.mockResolvedValue([
      // Past booking is ignored; the two future ones sort by start.
      { provider: "ledger", source: "platform", eventId: "old", startIso: "2026-07-01T15:00:00Z", name: null, rescheduled: false },
      { provider: "ledger", source: "platform", eventId: "evt-later", startIso: "2026-08-09T15:00:00Z", name: null, rescheduled: false },
      { provider: "ledger", source: "platform", eventId: "evt-soon", startIso: "2026-08-04T15:00:00Z", name: null, rescheduled: false }
    ]);
    const result = await joinCalendarWaitlist(
      BIZ,
      { attendeeName: "Brian", attendeeEmail: "B@Acme.Co", durationMinutes: 60 },
      // The voice surface backfills the caller's number.
      PHONE
    );
    expect(result.ok).toBe(true);
    expect(result.detail).toBe("waitlist_joined");
    expect(mockUpsert).toHaveBeenCalledWith(BIZ, {
      phone: PHONE,
      email: "b@acme.co",
      name: "Brian",
      durationMinutes: 60,
      latestAtIso: "2026-08-04T15:00:00.000Z",
      currentBookingStartAtIso: "2026-08-04T15:00:00.000Z",
      currentEventId: "evt-soon"
    });
    expect((result.data as { currentBookingStartLocal: string }).currentBookingStartLocal).toBe(
      "local(2026-08-04T15:00:00.000Z)"
    );
    expect(result.message).toContain(PHONE);
    expect(result.message).toContain("stays as is");
  });

  it("joins unlinked with the default window when no booking exists (explicit latest wins)", async () => {
    const result = await joinCalendarWaitlist(BIZ, {
      attendeePhone: PHONE,
      latestIso: "2026-08-20T00:00:00Z"
    });
    expect(result.detail).toBe("waitlist_joined");
    expect(mockUpsert).toHaveBeenCalledWith(BIZ, {
      phone: PHONE,
      email: null,
      name: null,
      durationMinutes: WAITLIST_DEFAULT_DURATION_MINUTES,
      latestAtIso: "2026-08-20T00:00:00.000Z",
      currentBookingStartAtIso: null,
      currentEventId: null
    });
    expect(result.message).not.toContain("stays as is");

    // No explicit latest and no booking: the 14-day default window.
    mockUpsert.mockClear();
    await joinCalendarWaitlist(BIZ, { attendeePhone: PHONE });
    expect(mockUpsert.mock.calls[0][1].latestAtIso).toBe("2026-08-15T00:00:00.000Z");
  });

  it("joins unlinked when the upcoming-booking lookup blows up (fail-open, any throw shape)", async () => {
    mockUpcoming.mockRejectedValue(new Error("provider down"));
    const result = await joinCalendarWaitlist(BIZ, { attendeePhone: PHONE });
    expect(result.ok).toBe(true);
    expect(mockUpsert.mock.calls[0][1].currentBookingStartAtIso).toBeNull();
    expect(logger.warn).toHaveBeenCalled();

    mockUpcoming.mockRejectedValue("string blast");
    expect((await joinCalendarWaitlist(BIZ, { attendeePhone: PHONE })).ok).toBe(true);
    expect(logger.warn).toHaveBeenLastCalledWith(
      "waitlist-join: upcoming-booking lookup failed (joining unlinked)",
      expect.objectContaining({ error: "string blast" })
    );
  });

  it("reports waitlist_updated on a refresh, waitlist_failed on a dead ledger, and catches throws", async () => {
    mockUpsert.mockResolvedValue({ row: { id: "wl-1" } as never, created: false });
    expect((await joinCalendarWaitlist(BIZ, { attendeePhone: PHONE })).detail).toBe(
      "waitlist_updated"
    );

    mockUpsert.mockResolvedValue(null);
    expect((await joinCalendarWaitlist(BIZ, { attendeePhone: PHONE })).detail).toBe(
      "waitlist_failed"
    );

    mockSettings.mockRejectedValue(new Error("boom"));
    expect((await joinCalendarWaitlist(BIZ, { attendeePhone: PHONE })).detail).toBe(
      "waitlist_failed"
    );

    mockSettings.mockRejectedValue("string blast");
    expect((await joinCalendarWaitlist(BIZ, { attendeePhone: PHONE })).detail).toBe(
      "waitlist_failed"
    );
  });
});
