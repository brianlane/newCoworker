/**
 * Tests for the Calendly provider cores (src/lib/calendar-tools/calendly.ts):
 * event-type selection, available-times slot mapping (with Calendly's
 * future-start / 7-day window clamps), single-use scheduling-link creation
 * for the booking tool, and the Nango-vs-direct-PAT transport switch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/nango/workspace", () => ({ nangoProxyForBusiness: vi.fn() }));
vi.mock("@/lib/calendly/client", () => ({ calendlyDirectRequest: vi.fn() }));
vi.mock("@/lib/db/calendly-connections", () => ({ getActiveCalendlyConnection: vi.fn() }));

import {
  CALENDLY_MAX_WINDOW_MS,
  CALENDLY_MIN_LEAD_MS,
  cancelCalendlyAppointment,
  createCalendlyBookingLink,
  createCalendlyRescheduleLink,
  findCalendlyScheduledEvent,
  findCalendlySlots,
  pickCalendlyEventType
} from "@/lib/calendar-tools/calendly";
import { nangoProxyForBusiness } from "@/lib/nango/workspace";
import { calendlyDirectRequest } from "@/lib/calendly/client";
import { getActiveCalendlyConnection } from "@/lib/db/calendly-connections";

const BIZ = "11111111-1111-4111-8111-111111111111";

const CONN = {
  provider: "calendly",
  connectionId: "conn-3",
  providerConfigKey: "calendly"
} as never;

const DIRECT_CONN = {
  provider: "calendly",
  connectionId: "calendly-row-1",
  providerConfigKey: "calendly-direct"
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

// ── Lifecycle: locate / cancel / reschedule-link ─────────────────────────────

const EVENT_URI = "https://api.calendly.com/scheduled_events/EV1";
const RESCHEDULE_URL = "https://calendly.com/reschedulings/abc123";
const PHONE = "+15485773546";

function scheduledEventsResponse(collection: Array<Record<string, unknown>> | undefined) {
  return { data: { collection } } as never;
}

function inviteesResponse(collection: Array<Record<string, unknown>> | undefined) {
  return { data: { collection } } as never;
}

const MATCHING_INVITEE = {
  email: "Joe@Acme.com",
  text_reminder_number: "+1 (548) 577-3546",
  reschedule_url: RESCHEDULE_URL,
  status: "active"
};

/** Queue /users/me + /scheduled_events (the prefix every lifecycle path issues). */
function mockUserAndEvents(collection: Array<Record<string, unknown>> | undefined) {
  vi.mocked(nangoProxyForBusiness)
    .mockResolvedValueOnce(usersMeResponse())
    .mockResolvedValueOnce(scheduledEventsResponse(collection));
}

