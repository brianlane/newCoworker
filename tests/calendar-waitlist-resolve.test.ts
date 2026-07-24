import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/booking-waitlist", () => ({
  findLiveWaitlistEntriesForAttendee: vi.fn(),
  setWaitlistStatus: vi.fn(),
  updateWaitlistBookingLink: vi.fn()
}));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn() } }));

import {
  cancelWaitlistForAttendee,
  resolveWaitlistAfterBooking
} from "@/lib/calendar-tools/waitlist-resolve";
import {
  findLiveWaitlistEntriesForAttendee,
  setWaitlistStatus,
  updateWaitlistBookingLink,
  type BookingWaitlistRow
} from "@/lib/db/booking-waitlist";
import { logger } from "@/lib/logger";

/**
 * Waitlist lifecycle resolution: a confirmed booking either FULFILLS an
 * attendee's live entry (they got an earlier time) or re-points it at the
 * booking they now hold; an outright cancel drops their entries. Both are
 * best-effort by contract.
 */

const BIZ = "11111111-1111-4111-8111-111111111111";
const ATTENDEE = { phones: ["+15485773546"], email: null };

const mockFind = vi.mocked(findLiveWaitlistEntriesForAttendee);
const mockStatus = vi.mocked(setWaitlistStatus);
const mockLink = vi.mocked(updateWaitlistBookingLink);

function entry(overrides: Partial<BookingWaitlistRow> = {}): BookingWaitlistRow {
  return {
    id: "wl-1",
    business_id: BIZ,
    phone: "+15485773546",
    email: null,
    name: null,
    duration_minutes: 30,
    earliest_at: "2026-07-01T00:00:00Z",
    latest_at: null,
    current_booking_start_at: null,
    current_event_id: null,
    status: "waiting",
    offered_start_at: null,
    offered_end_at: null,
    offer_expires_at: null,
    last_offered_start_at: null,
    created_at: "2026-07-01T00:00:00Z",
    updated_at: "2026-07-01T00:00:00Z",
    ...overrides
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFind.mockResolvedValue([]);
});

describe("resolveWaitlistAfterBooking", () => {
  it("fulfills an entry whose pending offer covers the new start", async () => {
    mockFind.mockResolvedValue([
      entry({
        status: "offered",
        offered_start_at: "2026-08-01T16:00:00Z",
        current_booking_start_at: "2026-08-04T15:00:00Z"
      })
    ]);
    await resolveWaitlistAfterBooking(BIZ, ATTENDEE, "2026-08-01T16:00:00.000Z");
    expect(mockStatus).toHaveBeenCalledWith("wl-1", "fulfilled");
    expect(mockLink).not.toHaveBeenCalled();
  });

  it("fulfills when the new start beats the linked booking", async () => {
    mockFind.mockResolvedValue([
      entry({ current_booking_start_at: "2026-08-04T15:00:00Z" })
    ]);
    await resolveWaitlistAfterBooking(BIZ, ATTENDEE, "2026-08-02T15:00:00.000Z");
    expect(mockStatus).toHaveBeenCalledWith("wl-1", "fulfilled");
  });

  it("an UNLINKED entry's first booking re-points instead of fulfilling (the request survives)", async () => {
    // "Text me if anything sooner opens up" then booking today's earliest
    // available time must keep them in line for something earlier.
    mockFind.mockResolvedValue([entry()]);
    await resolveWaitlistAfterBooking(BIZ, ATTENDEE, "2026-08-09T15:00:00.000Z");
    expect(mockStatus).not.toHaveBeenCalled();
    expect(mockLink).toHaveBeenCalledWith("wl-1", {
      currentBookingStartAtIso: "2026-08-09T15:00:00.000Z"
    });
  });

  it("re-points the entry when the attendee moved LATER instead", async () => {
    mockFind.mockResolvedValue([
      entry({ current_booking_start_at: "2026-08-04T15:00:00Z" })
    ]);
    await resolveWaitlistAfterBooking(BIZ, ATTENDEE, "2026-08-06T15:00:00.000Z");
    expect(mockStatus).not.toHaveBeenCalled();
    expect(mockLink).toHaveBeenCalledWith("wl-1", {
      currentBookingStartAtIso: "2026-08-06T15:00:00.000Z"
    });
  });

  it("ignores unparseable starts and never throws on lookup trouble", async () => {
    await resolveWaitlistAfterBooking(BIZ, ATTENDEE, "not-a-date");
    expect(mockFind).not.toHaveBeenCalled();

    mockFind.mockRejectedValue(new Error("db down"));
    await expect(
      resolveWaitlistAfterBooking(BIZ, ATTENDEE, "2026-08-01T16:00:00Z")
    ).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();

    // Non-Error throw shapes degrade the same way.
    mockFind.mockRejectedValue("string blast");
    await expect(
      resolveWaitlistAfterBooking(BIZ, ATTENDEE, "2026-08-01T16:00:00Z")
    ).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenLastCalledWith(
      "waitlist-resolve: after-booking resolution failed",
      expect.objectContaining({ error: "string blast" })
    );
  });
});

describe("cancelWaitlistForAttendee", () => {
  it("cancels every live entry for the attendee", async () => {
    mockFind.mockResolvedValue([entry(), entry({ id: "wl-2" })]);
    await cancelWaitlistForAttendee(BIZ, ATTENDEE);
    expect(mockStatus).toHaveBeenCalledWith("wl-1", "canceled");
    expect(mockStatus).toHaveBeenCalledWith("wl-2", "canceled");
  });

  it("never throws on lookup trouble (Error and non-Error shapes)", async () => {
    mockFind.mockRejectedValue(new Error("db down"));
    await expect(cancelWaitlistForAttendee(BIZ, ATTENDEE)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();

    mockFind.mockRejectedValue("string blast");
    await expect(cancelWaitlistForAttendee(BIZ, ATTENDEE)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenLastCalledWith(
      "waitlist-resolve: cancel resolution failed",
      expect.objectContaining({ error: "string blast" })
    );
  });
});
