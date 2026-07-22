/**
 * Tests for the Calendly provider cores (src/lib/calendar-tools/calendly.ts):
 * event-type selection, available-times slot mapping (with Calendly's
 * future-start / 7-day window clamps), single-use scheduling-link creation
 * for the booking tool, and the direct-PAT-only transport guard (the Nango
 * proxy transport was removed in the 2026-07 dead-code sweep).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
import { calendlyDirectRequest } from "@/lib/calendly/client";
import { getActiveCalendlyConnection } from "@/lib/db/calendly-connections";

const BIZ = "11111111-1111-4111-8111-111111111111";

/** The direct PAT connection — the only Calendly transport. */
const CONN = {
  provider: "calendly",
  connectionId: "calendly-row-1",
  providerConfigKey: "calendly-direct"
} as never;

/** A legacy Nango-key conn: must map to "not usable" without any API call. */
const LEGACY_NANGO_CONN = {
  provider: "calendly",
  connectionId: "conn-3",
  providerConfigKey: "calendly"
} as never;

const DIRECT_ROW = {
  id: "calendly-row-1",
  business_id: BIZ,
  accessToken: "pat-secret",
  is_active: true
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
  vi.mocked(calendlyDirectRequest)
    .mockResolvedValueOnce(usersMeResponse())
    .mockResolvedValueOnce(eventTypesResponse(collection));
}