describe("findCalendlyScheduledEvent", () => {
  it("is not_found immediately when the caller has no phone or email", async () => {
    expect(await findCalendlyScheduledEvent(BIZ, CONN, {})).toBe("not_found");
    expect(await findCalendlyScheduledEvent(BIZ, CONN, { phone: "  ", email: "" })).toBe(
      "not_found"
    );
    expect(vi.mocked(nangoProxyForBusiness)).not.toHaveBeenCalled();
  });

  it("is not_connected when /users/me or the events listing is refused", async () => {
    vi.mocked(nangoProxyForBusiness).mockResolvedValueOnce(null as never);
    expect(await findCalendlyScheduledEvent(BIZ, CONN, { phone: PHONE })).toBe("not_connected");

    vi.mocked(nangoProxyForBusiness)
      .mockResolvedValueOnce(usersMeResponse())
      .mockResolvedValueOnce(null as never);
    expect(await findCalendlyScheduledEvent(BIZ, CONN, { phone: PHONE })).toBe("not_connected");
  });

  it("is not_connected when an invitee listing is refused mid-scan", async () => {
    mockUserAndEvents([{ uri: EVENT_URI }]);
    vi.mocked(nangoProxyForBusiness).mockResolvedValueOnce(null as never);
    expect(await findCalendlyScheduledEvent(BIZ, CONN, { phone: PHONE })).toBe("not_connected");
  });

  it("lists ACTIVE upcoming events for the resolved user, earliest first", async () => {
    mockUserAndEvents([]);
    await findCalendlyScheduledEvent(BIZ, CONN, { phone: PHONE });
    const listCall = vi.mocked(nangoProxyForBusiness).mock.calls[1][2] as {
      endpoint: string;
      params: Record<string, string>;
    };
    expect(listCall.endpoint).toBe("/scheduled_events");
    expect(listCall.params).toMatchObject({
      user: USER_URI,
      status: "active",
      sort: "start_time:asc"
    });
    expect(Date.parse(listCall.params.min_start_time)).toBe(NOW);
  });

  it("matches an invitee by SMS number digits (formatting-insensitive)", async () => {
    mockUserAndEvents([{ uri: EVENT_URI }]);
    vi.mocked(nangoProxyForBusiness).mockResolvedValueOnce(
      // Email-less invitee: SMS number alone must carry the match.
      inviteesResponse([{ ...MATCHING_INVITEE, email: undefined }])
    );
    const found = await findCalendlyScheduledEvent(BIZ, CONN, { phone: PHONE });
    expect(found).toEqual({
      event: { eventUri: EVENT_URI, eventUuid: "EV1", rescheduleUrl: RESCHEDULE_URL }
    });
  });

  it("matches across country-code variants (national vs E.164) but never on loose suffixes", async () => {
    // Calendly stored the NATIONAL form; our side holds E.164 — still a match.
    mockUserAndEvents([{ uri: EVENT_URI }]);
    vi.mocked(nangoProxyForBusiness).mockResolvedValueOnce(
      inviteesResponse([{ ...MATCHING_INVITEE, text_reminder_number: "(548) 577-3546" }])
    );
    expect(await findCalendlyScheduledEvent(BIZ, CONN, { phone: PHONE })).not.toBe("not_found");

    // The reverse: Calendly stored E.164, the caller passed the national form.
    mockUserAndEvents([{ uri: EVENT_URI }]);
    vi.mocked(nangoProxyForBusiness).mockResolvedValueOnce(
      inviteesResponse([MATCHING_INVITEE])
    );
    expect(
      await findCalendlyScheduledEvent(BIZ, CONN, { phone: "548-577-3546" })
    ).not.toBe("not_found");

    // A DIFFERENT number sharing no suffix must not match.
    mockUserAndEvents([{ uri: EVENT_URI }]);
    vi.mocked(nangoProxyForBusiness).mockResolvedValueOnce(
      inviteesResponse([{ ...MATCHING_INVITEE, text_reminder_number: "+15550001111" }])
    );
    expect(await findCalendlyScheduledEvent(BIZ, CONN, { phone: PHONE })).toBe("not_found");

    // Short strings (below 7 digits) only match on EXACT equality — a bare
    // suffix of a real number is too ambiguous to act on.
    mockUserAndEvents([{ uri: EVENT_URI }]);
    vi.mocked(nangoProxyForBusiness).mockResolvedValueOnce(
      inviteesResponse([{ ...MATCHING_INVITEE, text_reminder_number: "773546" }])
    );
    expect(await findCalendlyScheduledEvent(BIZ, CONN, { phone: PHONE })).toBe("not_found");

    mockUserAndEvents([{ uri: EVENT_URI }]);
    vi.mocked(nangoProxyForBusiness).mockResolvedValueOnce(
      inviteesResponse([{ ...MATCHING_INVITEE, text_reminder_number: "773546" }])
    );
    expect(
      await findCalendlyScheduledEvent(BIZ, CONN, { phone: "77-35-46" })
    ).not.toBe("not_found");
  });

  it("phone match beats an earlier email-only match when both identities are supplied", async () => {
    const EV2_URI = "https://api.calendly.com/scheduled_events/EV2";
    mockUserAndEvents([{ uri: EVENT_URI }, { uri: EV2_URI }]);
    vi.mocked(nangoProxyForBusiness)
      // EV1 (earlier): the supplied email but a DIFFERENT SMS number — this
      // is someone else's booking under a shared/stale email.
      .mockResolvedValueOnce(
        inviteesResponse([
          { email: "joe@acme.com", text_reminder_number: "+15550001111", reschedule_url: "x" }
        ])
      )
      // EV2 (later): the surface-verified phone.
      .mockResolvedValueOnce(inviteesResponse([MATCHING_INVITEE]));
    const found = await findCalendlyScheduledEvent(BIZ, CONN, {
      phone: PHONE,
      email: "joe@acme.com"
    });
    expect(found).toEqual({
      event: { eventUri: EV2_URI, eventUuid: "EV2", rescheduleUrl: RESCHEDULE_URL }
    });
  });

  it("falls back to the EARLIEST email match when no event matches the phone", async () => {
    const EV2_URI = "https://api.calendly.com/scheduled_events/EV2";
    mockUserAndEvents([{ uri: EVENT_URI }, { uri: EV2_URI }]);
    vi.mocked(nangoProxyForBusiness)
      .mockResolvedValueOnce(
        inviteesResponse([{ email: "joe@acme.com", reschedule_url: RESCHEDULE_URL }])
      )
      // A second email match later must not displace the earliest one.
      .mockResolvedValueOnce(inviteesResponse([{ email: "joe@acme.com", reschedule_url: "y" }]));
    const found = await findCalendlyScheduledEvent(BIZ, CONN, {
      phone: PHONE,
      email: "joe@acme.com"
    });
    expect(found).toEqual({
      event: { eventUri: EVENT_URI, eventUuid: "EV1", rescheduleUrl: RESCHEDULE_URL }
    });
  });

  it("matches an invitee by email case-insensitively", async () => {
    mockUserAndEvents([{ uri: EVENT_URI }]);
    vi.mocked(nangoProxyForBusiness).mockResolvedValueOnce(
      inviteesResponse([MATCHING_INVITEE])
    );
    const found = await findCalendlyScheduledEvent(BIZ, CONN, { email: "joe@acme.com" });
    expect(found).not.toBe("not_found");
  });

  it("skips canceled invitees, other people's events, uri-less rows, and malformed bodies", async () => {
    mockUserAndEvents([
      { start_time: "2026-06-13T15:00:00Z" }, // no uri → skipped
      { uri: "https://api.calendly.com/scheduled_events/" }, // empty uuid → skipped
      { uri: "https://api.calendly.com/scheduled_events/OTHER" },
      { uri: EVENT_URI }
    ]);
    vi.mocked(nangoProxyForBusiness)
      // OTHER: a canceled matching invitee and a stranger — neither counts.
      .mockResolvedValueOnce(
        inviteesResponse([
          { ...MATCHING_INVITEE, status: "canceled" },
          { email: "someone@else.com", text_reminder_number: "+15550001111" }
        ])
      )
      // EV1: matching invitee without a reschedule_url (null is preserved).
      .mockResolvedValueOnce(
        inviteesResponse([{ email: "joe@acme.com", reschedule_url: "" }])
      );
    const found = await findCalendlyScheduledEvent(BIZ, CONN, {
      phone: PHONE,
      email: "joe@acme.com"
    });
    expect(found).toEqual({
      event: { eventUri: EVENT_URI, eventUuid: "EV1", rescheduleUrl: null }
    });
  });

  it("never matches on empty invitee fields and tolerates missing collections", async () => {
    mockUserAndEvents([{ uri: EVENT_URI }, { uri: "https://api.calendly.com/scheduled_events/EV2" }]);
    vi.mocked(nangoProxyForBusiness)
      // Invitee with NO phone must not match a phone-only caller; body
      // without a collection is an empty scan, not a crash.
      .mockResolvedValueOnce(inviteesResponse([{ email: "joe@acme.com" }]))
      .mockResolvedValueOnce({ data: {} } as never);
    expect(await findCalendlyScheduledEvent(BIZ, CONN, { phone: PHONE })).toBe("not_found");
  });

  it("tolerates an events body without a collection", async () => {
    mockUserAndEvents(undefined);
    expect(await findCalendlyScheduledEvent(BIZ, CONN, { phone: PHONE })).toBe("not_found");
  });
});

