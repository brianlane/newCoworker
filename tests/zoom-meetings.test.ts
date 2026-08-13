/**
 * Tests for the Zoom meeting operations (src/lib/zoom/meetings.ts): the
 * best-effort create/update/read/delete contract over the first-party
 * connection. (The legacy Nango transport was removed Aug 2026; these ops
 * now ride zoomRequestForBusiness alone, which itself answers null when the
 * business has no usable connection.)
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

const zoomRequestForBusiness = vi.fn();
vi.mock("@/lib/zoom/client", () => ({
  zoomRequestForBusiness: (...args: unknown[]) => zoomRequestForBusiness(...args)
}));

import {
  createZoomMeetingForBooking,
  deleteZoomMeetingForBooking,
  getZoomJoinUrl,
  updateZoomMeetingForBooking
} from "@/lib/zoom/meetings";

const BIZ = "11111111-1111-4111-8111-111111111111";
const BOOKING = {
  topic: "Estimate call",
  startIso: "2026-07-20T17:00:00.000Z",
  endIso: "2026-07-20T17:30:00.000Z"
};

beforeEach(() => {
  vi.clearAllMocks();
  // "No usable connection" is the client's null contract, the default here.
  zoomRequestForBusiness.mockResolvedValue(null);
});

describe("createZoomMeetingForBooking", () => {
  it("creates a scheduled meeting", async () => {
    zoomRequestForBusiness.mockResolvedValue({
      data: { id: 987654, join_url: "https://zoom.us/j/987654" }
    });

    expect(await createZoomMeetingForBooking(BIZ, BOOKING)).toEqual({
      meetingId: "987654",
      joinUrl: "https://zoom.us/j/987654"
    });
    expect(zoomRequestForBusiness).toHaveBeenCalledWith(BIZ, {
      endpoint: "/users/me/meetings",
      method: "POST",
      data: {
        topic: "Estimate call",
        type: 2,
        // Zoom rejects/misparses millisecond ISO; send Z-without-ms + UTC.
        start_time: "2026-07-20T17:00:00Z",
        timezone: "UTC",
        duration: 30
      }
    });
  });

  it("includes the agenda when provided and floors duration at 1 minute", async () => {
    zoomRequestForBusiness.mockResolvedValue({
      data: { id: "abc", join_url: "https://zoom.us/j/abc" }
    });
    await createZoomMeetingForBooking(BIZ, {
      ...BOOKING,
      endIso: BOOKING.startIso,
      agenda: "Kitchen sink"
    });
    const [, req] = zoomRequestForBusiness.mock.calls[0] as [
      string,
      { data: Record<string, unknown> }
    ];
    expect(req.data.agenda).toBe("Kitchen sink");
    expect(req.data.duration).toBe(1);
  });

  it("returns null with no usable connection or on a junk body", async () => {
    expect(await createZoomMeetingForBooking(BIZ, BOOKING)).toBeNull();

    zoomRequestForBusiness.mockResolvedValue({ data: { id: 1 } }); // no join_url
    expect(await createZoomMeetingForBooking(BIZ, BOOKING)).toBeNull();

    zoomRequestForBusiness.mockResolvedValue({ data: { join_url: "https://z" } }); // no id
    expect(await createZoomMeetingForBooking(BIZ, BOOKING)).toBeNull();

    zoomRequestForBusiness.mockResolvedValue({ data: null });
    expect(await createZoomMeetingForBooking(BIZ, BOOKING)).toBeNull();
  });

  it("never throws: failures (Error and non-Error) degrade to null", async () => {
    zoomRequestForBusiness.mockRejectedValue(new Error("zoom 500"));
    expect(await createZoomMeetingForBooking(BIZ, BOOKING)).toBeNull();

    zoomRequestForBusiness.mockRejectedValue("raw string failure");
    expect(await createZoomMeetingForBooking(BIZ, BOOKING)).toBeNull();
  });
});

describe("updateZoomMeetingForBooking", () => {
  it("PATCHes the meeting time", async () => {
    zoomRequestForBusiness.mockResolvedValue({ data: null }); // 204
    expect(await updateZoomMeetingForBooking(BIZ, "zm-1", BOOKING)).toBe(true);
    expect(zoomRequestForBusiness).toHaveBeenCalledWith(BIZ, {
      endpoint: "/meetings/zm-1",
      method: "PATCH",
      data: {
        start_time: "2026-07-20T17:00:00Z",
        timezone: "UTC",
        duration: 30
      }
    });
  });

  it("reports false with no usable connection or on a failure", async () => {
    expect(await updateZoomMeetingForBooking(BIZ, "zm-1", BOOKING)).toBe(false);

    zoomRequestForBusiness.mockRejectedValue(new Error("down"));
    expect(await updateZoomMeetingForBooking(BIZ, "zm-1", BOOKING)).toBe(false);

    zoomRequestForBusiness.mockRejectedValue("raw string failure");
    expect(await updateZoomMeetingForBooking(BIZ, "zm-1", BOOKING)).toBe(false);
  });
});

describe("getZoomJoinUrl", () => {
  it("reads the real join URL back (a rebuilt /j/<id> link drops the password)", async () => {
    zoomRequestForBusiness.mockResolvedValue({
      data: { join_url: "https://zoom.us/j/zm-1?pwd=secret" }
    });
    expect(await getZoomJoinUrl(BIZ, "zm-1")).toBe("https://zoom.us/j/zm-1?pwd=secret");
    expect(zoomRequestForBusiness).toHaveBeenCalledWith(BIZ, {
      endpoint: "/meetings/zm-1",
      method: "GET"
    });
  });

  it("answers null (never a broken link) with no connection, no url, or a failure", async () => {
    expect(await getZoomJoinUrl(BIZ, "zm-1")).toBeNull();

    zoomRequestForBusiness.mockResolvedValue({ data: {} });
    expect(await getZoomJoinUrl(BIZ, "zm-1")).toBeNull();

    zoomRequestForBusiness.mockResolvedValue({ data: { join_url: "" } });
    expect(await getZoomJoinUrl(BIZ, "zm-1")).toBeNull();

    zoomRequestForBusiness.mockResolvedValue({ data: { join_url: 42 } });
    expect(await getZoomJoinUrl(BIZ, "zm-1")).toBeNull();

    zoomRequestForBusiness.mockRejectedValue(new Error("down"));
    expect(await getZoomJoinUrl(BIZ, "zm-1")).toBeNull();

    zoomRequestForBusiness.mockRejectedValue("raw string failure");
    expect(await getZoomJoinUrl(BIZ, "zm-1")).toBeNull();
  });
});

describe("deleteZoomMeetingForBooking", () => {
  it("DELETEs the meeting", async () => {
    zoomRequestForBusiness.mockResolvedValue({ data: null });
    expect(await deleteZoomMeetingForBooking(BIZ, "zm-1")).toBe(true);
    expect(zoomRequestForBusiness).toHaveBeenCalledWith(BIZ, {
      endpoint: "/meetings/zm-1",
      method: "DELETE"
    });
  });

  it("reports false with no usable connection or on a failure", async () => {
    expect(await deleteZoomMeetingForBooking(BIZ, "zm-1")).toBe(false);

    zoomRequestForBusiness.mockRejectedValue(new Error("down"));
    expect(await deleteZoomMeetingForBooking(BIZ, "zm-1")).toBe(false);

    zoomRequestForBusiness.mockRejectedValue("raw string failure");
    expect(await deleteZoomMeetingForBooking(BIZ, "zm-1")).toBe(false);
  });
});