/* The direct row is active by default; individual tests override. */

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
  vi.mocked(getActiveCalendlyConnection).mockResolvedValue(DIRECT_ROW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("pickCalendlyEventType", () => {
  it("is not_connected when the /users/me proxy call is refused", async () => {
    vi.mocked(calendlyDirectRequest).mockResolvedValueOnce(null as never);
    expect(await pickCalendlyEventType(BIZ, CONN, 30)).toBe("not_connected");
  });

  it("is not_connected when /users/me has no usable uri", async () => {
    vi.mocked(calendlyDirectRequest).mockResolvedValueOnce(usersMeResponse(""));
    expect(await pickCalendlyEventType(BIZ, CONN, 30)).toBe("not_connected");

    vi.mocked(calendlyDirectRequest).mockResolvedValueOnce({ data: {} } as never);
    expect(await pickCalendlyEventType(BIZ, CONN, 30)).toBe("not_connected");
  });

  it("is not_connected when the /event_types proxy call is refused", async () => {
    vi.mocked(calendlyDirectRequest)
      .mockResolvedValueOnce(usersMeResponse())
      .mockResolvedValueOnce(null as never);
    expect(await pickCalendlyEventType(BIZ, CONN, 30)).toBe("not_connected");
  });

  it("queries event types filtered to the resolved user", async () => {
    mockUserAndEventTypes([THIRTY_MIN]);
    await pickCalendlyEventType(BIZ, CONN, 30);
    expect(vi.mocked(calendlyDirectRequest)).toHaveBeenNthCalledWith(
      2,
      "pat-secret",
      expect.objectContaining({
        endpoint: "/event_types",
        params: expect.objectContaining({ user: USER_URI, active: "true" })
      })
    );
  });

  it("is no_event_types when the collection is missing or empty", async () => {
    mockUserAndEventTypes([]);
    expect(await pickCalendlyEventType(BIZ, CONN, 30)).toBe("no_event_types");

    vi.mocked(calendlyDirectRequest)
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
    vi.mocked(calendlyDirectRequest).mockResolvedValueOnce(null as never);
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
    vi.mocked(calendlyDirectRequest).mockResolvedValueOnce(null as never);
    expect(await findCalendlySlots(BIZ, CONN, WINDOW)).toEqual({
      ok: false,
      detail: "calendar_not_connected"
    });
  });

  it("maps available times to slots with the event type's duration", async () => {
    mockUserAndEventTypes([THIRTY_MIN, SIXTY_MIN]);
    vi.mocked(calendlyDirectRequest).mockResolvedValueOnce({
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
    vi.mocked(calendlyDirectRequest).mockResolvedValueOnce({
      data: { collection: [] }
    } as never);
    await findCalendlySlots(BIZ, CONN, {
      ...WINDOW,
      windowStart: new Date(NOW - 60 * 60_000), // in the past → clamped forward
      windowEnd: new Date(NOW + 30 * 24 * 60 * 60_000) // 30 days → clamped to 7
    });
    const call = vi.mocked(calendlyDirectRequest).mock.calls[2][1] as unknown as {
      params: { start_time: string; end_time: string };
    };
    const start = Date.parse(call.params.start_time);
    const end = Date.parse(call.params.end_time);
    expect(start).toBe(NOW + CALENDLY_MIN_LEAD_MS);
    expect(end).toBe(start + CALENDLY_MAX_WINDOW_MS);
  });

  it("filters unavailable/malformed times, keeps status-less ones, and caps at 3 slots", async () => {
    mockUserAndEventTypes([THIRTY_MIN]);
    vi.mocked(calendlyDirectRequest).mockResolvedValueOnce({
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
    vi.mocked(calendlyDirectRequest).mockResolvedValueOnce({ data: {} } as never);
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
    vi.mocked(calendlyDirectRequest).mockResolvedValueOnce(null as never);
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
    vi.mocked(calendlyDirectRequest).mockResolvedValueOnce({
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
    expect(vi.mocked(calendlyDirectRequest)).toHaveBeenNthCalledWith(3, "pat-secret", {
      endpoint: "/scheduling_links",
      method: "POST",
      data: { max_event_count: 1, owner: THIRTY_MIN.uri, owner_type: "EventType" }
    });
  });

  it("clamps a degenerate window to a 1-minute duration ask", async () => {
    mockUserAndEventTypes([THIRTY_MIN, SIXTY_MIN]);
    vi.mocked(calendlyDirectRequest).mockResolvedValueOnce({
      data: { resource: { booking_url: "https://calendly.com/d/x" } }
    } as never);
    // endIso before startIso → Math.max clamps to 1 minute → 30-min type wins.
    const result = await createCalendlyBookingLink(BIZ, CONN, {
      startIso: "2026-06-12T17:00:00.000Z",
      endIso: "2026-06-12T16:00:00.000Z"
    });
    expect(result.ok).toBe(true);
    const link = vi.mocked(calendlyDirectRequest).mock.calls[2][1] as {
      data: { owner: string };
    };
    expect(link.data.owner).toBe(THIRTY_MIN.uri);
  });

  it("is not connected when the scheduling-link proxy call is refused", async () => {
    mockUserAndEventTypes([THIRTY_MIN]);
    vi.mocked(calendlyDirectRequest).mockResolvedValueOnce(null as never);
    expect(await createCalendlyBookingLink(BIZ, CONN, ARGS)).toEqual({
      ok: false,
      detail: "calendar_not_connected"
    });
  });

  it("fails when Calendly returns no booking_url", async () => {
    mockUserAndEventTypes([THIRTY_MIN]);
    vi.mocked(calendlyDirectRequest).mockResolvedValueOnce({ data: {} } as never);
    expect(await createCalendlyBookingLink(BIZ, CONN, ARGS)).toEqual({
      ok: false,
      detail: "calendar_book_failed"
    });

    mockUserAndEventTypes([THIRTY_MIN]);
    vi.mocked(calendlyDirectRequest).mockResolvedValueOnce({
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
  vi.mocked(calendlyDirectRequest)
    .mockResolvedValueOnce(usersMeResponse())
    .mockResolvedValueOnce(scheduledEventsResponse(collection));
}

describe("findCalendlyScheduledEvent", () => {
  it("is not_found immediately when the caller has no phone or email", async () => {
    expect(await findCalendlyScheduledEvent(BIZ, CONN, {})).toBe("not_found");
    expect(await findCalendlyScheduledEvent(BIZ, CONN, { phone: "  ", email: "" })).toBe(
      "not_found"
    );
    expect(vi.mocked(calendlyDirectRequest)).not.toHaveBeenCalled();
  });

  it("is not_connected when /users/me or the events listing is refused", async () => {
    vi.mocked(calendlyDirectRequest).mockResolvedValueOnce(null as never);
    expect(await findCalendlyScheduledEvent(BIZ, CONN, { phone: PHONE })).toBe("not_connected");

    vi.mocked(calendlyDirectRequest)
      .mockResolvedValueOnce(usersMeResponse())
      .mockResolvedValueOnce(null as never);
    expect(await findCalendlyScheduledEvent(BIZ, CONN, { phone: PHONE })).toBe("not_connected");
  });

  it("is not_connected when an invitee listing is refused mid-scan", async () => {
    mockUserAndEvents([{ uri: EVENT_URI }]);
    vi.mocked(calendlyDirectRequest).mockResolvedValueOnce(null as never);
    expect(await findCalendlyScheduledEvent(BIZ, CONN, { phone: PHONE })).toBe("not_connected");
  });

  it("lists ACTIVE upcoming events for the resolved user, earliest first", async () => {
    mockUserAndEvents([]);
    await findCalendlyScheduledEvent(BIZ, CONN, { phone: PHONE });
    const listCall = vi.mocked(calendlyDirectRequest).mock.calls[1][1] as {
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
    vi.mocked(calendlyDirectRequest).mockResolvedValueOnce(
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
    vi.mocked(calendlyDirectRequest).mockResolvedValueOnce(
      inviteesResponse([{ ...MATCHING_INVITEE, text_reminder_number: "(548) 577-3546" }])
    );
    expect(await findCalendlyScheduledEvent(BIZ, CONN, { phone: PHONE })).not.toBe("not_found");

    // The reverse: Calendly stored E.164, the caller passed the national form.
    mockUserAndEvents([{ uri: EVENT_URI }]);
    vi.mocked(calendlyDirectRequest).mockResolvedValueOnce(
      inviteesResponse([MATCHING_INVITEE])
    );
    expect(
      await findCalendlyScheduledEvent(BIZ, CONN, { phone: "548-577-3546" })
    ).not.toBe("not_found");

    // A DIFFERENT number sharing no suffix must not match.
    mockUserAndEvents([{ uri: EVENT_URI }]);
    vi.mocked(calendlyDirectRequest).mockResolvedValueOnce(
      inviteesResponse([{ ...MATCHING_INVITEE, text_reminder_number: "+15550001111" }])
    );
    expect(await findCalendlyScheduledEvent(BIZ, CONN, { phone: PHONE })).toBe("not_found");

    // Short strings (below 7 digits) only match on EXACT equality — a bare
    // suffix of a real number is too ambiguous to act on.
    mockUserAndEvents([{ uri: EVENT_URI }]);
    vi.mocked(calendlyDirectRequest).mockResolvedValueOnce(
      inviteesResponse([{ ...MATCHING_INVITEE, text_reminder_number: "773546" }])
    );
    expect(await findCalendlyScheduledEvent(BIZ, CONN, { phone: PHONE })).toBe("not_found");

    mockUserAndEvents([{ uri: EVENT_URI }]);
    vi.mocked(calendlyDirectRequest).mockResolvedValueOnce(
      inviteesResponse([{ ...MATCHING_INVITEE, text_reminder_number: "773546" }])
    );
    expect(
      await findCalendlyScheduledEvent(BIZ, CONN, { phone: "77-35-46" })
    ).not.toBe("not_found");
  });

  it("phone match beats an earlier email-only match when both identities are supplied", async () => {
    const EV2_URI = "https://api.calendly.com/scheduled_events/EV2";
    mockUserAndEvents([{ uri: EVENT_URI }, { uri: EV2_URI }]);
    vi.mocked(calendlyDirectRequest)
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
    vi.mocked(calendlyDirectRequest)
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
    vi.mocked(calendlyDirectRequest).mockResolvedValueOnce(
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
    vi.mocked(calendlyDirectRequest)
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
    vi.mocked(calendlyDirectRequest)
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
    vi.mocked(calendlyDirectRequest).mockResolvedValueOnce(null as never);
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
    vi.mocked(calendlyDirectRequest)
      .mockResolvedValueOnce(inviteesResponse([MATCHING_INVITEE]))
      .mockResolvedValueOnce({ data: { resource: {} } } as never);

    const result = await cancelCalendlyAppointment(BIZ, CONN, { phone: PHONE });
    expect(result).toEqual({
      ok: true,
      data: { eventId: "EV1", provider: "calendly", canceled: true }
    });
    const cancelCall = vi.mocked(calendlyDirectRequest).mock.calls[3][1] as {
      endpoint: string;
      method: string;
    };
    expect(cancelCall.endpoint).toBe("/scheduled_events/EV1/cancellation");
    expect(cancelCall.method).toBe("POST");
  });

  it("a refused cancellation POST is a FAILED MUTATION, never calendar_not_connected", async () => {
    // The locate steps just succeeded — misreporting a missing calendar
    // would steer the model to "you cannot cancel any appointment".
    mockUserAndEvents([{ uri: EVENT_URI }]);
    vi.mocked(calendlyDirectRequest)
      .mockResolvedValueOnce(inviteesResponse([MATCHING_INVITEE]))
      .mockResolvedValueOnce(null as never);
    expect(await cancelCalendlyAppointment(BIZ, CONN, { phone: PHONE })).toEqual({
      ok: false,
      detail: "calendar_cancel_failed"
    });
  });
});

describe("createCalendlyRescheduleLink", () => {
  it("maps locate outcomes: not_connected and not_found", async () => {
    vi.mocked(calendlyDirectRequest).mockResolvedValueOnce(null as never);
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
    vi.mocked(calendlyDirectRequest).mockResolvedValueOnce(
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
    vi.mocked(calendlyDirectRequest).mockResolvedValueOnce(
      inviteesResponse([{ ...MATCHING_INVITEE, reschedule_url: undefined }])
    );
    expect(await createCalendlyRescheduleLink(BIZ, CONN, { phone: PHONE })).toEqual({
      ok: false,
      detail: "calendar_reschedule_failed"
    });
  });
});
describe("direct-PAT-only transport guard", () => {
  it("passes the stored PAT to every direct call", async () => {
    mockUserAndEventTypes([THIRTY_MIN]);
    vi.mocked(calendlyDirectRequest).mockResolvedValueOnce({
      data: { resource: { booking_url: "https://calendly.com/d/direct" } }
    } as never);
    const result = await createCalendlyBookingLink(BIZ, CONN, {
      startIso: "2026-06-12T17:00:00.000Z",
      endIso: "2026-06-12T17:30:00.000Z"
    });
    expect(result.ok).toBe(true);
    expect(vi.mocked(calendlyDirectRequest)).toHaveBeenNthCalledWith(1, "pat-secret", {
      endpoint: "/users/me",
      method: "GET"
    });
  });

  it("is calendar_not_connected when the direct row is missing or inactive", async () => {
    vi.mocked(getActiveCalendlyConnection).mockResolvedValue(null);
    expect(
      await createCalendlyBookingLink(BIZ, CONN, {
        startIso: "2026-06-12T17:00:00.000Z",
        endIso: "2026-06-12T17:30:00.000Z"
      })
    ).toEqual({ ok: false, detail: "calendar_not_connected" });
    expect(vi.mocked(calendlyDirectRequest)).not.toHaveBeenCalled();
  });

  it("maps a legacy Nango-key conn to not-connected without touching the API or the PAT row", async () => {
    expect(
      await createCalendlyBookingLink(BIZ, LEGACY_NANGO_CONN, {
        startIso: "2026-06-12T17:00:00.000Z",
        endIso: "2026-06-12T17:30:00.000Z"
      })
    ).toEqual({ ok: false, detail: "calendar_not_connected" });
    expect(vi.mocked(calendlyDirectRequest)).not.toHaveBeenCalled();
    expect(vi.mocked(getActiveCalendlyConnection)).not.toHaveBeenCalled();
  });
});