describe("cancelCalendlyAppointment", () => {
  it("maps locate outcomes: not_connected and not_found", async () => {
    vi.mocked(nangoProxyForBusiness).mockResolvedValueOnce(null as never);
    expect(await cancelCalendlyAppointment(BIZ, CONN, { phone: PHONE })).toEqual({
      ok: false,
      detail: "calendar_not_connected"
    });

    mockUserAndEvents([]);
    expect(await cancelCalendlyAppointment(BIZ, CONN, { phone: PHONE })).toEqual({
      ok: false,
      detail: "booking_not_found"
    });
  });

  it("POSTs a real cancellation for the located event", async () => {
    mockUserAndEvents([{ uri: EVENT_URI }]);
    vi.mocked(nangoProxyForBusiness)
      .mockResolvedValueOnce(inviteesResponse([MATCHING_INVITEE]))
      .mockResolvedValueOnce({ data: { resource: {} } } as never);

    const result = await cancelCalendlyAppointment(BIZ, CONN, { phone: PHONE });
    expect(result).toEqual({
      ok: true,
      data: { eventId: "EV1", provider: "calendly", canceled: true }
    });
    const cancelCall = vi.mocked(nangoProxyForBusiness).mock.calls[3][2] as {
      endpoint: string;
      method: string;
    };
    expect(cancelCall.endpoint).toBe("/scheduled_events/EV1/cancellation");
    expect(cancelCall.method).toBe("POST");
  });

  it("is not_connected when the cancellation POST is refused", async () => {
    mockUserAndEvents([{ uri: EVENT_URI }]);
    vi.mocked(nangoProxyForBusiness)
      .mockResolvedValueOnce(inviteesResponse([MATCHING_INVITEE]))
      .mockResolvedValueOnce(null as never);
    expect(await cancelCalendlyAppointment(BIZ, CONN, { phone: PHONE })).toEqual({
      ok: false,
      detail: "calendar_not_connected"
    });
  });
});

