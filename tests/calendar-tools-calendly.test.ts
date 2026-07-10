/**
 * Tests for the Calendly provider cores (src/lib/calendar-tools/calendly.ts):
 * event-type selection, available-times slot mapping (with Calendly's
 * future-start / 7-day window clamps), and single-use scheduling-link
 * creation for the booking tool.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/nango/workspace", () => ({ nangoProxyForBusiness: vi.fn() }));

import {
  CALENDLY_MAX_WINDOW_MS,
  CALENDLY_MIN_LEAD_MS,
  createCalendlyBookingLink,
  findCalendlySlots,
  pickCalendlyEventType
} from "@/lib/calendar-tools/calendly";
import { nangoProxyForBusiness } from "@/lib/nango/workspace";

const BIZ = "11111111-1111-4111-8111-111111111111";

const CONN = {
  provider: "calendly",
  connectionId: "conn-3",
  providerConfigKey: "calendly"
} as never;

const NOW = Date.parse("2026-06-12T09:00:00.000Z");

const USER_URI = "https://api.calendly.com/users/USER1";

function usersMeResponse(uri: unknown = USER_URI) {
  return { data: { resource: { uri } } } as never;
}

function eventTypesResponse(
  collection: Array<Record<string, unknown>> | undefined
) {
  return { data: { collection } } as never;
}

/** Queue the /users/me + /event_types responses that every path issues. */
function mockUserAndEventTypes(collection: Array<Record<string, unknown>>) {
  vi.mocked(nangoProxyForBusiness)
    .mockResolvedValueOnce(usersMeResponse())
    .mockResolvedValueOnce(eventTypesResponse(collection));
}