describe("createCalendlyRescheduleLink", () => {
  it("maps locate outcomes: not_connected and not_found", async () => {
    vi.mocked(nangoProxyForBusiness).mockResolvedValueOnce(null as never);
    expect(await createCalendlyRescheduleLink(BIZ, CONN, { phone: PHONE })).toEqual({
      ok: false,
      detail: "calendar_not_connected"
    });

    mockUserAndEvents([]);
    expect(await createCalendlyRescheduleLink(BIZ, CONN, { phone: PHONE })).toEqual({
      ok: false,
      detail: "booking_not_found"
    });
  });

  it("returns the invitee's reschedule link with the NOT-done detail", async () => {
    mockUserAndEvents([{ uri: EVENT_URI }]);
    vi.mocked(nangoProxyForBusiness).mockResolvedValueOnce(
      inviteesResponse([MATCHING_INVITEE])
    );
    expect(await createCalendlyRescheduleLink(BIZ, CONN, { phone: PHONE })).toEqual({
      ok: true,
      detail: "reschedule_link_created",
      data: {
        eventId: "EV1",
        provider: "calendly",
        rescheduleLink: RESCHEDULE_URL,
        rescheduled: false
      }
    });
  });

  it("fails (not fabricates) when the matched invitee has no reschedule_url", async () => {
    mockUserAndEvents([{ uri: EVENT_URI }]);
    vi.mocked(nangoProxyForBusiness).mockResolvedValueOnce(
      inviteesResponse([{ ...MATCHING_INVITEE, reschedule_url: undefined }])
    );
    expect(await createCalendlyRescheduleLink(BIZ, CONN, { phone: PHONE })).toEqual({
      ok: false,
      detail: "calendar_reschedule_failed"
    });
  });
});

describe("direct PAT transport", () => {
  const DIRECT_ROW = {
    id: "calendly-row-1",
    business_id: BIZ,
    accessToken: "pat-secret",
    is_active: true
  } as never;

  it("routes every call through calendlyDirectRequest with the stored PAT — never Nango", async () => {
    vi.mocked(getActiveCalendlyConnection).mockResolvedValue(DIRECT_ROW);
    vi.mocked(calendlyDirectRequest)
      .mockResolvedValueOnce(usersMeResponse())
      .mockResolvedValueOnce(eventTypesResponse([THIRTY_MIN]))
      .mockResolvedValueOnce({
        data: { resource: { booking_url: "https://calendly.com/d/direct" } }
      } as never);
    const result = await createCalendlyBookingLink(BIZ, DIRECT_CONN, {
      startIso: "2026-06-12T17:00:00.000Z",
      endIso: "2026-06-12T17:30:00.000Z"
    });
    expect(result.ok).toBe(true);
    expect((result.data as { bookingLink: string }).bookingLink).toBe(
      "https://calendly.com/d/direct"
    );
    expect(vi.mocked(calendlyDirectRequest)).toHaveBeenCalledTimes(3);
    expect(vi.mocked(calendlyDirectRequest)).toHaveBeenNthCalledWith(1, "pat-secret", {
      endpoint: "/users/me",
      method: "GET"
    });
    expect(vi.mocked(nangoProxyForBusiness)).not.toHaveBeenCalled();
  });

  it("finds slots through the direct transport", async () => {
    vi.mocked(getActiveCalendlyConnection).mockResolvedValue(DIRECT_ROW);
    vi.mocked(calendlyDirectRequest)
      .mockResolvedValueOnce(usersMeResponse())
      .mockResolvedValueOnce(eventTypesResponse([THIRTY_MIN]))
      .mockResolvedValueOnce({
        data: { collection: [{ status: "available", start_time: "2026-06-12T15:00:00.000Z" }] }
      } as never);
    const result = await findCalendlySlots(BIZ, DIRECT_CONN, {
      windowStart: new Date(NOW + 60 * 60_000),
      windowEnd: new Date(NOW + 26 * 60 * 60_000),
      durationMinutes: 30,
      timezone: "UTC"
    });
    expect(result.ok).toBe(true);
    expect((result.data as { slots: unknown[] }).slots).toHaveLength(1);
    expect(vi.mocked(nangoProxyForBusiness)).not.toHaveBeenCalled();
  });

  it("is calendar_not_connected when the direct row is missing or inactive", async () => {
    vi.mocked(getActiveCalendlyConnection).mockResolvedValue(null);
    expect(
      await createCalendlyBookingLink(BIZ, DIRECT_CONN, {
        startIso: "2026-06-12T17:00:00.000Z",
        endIso: "2026-06-12T17:30:00.000Z"
      })
    ).toEqual({ ok: false, detail: "calendar_not_connected" });
    expect(vi.mocked(calendlyDirectRequest)).not.toHaveBeenCalled();
  });
});