const THIRTY_MIN = {
  uri: "https://api.calendly.com/event_types/ET30",
  name: "Intro Call",
  duration: 30,
  scheduling_url: "https://calendly.com/acme/intro"
};
const SIXTY_MIN = {
  uri: "https://api.calendly.com/event_types/ET60",
  name: "Consultation",
  duration: 60,
  scheduling_url: "https://calendly.com/acme/consult"
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("pickCalendlyEventType", () => {
  it("is not_connected when the /users/me proxy call is refused", async () => {
    vi.mocked(nangoProxyForBusiness).mockResolvedValueOnce(null as never);
    expect(await pickCalendlyEventType(BIZ, CONN, 30)).toBe("not_connected");
  });

  it("is not_connected when /users/me has no usable uri", async () => {
    vi.mocked(nangoProxyForBusiness).mockResolvedValueOnce(usersMeResponse(""));
    expect(await pickCalendlyEventType(BIZ, CONN, 30)).toBe("not_connected");

    vi.mocked(nangoProxyForBusiness).mockResolvedValueOnce({ data: {} } as never);
    expect(await pickCalendlyEventType(BIZ, CONN, 30)).toBe("not_connected");
  });

  it("is not_connected when the /event_types proxy call is refused", async () => {
    vi.mocked(nangoProxyForBusiness)
      .mockResolvedValueOnce(usersMeResponse())
      .mockResolvedValueOnce(null as never);
    expect(await pickCalendlyEventType(BIZ, CONN, 30)).toBe("not_connected");
  });

  it("queries event types filtered to the resolved user", async () => {
    mockUserAndEventTypes([THIRTY_MIN]);
    await pickCalendlyEventType(BIZ, CONN, 30);
    expect(vi.mocked(nangoProxyForBusiness)).toHaveBeenNthCalledWith(
      2,
      BIZ,
      { connectionId: "conn-3", providerConfigKey: "calendly" },
      expect.objectContaining({
        endpoint: "/event_types",
        params: expect.objectContaining({ user: USER_URI, active: "true" })
      })
    );
  });

  it("is no_event_types when the collection is missing or empty", async () => {
    mockUserAndEventTypes([]);
    expect(await pickCalendlyEventType(BIZ, CONN, 30)).toBe("no_event_types");

    vi.mocked(nangoProxyForBusiness)
      .mockResolvedValueOnce(usersMeResponse())
      .mockResolvedValueOnce({ data: {} } as never);
    expect(await pickCalendlyEventType(BIZ, CONN, 30)).toBe("no_event_types");
  });

  it("drops entries without a uri and explicitly inactive entries", async () => {
    mockUserAndEventTypes([
      { name: "no uri", duration: 30 },
      { ...THIRTY_MIN, active: false }
    ]);
    expect(await pickCalendlyEventType(BIZ, CONN, 30)).toBe("no_event_types");
  });

  it("picks the event type whose duration is closest to the request (tie → first listed)", async () => {
    mockUserAndEventTypes([THIRTY_MIN, SIXTY_MIN]);
    const picked = await pickCalendlyEventType(BIZ, CONN, 50);
    expect(picked).not.toBeTypeOf("string");
    expect((picked as { eventType: { uri: string } }).eventType.uri).toBe(SIXTY_MIN.uri);

    // Tie: 45 is equidistant from 30 and 60 → the first listed wins.
    mockUserAndEventTypes([THIRTY_MIN, SIXTY_MIN]);
    const tied = await pickCalendlyEventType(BIZ, CONN, 45);
    expect((tied as { eventType: { uri: string } }).eventType.uri).toBe(THIRTY_MIN.uri);
  });

  it("defaults a missing name/duration/scheduling_url", async () => {
    mockUserAndEventTypes([{ uri: "https://api.calendly.com/event_types/ETX" }]);
    const picked = await pickCalendlyEventType(BIZ, CONN, 30);
    expect(picked).toEqual({
      eventType: {
        uri: "https://api.calendly.com/event_types/ETX",
        name: "Appointment",
        duration: 30,
        schedulingUrl: null
      }
    });
  });

  it("treats a non-positive duration as the 30-minute default", async () => {
    mockUserAndEventTypes([{ ...THIRTY_MIN, duration: 0 }]);
    const picked = await pickCalendlyEventType(BIZ, CONN, 30);
    expect((picked as { eventType: { duration: number } }).eventType.duration).toBe(30);
  });
});

describe("findCalendlySlots", () => {
  const WINDOW = {
    windowStart: new Date(NOW + 60 * 60_000), // 10:00Z
    windowEnd: new Date(NOW + 26 * 60 * 60_000), // next day 11:00Z
    durationMinutes: 30,
    timezone: "America/Phoenix"
  };

  it("propagates not_connected from event-type selection", async () => {
    vi.mocked(nangoProxyForBusiness).mockResolvedValueOnce(null as never);
    expect(await findCalendlySlots(BIZ, CONN, WINDOW)).toEqual({
      ok: false,
      detail: "calendar_not_connected"
    });
  });

  it("surfaces an account with no active event types", async () => {
    mockUserAndEventTypes([]);
    expect(await findCalendlySlots(BIZ, CONN, WINDOW)).toEqual({
      ok: false,
      detail: "calendly_no_event_types"
    });
  });

  it("rejects a window entirely in the past", async () => {
    mockUserAndEventTypes([THIRTY_MIN]);
    const result = await findCalendlySlots(BIZ, CONN, {
      ...WINDOW,
      windowStart: new Date(NOW - 2 * 60 * 60_000),
      windowEnd: new Date(NOW - 60 * 60_000)
    });
    expect(result).toEqual({ ok: false, detail: "invalid_window" });
  });

  it("is not connected when the available-times proxy call is refused", async () => {
    mockUserAndEventTypes([THIRTY_MIN]);
    vi.mocked(nangoProxyForBusiness).mockResolvedValueOnce(null as never);
    expect(await findCalendlySlots(BIZ, CONN, WINDOW)).toEqual({
      ok: false,
      detail: "calendar_not_connected"
    });
  });

  it("maps available times to slots with the event type's duration", async () => {
    mockUserAndEventTypes([THIRTY_MIN, SIXTY_MIN]);
    vi.mocked(nangoProxyForBusiness).mockResolvedValueOnce({
      data: {
        collection: [
          { status: "available", start_time: "2026-06-12T15:00:00.000Z" },
          { status: "available", start_time: "2026-06-12T16:00:00.000Z" }
        ]
      }
    } as never);
    const result = await findCalendlySlots(BIZ, CONN, {
      ...WINDOW,
      durationMinutes: 55,
      purpose: "estimate"
    });
    expect(result).toEqual({
      ok: true,
      data: {
        slots: [
          {
            startIso: "2026-06-12T15:00:00.000Z",
            endIso: "2026-06-12T16:00:00.000Z"
          },
          {
            startIso: "2026-06-12T16:00:00.000Z",
            endIso: "2026-06-12T17:00:00.000Z"
          }
        ],
        timezone: "America/Phoenix",
        purpose: "estimate",
        durationMinutes: 60, // the SIXTY_MIN event type won for a 55-min ask
        provider: "calendly",
        eventTypeName: "Consultation",
        schedulingUrl: "https://calendly.com/acme/consult"
      }
    });
  });

  it("clamps the query window to a future start and Calendly's 7-day maximum", async () => {
    mockUserAndEventTypes([THIRTY_MIN]);
    vi.mocked(nangoProxyForBusiness).mockResolvedValueOnce({
      data: { collection: [] }
    } as never);
    await findCalendlySlots(BIZ, CONN, {
      ...WINDOW,
      windowStart: new Date(NOW - 60 * 60_000), // in the past → clamped forward
      windowEnd: new Date(NOW + 30 * 24 * 60 * 60_000) // 30 days → clamped to 7
    });
    const call = vi.mocked(nangoProxyForBusiness).mock.calls[2][2] as unknown as {
      params: { start_time: string; end_time: string };
    };
    const start = Date.parse(call.params.start_time);
    const end = Date.parse(call.params.end_time);
    expect(start).toBe(NOW + CALENDLY_MIN_LEAD_MS);
    expect(end).toBe(start + CALENDLY_MAX_WINDOW_MS);
  });

  it("filters unavailable/malformed times, keeps status-less ones, and caps at 3 slots", async () => {
    mockUserAndEventTypes([THIRTY_MIN]);
    vi.mocked(nangoProxyForBusiness).mockResolvedValueOnce({
      data: {
        collection: [
          { status: "unavailable", start_time: "2026-06-12T14:00:00.000Z" },
          { status: "available" }, // no start_time → dropped
          { start_time: "2026-06-12T15:00:00.000Z" }, // status-less → kept
          { status: "available", start_time: "2026-06-12T16:00:00.000Z" },
          { status: "available", start_time: "2026-06-12T17:00:00.000Z" },
          { status: "available", start_time: "2026-06-12T18:00:00.000Z" }
        ]
      }
    } as never);
    const result = await findCalendlySlots(BIZ, CONN, WINDOW);
    const data = result.data as { slots: Array<{ startIso: string }>; purpose: null };
    expect(data.slots.map((s) => s.startIso)).toEqual([
      "2026-06-12T15:00:00.000Z",
      "2026-06-12T16:00:00.000Z",
      "2026-06-12T17:00:00.000Z"
    ]);
    expect(data.purpose).toBeNull();
  });

  it("tolerates a body without a collection", async () => {
    mockUserAndEventTypes([THIRTY_MIN]);
    vi.mocked(nangoProxyForBusiness).mockResolvedValueOnce({ data: {} } as never);
    const result = await findCalendlySlots(BIZ, CONN, WINDOW);
    expect(result.ok).toBe(true);
    expect((result.data as { slots: unknown[] }).slots).toEqual([]);
  });
});

describe("createCalendlyBookingLink", () => {
  const ARGS = {
    startIso: "2026-06-12T17:00:00.000Z",
    endIso: "2026-06-12T17:30:00.000Z"
  };

  it("propagates not_connected from event-type selection", async () => {
    vi.mocked(nangoProxyForBusiness).mockResolvedValueOnce(null as never);
    expect(await createCalendlyBookingLink(BIZ, CONN, ARGS)).toEqual({
      ok: false,
      detail: "calendar_not_connected"
    });
  });

  it("surfaces an account with no active event types", async () => {
    mockUserAndEventTypes([]);
    expect(await createCalendlyBookingLink(BIZ, CONN, ARGS)).toEqual({
      ok: false,
      detail: "calendly_no_event_types"
    });
  });

  it("creates a single-use scheduling link for the best-matching event type", async () => {
    mockUserAndEventTypes([THIRTY_MIN, SIXTY_MIN]);
    vi.mocked(nangoProxyForBusiness).mockResolvedValueOnce({
      data: { resource: { booking_url: "https://calendly.com/d/one-off" } }
    } as never);
    const result = await createCalendlyBookingLink(BIZ, CONN, ARGS);
    expect(result).toEqual({
      ok: true,
      detail: "booking_link_created",
      data: {
        eventId: null,
        htmlLink: "https://calendly.com/d/one-off",
        provider: "calendly",
        calendar: "calendly",
        bookingLink: "https://calendly.com/d/one-off",
        eventTypeName: "Intro Call"
      }
    });
    expect(vi.mocked(nangoProxyForBusiness)).toHaveBeenNthCalledWith(
      3,
      BIZ,
      { connectionId: "conn-3", providerConfigKey: "calendly" },
      {
        endpoint: "/scheduling_links",
        method: "POST",
        data: { max_event_count: 1, owner: THIRTY_MIN.uri, owner_type: "EventType" }
      }
    );
  });

  it("clamps a degenerate window to a 1-minute duration ask", async () => {
    mockUserAndEventTypes([THIRTY_MIN, SIXTY_MIN]);
    vi.mocked(nangoProxyForBusiness).mockResolvedValueOnce({
      data: { resource: { booking_url: "https://calendly.com/d/x" } }
    } as never);
    // endIso before startIso → Math.max clamps to 1 minute → 30-min type wins.
    const result = await createCalendlyBookingLink(BIZ, CONN, {
      startIso: "2026-06-12T17:00:00.000Z",
      endIso: "2026-06-12T16:00:00.000Z"
    });
    expect(result.ok).toBe(true);
    const link = vi.mocked(nangoProxyForBusiness).mock.calls[2][2] as {
      data: { owner: string };
    };
    expect(link.data.owner).toBe(THIRTY_MIN.uri);
  });

  it("is not connected when the scheduling-link proxy call is refused", async () => {
    mockUserAndEventTypes([THIRTY_MIN]);
    vi.mocked(nangoProxyForBusiness).mockResolvedValueOnce(null as never);
    expect(await createCalendlyBookingLink(BIZ, CONN, ARGS)).toEqual({
      ok: false,
      detail: "calendar_not_connected"
    });
  });

  it("fails when Calendly returns no booking_url", async () => {
    mockUserAndEventTypes([THIRTY_MIN]);
    vi.mocked(nangoProxyForBusiness).mockResolvedValueOnce({ data: {} } as never);
    expect(await createCalendlyBookingLink(BIZ, CONN, ARGS)).toEqual({
      ok: false,
      detail: "calendar_book_failed"
    });

    mockUserAndEventTypes([THIRTY_MIN]);
    vi.mocked(nangoProxyForBusiness).mockResolvedValueOnce({
      data: { resource: { booking_url: "" } }
    } as never);
    expect(await createCalendlyBookingLink(BIZ, CONN, ARGS)).toEqual({
      ok: false,
      detail: "calendar_book_failed"
    });
  });
});
