import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({ createSupabaseServiceClient: vi.fn() }));
vi.mock("@/lib/nango/workspace", () => ({ nangoProxyForBusiness: vi.fn() }));
vi.mock("@/lib/voice-tools/connections", () => ({ resolveCalendarConnection: vi.fn() }));
vi.mock("@/lib/calendar-tools/shared-calendar", () => ({ getSharedCalendar: vi.fn() }));
vi.mock("@/lib/ai-flows/db", () => ({ enqueueAiFlowRun: vi.fn() }));
vi.mock("@/lib/db/system-logs", () => ({ recordSystemLog: vi.fn() }));

import {
  CALENDAR_CREATED_LOOKBACK_MINUTES,
  CALENDAR_END_LOOKBACK_MINUTES,
  CALENDAR_POLL_MAX_EVENTS,
  CALENDAR_START_HORIZON_BUFFER_MINUTES,
  calendarDedupeKey,
  eventCreatedDue,
  eventEndDue,
  eventStartDue,
  graphTimeIso,
  normalizeGoogleEvent,
  normalizeGraphEvent,
  pollCalendarTriggers
} from "@/lib/ai-flows/calendar-poll";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { nangoProxyForBusiness } from "@/lib/nango/workspace";
import { resolveCalendarConnection } from "@/lib/voice-tools/connections";
import { getSharedCalendar } from "@/lib/calendar-tools/shared-calendar";
import { enqueueAiFlowRun } from "@/lib/ai-flows/db";
import { recordSystemLog } from "@/lib/db/system-logs";

const BIZ = "11111111-1111-4111-8111-111111111111";

const googleConn = {
  provider: "google" as const,
  providerConfigKey: "google-calendar",
  connectionId: "nango-conn-1"
};
const microsoftConn = {
  provider: "microsoft" as const,
  providerConfigKey: "outlook-calendar",
  connectionId: "nango-conn-2"
};

function flowRow(id: string, trigger: unknown, businessId = BIZ, triggers?: unknown[]) {
  return {
    id,
    business_id: businessId,
    definition: { version: 1, trigger, ...(triggers ? { triggers } : {}), steps: [] }
  };
}

const createdTrigger = (overrides: Record<string, unknown> = {}) => ({
  channel: "calendar",
  on: "event_created",
  conditions: [],
  ...overrides
});

const startTrigger = (leadMinutes: number, overrides: Record<string, unknown> = {}) => ({
  channel: "calendar",
  on: "event_start",
  leadMinutes,
  conditions: [],
  ...overrides
});

const endTrigger = (followMinutes?: number, overrides: Record<string, unknown> = {}) => ({
  channel: "calendar",
  on: "event_end",
  ...(followMinutes !== undefined ? { followMinutes } : {}),
  conditions: [],
  ...overrides
});

/** Chainable service-client stub serving the (paged) ai_flows listing. */
function dbWithRange(range: ReturnType<typeof vi.fn>) {
  const order = vi.fn(() => ({ range }));
  // Listing chain: .select().eq(enabled).or(primary-calendar-or-has-extras).order().range()
  const or = vi.fn(() => ({ order }));
  const eq1 = vi.fn(() => ({ or }));
  const flowsSelect = vi.fn(() => ({ eq: eq1 }));
  return { from: vi.fn(() => ({ select: flowsSelect })) } as never;
}

/** Single-page convenience stub (fewer rows than one page ends the loop). */
function dbWith(rows: unknown[] | null, error: { message: string } | null = null) {
  return dbWithRange(vi.fn().mockResolvedValue({ data: rows, error }));
}

/** ISO string `minutes` from now (negative = in the past). */
function isoIn(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

describe("eventStartDue", () => {
  it("is due from leadMinutes before the start until the event begins", () => {
    const now = Date.parse("2026-07-08T12:00:00Z");
    const at = (iso: string) => ({ startIso: iso });
    expect(eventStartDue(at("2026-07-08T12:20:00Z"), 30, now)).toBe(true);
    expect(eventStartDue(at("2026-07-08T12:30:00Z"), 30, now)).toBe(true);
    // Too far out, already started, exactly-now: all not due.
    expect(eventStartDue(at("2026-07-08T12:45:00Z"), 30, now)).toBe(false);
    expect(eventStartDue(at("2026-07-08T11:55:00Z"), 30, now)).toBe(false);
    expect(eventStartDue(at("2026-07-08T12:00:00Z"), 30, now)).toBe(false);
  });
  it("is never due without a parseable start", () => {
    expect(eventStartDue({ startIso: undefined }, 30, Date.now())).toBe(false);
    expect(eventStartDue({ startIso: "not-a-date" }, 30, Date.now())).toBe(false);
  });
  it("skips all-day events (their start is a date, not a moment)", () => {
    const now = Date.parse("2026-07-08T12:00:00Z");
    expect(
      eventStartDue({ startIso: "2026-07-08T12:20:00Z", allDay: true }, 30, now)
    ).toBe(false);
  });
});

describe("eventEndDue", () => {
  const now = Date.parse("2026-07-08T12:00:00Z");
  it("is due from end + followMinutes for the bounded lookback window", () => {
    const endedAt = (iso: string) => ({ endIso: iso });
    // Ended 60 min ago with a 60-min follow → due exactly now.
    expect(eventEndDue(endedAt("2026-07-08T11:00:00Z"), 60, now)).toBe(true);
    // Ended 5 min ago, no follow → due (still inside the lookback).
    expect(eventEndDue(endedAt("2026-07-08T11:55:00Z"), 0, now)).toBe(true);
    // Not yet: the follow delay hasn't elapsed.
    expect(eventEndDue(endedAt("2026-07-08T11:55:00Z"), 30, now)).toBe(false);
    // Still in progress: the event hasn't even ended.
    expect(eventEndDue(endedAt("2026-07-08T12:30:00Z"), 0, now)).toBe(false);
    // Too old: past the lookback window (no replay of ancient appointments).
    expect(
      eventEndDue(
        endedAt(new Date(now - (CALENDAR_END_LOOKBACK_MINUTES + 1) * 60_000).toISOString()),
        0,
        now
      )
    ).toBe(false);
  });
  it("is never due without a parseable end", () => {
    expect(eventEndDue({ endIso: undefined }, 0, now)).toBe(false);
    expect(eventEndDue({ endIso: "not-a-date" }, 0, now)).toBe(false);
  });
  it("skips all-day events (their end is a date, not a moment)", () => {
    expect(eventEndDue({ endIso: "2026-07-08T11:55:00Z", allDay: true }, 0, now)).toBe(false);
  });
});

describe("eventCreatedDue", () => {
  it("fires only inside the created lookback window", () => {
    const now = Date.now();
    expect(eventCreatedDue({ createdIso: new Date(now - 60_000).toISOString() }, now)).toBe(true);
    expect(
      eventCreatedDue(
        {
          createdIso: new Date(
            now - (CALENDAR_CREATED_LOOKBACK_MINUTES + 1) * 60_000
          ).toISOString()
        },
        now
      )
    ).toBe(false);
  });
  it("is never due without a parseable created timestamp", () => {
    expect(eventCreatedDue({ createdIso: undefined }, Date.now())).toBe(false);
    expect(eventCreatedDue({ createdIso: "garbage" }, Date.now())).toBe(false);
  });
});

describe("calendarDedupeKey", () => {
  it("keys created mode per event and start mode per occurrence", () => {
    expect(calendarDedupeKey("event_created", { id: "e1" })).toBe("cal:e1");
    expect(
      calendarDedupeKey("event_start", { id: "e1", startIso: "2026-07-08T12:20:00Z" })
    ).toBe("cal:e1:2026-07-08T12:20:00Z");
    expect(calendarDedupeKey("event_start", { id: "e1" })).toBe("cal:e1:");
  });
  it("keys end mode per occurrence, distinct from a start firing", () => {
    expect(
      calendarDedupeKey("event_end", { id: "e1", endIso: "2026-07-08T13:00:00Z" })
    ).toBe("cal:e1:end:2026-07-08T13:00:00Z");
    expect(calendarDedupeKey("event_end", { id: "e1" })).toBe("cal:e1:end:");
  });
});

describe("normalizeGoogleEvent", () => {
  it("maps fields, all-day dates, and attendee display forms", () => {
    const ev = normalizeGoogleEvent(
      {
        id: "g1",
        summary: "Roof estimate",
        description: "Bring ladder",
        location: "12 Main St",
        created: "2026-07-08T10:00:00Z",
        organizer: { email: "owner@biz.com" },
        attendees: [
          { displayName: "Jane", email: "jane@x.com" },
          { email: "bare@x.com" },
          { displayName: "no-email-dropped" }
        ],
        start: { date: "2026-07-09" },
        end: { dateTime: "2026-07-09T15:00:00Z" }
      },
      "primary"
    );
    expect(ev).toEqual({
      id: "g1",
      allDay: true,
      title: "Roof estimate",
      description: "Bring ladder",
      location: "12 Main St",
      organizerEmail: "owner@biz.com",
      attendees: ["Jane <jane@x.com>", "bare@x.com"],
      startIso: "2026-07-09T00:00:00Z",
      endIso: "2026-07-09T15:00:00Z",
      createdIso: "2026-07-08T10:00:00Z",
      calendar: "primary"
    });
  });
  it("drops cancelled and id-less events, defaults missing fields", () => {
    expect(normalizeGoogleEvent({ id: "g1", status: "cancelled" }, "primary")).toBeNull();
    expect(normalizeGoogleEvent({}, "primary")).toBeNull();
    const bare = normalizeGoogleEvent({ id: "g2" }, "shared");
    expect(bare).toMatchObject({ id: "g2", title: "", attendees: [], calendar: "shared" });
    expect(bare?.startIso).toBeUndefined();
  });
});

describe("graphTimeIso", () => {
  it("appends Z for UTC (explicit or defaulted), keeps suffixed values, degrades non-UTC", () => {
    expect(graphTimeIso(undefined)).toBeUndefined();
    expect(graphTimeIso({ dateTime: "2026-07-08T12:00:00.0000000", timeZone: "UTC" })).toBe(
      "2026-07-08T12:00:00.0000000Z"
    );
    expect(graphTimeIso({ dateTime: "2026-07-08T12:00:00" })).toBe("2026-07-08T12:00:00Z");
    expect(graphTimeIso({ dateTime: "2026-07-08T12:00:00Z" })).toBe("2026-07-08T12:00:00Z");
    expect(graphTimeIso({ dateTime: "2026-07-08T12:00:00+02:00" })).toBe(
      "2026-07-08T12:00:00+02:00"
    );
    expect(
      graphTimeIso({ dateTime: "2026-07-08T12:00:00", timeZone: "Pacific Standard Time" })
    ).toBe("2026-07-08T12:00:00");
  });
});

describe("normalizeGraphEvent", () => {
  it("maps fields and attendee display forms", () => {
    const ev = normalizeGraphEvent(
      {
        id: "m1",
        subject: "Estimate",
        bodyPreview: "notes",
        location: { displayName: "Office" },
        createdDateTime: "2026-07-08T10:00:00Z",
        organizer: { emailAddress: { address: "owner@biz.com" } },
        attendees: [
          { emailAddress: { name: "Jane", address: "jane@x.com" } },
          { emailAddress: { address: "bare@x.com" } },
          { emailAddress: {} }
        ],
        start: { dateTime: "2026-07-08T12:00:00", timeZone: "UTC" },
        end: { dateTime: "2026-07-08T13:00:00", timeZone: "UTC" }
      },
      "shared"
    );
    expect(ev).toMatchObject({
      id: "m1",
      title: "Estimate",
      description: "notes",
      location: "Office",
      organizerEmail: "owner@biz.com",
      attendees: ["Jane <jane@x.com>", "bare@x.com"],
      startIso: "2026-07-08T12:00:00Z",
      calendar: "shared"
    });
  });
  it("drops cancelled and id-less events, defaults a missing subject", () => {
    expect(normalizeGraphEvent({ id: "m1", isCancelled: true }, "primary")).toBeNull();
    expect(normalizeGraphEvent({}, "primary")).toBeNull();
    expect(normalizeGraphEvent({ id: "m3" }, "primary")).toMatchObject({ id: "m3", title: "" });
  });
  it("marks Outlook all-day events", () => {
    expect(normalizeGraphEvent({ id: "m4", isAllDay: true }, "primary")).toMatchObject({
      allDay: true
    });
    expect(normalizeGraphEvent({ id: "m5" }, "primary")).toMatchObject({ allDay: false });
  });
});

describe("pollCalendarTriggers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resolveCalendarConnection).mockResolvedValue(googleConn);
    vi.mocked(getSharedCalendar).mockResolvedValue(null);
    vi.mocked(enqueueAiFlowRun).mockResolvedValue({ id: "run-1" } as never);
  });

  it("throws on a flows query error", async () => {
    await expect(pollCalendarTriggers(dbWith([], { message: "boom" }))).rejects.toThrow(
      "pollCalendarTriggers: boom"
    );
  });

  it("returns immediately when no enabled calendar-trigger flows exist", async () => {
    const res = await pollCalendarTriggers(dbWith([]));
    expect(res).toEqual({ flows: 0, businesses: 0, events: 0, enqueued: 0 });
    expect(resolveCalendarConnection).not.toHaveBeenCalled();
  });

  it("tolerates a null data payload from the flows query", async () => {
    const res = await pollCalendarTriggers(dbWith(null));
    expect(res.flows).toBe(0);
  });

  it("pages through the flow listing so flows past one page are not skipped", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => flowRow(`f${i}`, createdTrigger()));
    const page2 = [flowRow("f-last", createdTrigger())];
    const range = vi
      .fn()
      .mockResolvedValueOnce({ data: page1, error: null })
      .mockResolvedValueOnce({ data: page2, error: null });
    vi.mocked(nangoProxyForBusiness).mockResolvedValue({ data: {} } as never);
    const res = await pollCalendarTriggers(dbWithRange(range));
    expect(res.flows).toBe(101);
    expect(range).toHaveBeenCalledTimes(2);
    expect(range).toHaveBeenNthCalledWith(2, 100, 199);
  });

  it("keeps flows already listed when a LATER page fails", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const page1 = Array.from({ length: 100 }, (_, i) => flowRow(`f${i}`, createdTrigger()));
    const range = vi
      .fn()
      .mockResolvedValueOnce({ data: page1, error: null })
      .mockResolvedValueOnce({ data: null, error: { message: "later page" } });
    vi.mocked(nangoProxyForBusiness).mockResolvedValue({ data: {} } as never);
    const res = await pollCalendarTriggers(dbWithRange(range));
    expect(res.flows).toBe(100);
    expect(errSpy).toHaveBeenCalledWith("pollCalendarTriggers flow listing page", "later page");
    errSpy.mockRestore();
  });

  it("lazily creates a service client when none is supplied", async () => {
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(dbWith([]) as never);
    await pollCalendarTriggers();
    expect(createSupabaseServiceClient).toHaveBeenCalled();
  });

  it("skips rows whose stored trigger is not a usable calendar trigger", async () => {
    const res = await pollCalendarTriggers(
      dbWith([
        flowRow("f-sms", { channel: "sms", conditions: [] }),
        flowRow("f-bad-on", { channel: "calendar", on: "event_deleted", conditions: [] }),
        flowRow("f-no-lead", { channel: "calendar", on: "event_start", conditions: [] })
      ])
    );
    expect(res.flows).toBe(0);
  });

  it("logs and isolates a business with no calendar connection", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValueOnce(null);
    const res = await pollCalendarTriggers(dbWith([flowRow("f1", createdTrigger())]));
    expect(res).toEqual({ flows: 1, businesses: 1, events: 0, enqueued: 0 });
    expect(recordSystemLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "ai_flow_calendar_poll_failed",
        message: expect.stringContaining("calendar_not_connected")
      })
    );
  });

  it("stringifies a non-Error failure", async () => {
    vi.mocked(resolveCalendarConnection).mockRejectedValueOnce("weird failure");
    await pollCalendarTriggers(dbWith([flowRow("f1", createdTrigger())]));
    expect(recordSystemLog).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("weird failure") })
    );
  });

  it("enqueues a run for a newly created Google event and evaluates conditions per flow", async () => {
    vi.mocked(nangoProxyForBusiness).mockResolvedValueOnce({
      data: {
        items: [
          {
            id: "ev1",
            summary: "Roof estimate",
            description: "See https://leads.example/1",
            created: isoIn(-2),
            organizer: { email: "leads@rx.com" },
            start: { dateTime: isoIn(60) }
          },
          { id: "ev-old", summary: "Old", created: isoIn(-60) },
          { id: "ev-cancelled", status: "cancelled" }
        ]
      }
    } as never);
    const res = await pollCalendarTriggers(
      dbWith([
        // conditions omitted entirely → default [] (matches every event)
        flowRow("f-match", { channel: "calendar", on: "event_created" }),
        flowRow("f-miss", createdTrigger({ conditions: [{ type: "contains", value: "nope" }] }))
      ])
    );
    expect(res).toEqual({ flows: 2, businesses: 1, events: 2, enqueued: 1 });
    // One Google list call for the primary calendar (shared doesn't exist).
    expect(nangoProxyForBusiness).toHaveBeenCalledTimes(1);
    const endpoint = vi.mocked(nangoProxyForBusiness).mock.calls[0][2].endpoint as string;
    expect(endpoint).toContain("/calendar/v3/calendars/primary/events?updatedMin=");
    expect(enqueueAiFlowRun).toHaveBeenCalledTimes(1);
    expect(enqueueAiFlowRun).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: BIZ,
        flowId: "f-match",
        dedupeKey: "cal:ev1",
        trigger: expect.objectContaining({
          channel: "calendar",
          from: "leads@rx.com",
          event_title: "Roof estimate",
          calendar: "primary",
          url: "https://leads.example/1"
        })
      }),
      expect.anything()
    );
    expect(recordSystemLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "ai_flow_run_enqueued_calendar",
        message: expect.stringContaining("New calendar event")
      })
    );
  });

  it("fires flows whose calendar trigger lives in the EXTRA triggers array (multi-trigger OR)", async () => {
    vi.mocked(nangoProxyForBusiness).mockResolvedValueOnce({
      data: {
        items: [
          {
            id: "ev1",
            summary: "Roof estimate",
            created: isoIn(-2),
            organizer: { email: "leads@rx.com" },
            start: { dateTime: isoIn(60) }
          }
        ]
      }
    } as never);
    const res = await pollCalendarTriggers(
      dbWith([
        // Primary is manual; the calendar trigger is one of the extras.
        flowRow("f-multi", { channel: "manual" }, BIZ, [
          { channel: "calendar", on: "event_created" }
        ]),
        // Extras with no calendar trigger anywhere → not a calendar flow.
        flowRow("f-no-cal", { channel: "manual" }, BIZ, [{ channel: "webhook", conditions: [] }])
      ])
    );
    expect(res).toEqual({ flows: 1, businesses: 1, events: 1, enqueued: 1 });
    expect(enqueueAiFlowRun).toHaveBeenCalledTimes(1);
    expect(enqueueAiFlowRun).toHaveBeenCalledWith(
      expect.objectContaining({ flowId: "f-multi", dedupeKey: "cal:ev1" }),
      expect.anything()
    );
  });

  it("enqueues a run leadMinutes before a Google event starts, keyed per occurrence", async () => {
    const startIso = isoIn(10);
    vi.mocked(nangoProxyForBusiness).mockResolvedValueOnce({
      data: {
        items: [
          { id: "soon", summary: "Estimate", start: { dateTime: startIso } },
          { id: "later", summary: "Estimate", start: { dateTime: isoIn(45) } },
          { id: "started", summary: "Estimate", start: { dateTime: isoIn(-5) } },
          { id: "no-start", summary: "Estimate" }
        ]
      }
    } as never);
    const res = await pollCalendarTriggers(dbWith([flowRow("f1", startTrigger(30))]));
    expect(res.enqueued).toBe(1);
    const endpoint = vi.mocked(nangoProxyForBusiness).mock.calls[0][2].endpoint as string;
    expect(endpoint).toContain("singleEvents=true");
    expect(enqueueAiFlowRun).toHaveBeenCalledWith(
      expect.objectContaining({
        flowId: "f1",
        dedupeKey: `cal:soon:${startIso}`,
        trigger: expect.objectContaining({ starts_at: startIso })
      }),
      expect.anything()
    );
    expect(recordSystemLog).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("Upcoming calendar event") })
    );
  });

  it("enqueues a run after a Google event ends, keyed per occurrence by end time", async () => {
    const endIso = isoIn(-70); // ended 70 min ago
    vi.mocked(nangoProxyForBusiness).mockResolvedValueOnce({
      data: {
        items: [
          {
            id: "done-appt",
            summary: "Policy review",
            start: { dateTime: isoIn(-130) },
            end: { dateTime: endIso }
          },
          // Ended too recently for the 70-min follow → not yet due.
          { id: "just-ended", summary: "Recent", end: { dateTime: isoIn(-2) } },
          // Still in progress → not due.
          { id: "ongoing", summary: "Live", end: { dateTime: isoIn(30) } }
        ]
      }
    } as never);
    const res = await pollCalendarTriggers(dbWith([flowRow("f-end", endTrigger(70))]));
    expect(res.enqueued).toBe(1);
    expect(enqueueAiFlowRun).toHaveBeenCalledWith(
      expect.objectContaining({
        flowId: "f-end",
        dedupeKey: `cal:done-appt:end:${endIso}`,
        trigger: expect.objectContaining({ ends_at: endIso })
      }),
      expect.anything()
    );
    expect(recordSystemLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "ai_flow_run_enqueued_calendar",
        message: expect.stringContaining("Completed calendar event")
      })
    );
  });

  it("sizes the recently-ended fetch window to the largest follow + lookback", async () => {
    vi.mocked(nangoProxyForBusiness).mockResolvedValueOnce({ data: { items: [] } } as never);
    const before = Date.now();
    await pollCalendarTriggers(dbWith([flowRow("f-end", endTrigger(120))]));
    const endpoint = vi.mocked(nangoProxyForBusiness).mock.calls[0][2].endpoint as string;
    const timeMin = decodeURIComponent(/timeMin=([^&]+)/.exec(endpoint)![1]);
    const timeMax = decodeURIComponent(/timeMax=([^&]+)/.exec(endpoint)![1]);
    const backMinutes = (before - Date.parse(timeMin)) / 60_000;
    expect(backMinutes).toBeGreaterThanOrEqual(120 + CALENDAR_END_LOOKBACK_MINUTES - 0.1);
    expect(backMinutes).toBeLessThan(120 + CALENDAR_END_LOOKBACK_MINUTES + 1);
    // Upper bound is now — future events are irrelevant to end mode.
    expect(Math.abs(Date.parse(timeMax) - before)).toBeLessThan(60_000);
  });

  it("defaults a missing followMinutes to zero (fires right at the end)", async () => {
    const endIso = isoIn(-1);
    vi.mocked(nangoProxyForBusiness).mockResolvedValueOnce({
      data: { items: [{ id: "fresh", summary: "Walkthrough", end: { dateTime: endIso } }] }
    } as never);
    const res = await pollCalendarTriggers(dbWith([flowRow("f-end", endTrigger())]));
    expect(res.enqueued).toBe(1);
    expect(enqueueAiFlowRun).toHaveBeenCalledWith(
      expect.objectContaining({ dedupeKey: `cal:fresh:end:${endIso}` }),
      expect.anything()
    );
  });

  it("widens the upcoming fetch window past the lead (exclusive provider bounds)", async () => {
    vi.mocked(nangoProxyForBusiness).mockResolvedValueOnce({ data: { items: [] } } as never);
    const before = Date.now();
    await pollCalendarTriggers(dbWith([flowRow("f1", startTrigger(30))]));
    const endpoint = vi.mocked(nangoProxyForBusiness).mock.calls[0][2].endpoint as string;
    const timeMax = decodeURIComponent(/timeMax=([^&]+)/.exec(endpoint)![1]);
    const horizonMinutes = (Date.parse(timeMax) - before) / 60_000;
    // 30-min lead + the exclusive-bound buffer, so an event starting exactly
    // at now + lead (first tick it is due) is still listed.
    expect(horizonMinutes).toBeGreaterThanOrEqual(
      30 + CALENDAR_START_HORIZON_BUFFER_MINUTES - 0.1
    );
    expect(horizonMinutes).toBeLessThan(30 + CALENDAR_START_HORIZON_BUFFER_MINUTES + 1);
  });

  it("skips all-day events in start mode but still fires them in created mode", async () => {
    vi.mocked(nangoProxyForBusiness).mockImplementation((async () => ({
      data: {
        items: [
          {
            id: "allday",
            summary: "Fair",
            created: isoIn(-1),
            start: { date: new Date(Date.now() + 5 * 60_000).toISOString().slice(0, 10) }
          }
        ]
      }
    })) as never);
    const res = await pollCalendarTriggers(
      dbWith([flowRow("f-start", startTrigger(1440)), flowRow("f-created", createdTrigger())])
    );
    expect(res.enqueued).toBe(1);
    expect(enqueueAiFlowRun).toHaveBeenCalledWith(
      expect.objectContaining({ flowId: "f-created" }),
      expect.anything()
    );
  });

  it("keeps primary events when the shared calendar's fetch fails", async () => {
    vi.mocked(getSharedCalendar).mockResolvedValue({
      calendarId: "shared-cal-x",
      conn: googleConn
    } as never);
    vi.mocked(nangoProxyForBusiness).mockImplementation((async (
      _biz: string,
      _link: unknown,
      cfg: { endpoint: string }
    ) => {
      if (cfg.endpoint.includes("shared-cal-x")) return null; // dead shared link
      return { data: { items: [{ id: "p-ev", summary: "Mine", created: isoIn(-1) }] } };
    }) as never);
    const res = await pollCalendarTriggers(dbWith([flowRow("f1", createdTrigger())]));
    // The primary event still enqueues; the shared failure is logged per-calendar.
    expect(res.enqueued).toBe(1);
    expect(enqueueAiFlowRun).toHaveBeenCalledWith(
      expect.objectContaining({ trigger: expect.objectContaining({ calendar: "primary" }) }),
      expect.anything()
    );
    expect(recordSystemLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "ai_flow_calendar_poll_failed",
        message: expect.stringContaining("shared calendar"),
        payload: { calendar: "shared" }
      })
    );
  });

  it("stringifies a non-Error per-calendar fetch failure", async () => {
    vi.mocked(nangoProxyForBusiness).mockRejectedValueOnce("proxy blew up");
    await pollCalendarTriggers(dbWith([flowRow("f1", createdTrigger())]));
    expect(recordSystemLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "ai_flow_calendar_poll_failed",
        message: expect.stringContaining("proxy blew up")
      })
    );
  });

  it("is a quiet no-op for a shared-only flow when the shared calendar does not exist", async () => {
    const res = await pollCalendarTriggers(
      dbWith([flowRow("f1", createdTrigger({ calendar: "shared" }))])
    );
    expect(res).toEqual({ flows: 1, businesses: 1, events: 0, enqueued: 0 });
    expect(nangoProxyForBusiness).not.toHaveBeenCalled();
    expect(recordSystemLog).not.toHaveBeenCalled();
  });

  it("watches primary and shared with one query each, tagging the event's calendar", async () => {
    vi.mocked(getSharedCalendar).mockResolvedValue({
      calendarId: "shared-cal/1",
      conn: googleConn
    } as never);
    vi.mocked(nangoProxyForBusiness).mockImplementation((async (
      _biz: string,
      _link: unknown,
      cfg: { endpoint: string }
    ) => {
      return cfg.endpoint.includes("shared-cal")
        ? { data: { items: [{ id: "s-ev", summary: "Booked", created: isoIn(-1) }] } }
        : { data: { items: [{ id: "p-ev", summary: "Mine", created: isoIn(-1) }] } };
    }) as never);
    const res = await pollCalendarTriggers(dbWith([flowRow("f1", createdTrigger())]));
    expect(res.events).toBe(2);
    expect(res.enqueued).toBe(2);
    const endpoints = vi
      .mocked(nangoProxyForBusiness)
      .mock.calls.map((c) => (c[2] as { endpoint: string }).endpoint);
    expect(endpoints.some((e) => e.includes("/calendars/primary/"))).toBe(true);
    expect(endpoints.some((e) => e.includes(encodeURIComponent("shared-cal/1")))).toBe(true);
    expect(enqueueAiFlowRun).toHaveBeenCalledWith(
      expect.objectContaining({ trigger: expect.objectContaining({ calendar: "shared" }) }),
      expect.anything()
    );
  });

  it("shares one upcoming query across start flows (largest lead) and dedupes listings", async () => {
    // One created + one start flow on the same calendar: the created listing
    // and the upcoming listing both return ev1 — it must count once.
    const startIso = isoIn(10);
    vi.mocked(nangoProxyForBusiness).mockImplementation((async (
      _biz: string,
      _link: unknown,
      cfg: { endpoint: string }
    ) => {
      return {
        data: {
          items: [{ id: "ev1", summary: "Estimate", created: isoIn(-1), start: { dateTime: startIso } }]
        }
      };
    }) as never);
    const res = await pollCalendarTriggers(
      dbWith([
        flowRow("f-created", createdTrigger()),
        flowRow("f-start-15", startTrigger(15)),
        flowRow("f-start-60", startTrigger(60))
      ])
    );
    expect(res.events).toBe(1);
    // ev1 fires the created flow AND both start flows (due within both leads).
    expect(res.enqueued).toBe(3);
    const endpoints = vi
      .mocked(nangoProxyForBusiness)
      .mock.calls.map((c) => (c[2] as { endpoint: string }).endpoint);
    expect(endpoints).toHaveLength(2);
    expect(endpoints.filter((e) => e.includes("timeMin="))).toHaveLength(1);
  });

  it("treats a dedupe collision (null run) as already-enqueued", async () => {
    vi.mocked(enqueueAiFlowRun).mockResolvedValue(null);
    vi.mocked(nangoProxyForBusiness).mockResolvedValueOnce({
      data: { items: [{ id: "ev1", summary: "x", created: isoIn(-1) }] }
    } as never);
    const res = await pollCalendarTriggers(dbWith([flowRow("f1", createdTrigger())]));
    expect(res.enqueued).toBe(0);
    expect(recordSystemLog).not.toHaveBeenCalled();
  });

  it("fails closed when a from_matches contact ref cannot be resolved", async () => {
    vi.mocked(nangoProxyForBusiness).mockResolvedValueOnce({
      data: {
        items: [
          { id: "ev1", summary: "x", created: isoIn(-1), organizer: { email: "leads@rx.com" } }
        ]
      }
    } as never);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // The db stub has no contacts query support, so resolution throws and the
    // ref condition must fail closed (no run enqueued) without breaking the poll.
    const res = await pollCalendarTriggers(
      dbWith([
        flowRow(
          "f-ref",
          createdTrigger({
            conditions: [
              {
                type: "from_matches",
                ref: { source: "contact", id: "22222222-2222-4222-8222-222222222222" }
              }
            ]
          })
        )
      ])
    );
    expect(res.enqueued).toBe(0);
    expect(enqueueAiFlowRun).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("throws into the per-business error path when the Google link is dead", async () => {
    vi.mocked(nangoProxyForBusiness).mockResolvedValueOnce(null);
    const res = await pollCalendarTriggers(dbWith([flowRow("f1", createdTrigger())]));
    expect(res.enqueued).toBe(0);
    expect(recordSystemLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "ai_flow_calendar_poll_failed",
        message: expect.stringContaining("calendar_not_connected")
      })
    );
  });

  it("logs an overflow warning when a Google listing fills the event cap", async () => {
    vi.mocked(nangoProxyForBusiness).mockResolvedValueOnce({
      data: {
        items: Array.from({ length: CALENDAR_POLL_MAX_EVENTS }, (_, i) => ({
          id: `e${i}`,
          summary: "x",
          created: isoIn(-1)
        }))
      }
    } as never);
    const res = await pollCalendarTriggers(
      dbWith([flowRow("f1", createdTrigger({ conditions: [{ type: "contains", value: "no" }] }))])
    );
    expect(res.events).toBe(CALENDAR_POLL_MAX_EVENTS);
    expect(recordSystemLog).toHaveBeenCalledWith(
      expect.objectContaining({ event: "ai_flow_calendar_poll_overflow", level: "warn" })
    );
  });

  it("tolerates Google responses without items (created and upcoming)", async () => {
    vi.mocked(nangoProxyForBusiness).mockResolvedValue({ data: {} } as never);
    const res = await pollCalendarTriggers(dbWith([flowRow("f1", createdTrigger())]));
    expect(res.events).toBe(0);
    const res2 = await pollCalendarTriggers(dbWith([flowRow("f2", startTrigger(30))]));
    expect(res2.events).toBe(0);
  });

  it("polls Microsoft created events on a shared calendar and tolerates a missing value", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(microsoftConn);
    vi.mocked(getSharedCalendar).mockResolvedValue({
      calendarId: "ms-shared-2",
      conn: microsoftConn
    } as never);
    vi.mocked(nangoProxyForBusiness).mockResolvedValueOnce({ data: {} } as never);
    const res = await pollCalendarTriggers(
      dbWith([flowRow("f1", createdTrigger({ calendar: "shared" }))])
    );
    expect(res.events).toBe(0);
    const endpoint = vi.mocked(nangoProxyForBusiness).mock.calls[0][2].endpoint as string;
    expect(endpoint).toContain("/v1.0/me/calendars/ms-shared-2/events?$filter=");
  });

  it("polls Microsoft created events on the default calendar", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(microsoftConn);
    vi.mocked(nangoProxyForBusiness).mockResolvedValueOnce({
      data: {
        value: [
          {
            id: "m1",
            subject: "Estimate",
            createdDateTime: isoIn(-1),
            organizer: { emailAddress: { address: "leads@rx.com" } },
            start: { dateTime: isoIn(120).replace("Z", ""), timeZone: "UTC" }
          }
        ]
      }
    } as never);
    const res = await pollCalendarTriggers(dbWith([flowRow("f1", createdTrigger())]));
    expect(res.enqueued).toBe(1);
    const cfg = vi.mocked(nangoProxyForBusiness).mock.calls[0][2] as {
      endpoint: string;
      headers?: Record<string, string>;
    };
    expect(cfg.endpoint).toContain("/v1.0/me/calendar/events?$filter=");
    // Graph must convert start/end to UTC or zone-less times misparse.
    expect(cfg.headers).toEqual({ Prefer: 'outlook.timezone="UTC"' });
    expect(enqueueAiFlowRun).toHaveBeenCalledWith(
      expect.objectContaining({
        dedupeKey: "cal:m1",
        trigger: expect.objectContaining({ from: "leads@rx.com" })
      }),
      expect.anything()
    );
  });

  it("polls Microsoft upcoming events on a shared calendar via calendarView", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(microsoftConn);
    vi.mocked(getSharedCalendar).mockResolvedValue({
      calendarId: "ms-shared-1",
      conn: microsoftConn
    } as never);
    const startIso = isoIn(5);
    vi.mocked(nangoProxyForBusiness).mockResolvedValueOnce({
      data: { value: [{ id: "m2", subject: "Booked", start: { dateTime: startIso } }] }
    } as never);
    const res = await pollCalendarTriggers(
      dbWith([flowRow("f1", startTrigger(30, { calendar: "shared" }))])
    );
    expect(res.enqueued).toBe(1);
    const cfg = vi.mocked(nangoProxyForBusiness).mock.calls[0][2] as {
      endpoint: string;
      headers?: Record<string, string>;
    };
    expect(cfg.endpoint).toContain("/v1.0/me/calendars/ms-shared-1/calendarView?");
    // calendarView rejects $select on createdDateTime; the view select must omit it.
    expect(cfg.endpoint).not.toContain("createdDateTime");
    expect(cfg.headers).toEqual({ Prefer: 'outlook.timezone="UTC"' });
    expect(enqueueAiFlowRun).toHaveBeenCalledWith(
      expect.objectContaining({ dedupeKey: `cal:m2:${startIso}` }),
      expect.anything()
    );
  });

  it("polls Microsoft upcoming events on the default calendar and tolerates a missing value", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(microsoftConn);
    vi.mocked(nangoProxyForBusiness).mockResolvedValueOnce({ data: {} } as never);
    const res = await pollCalendarTriggers(dbWith([flowRow("f1", startTrigger(30))]));
    expect(res.events).toBe(0);
    const endpoint = vi.mocked(nangoProxyForBusiness).mock.calls[0][2].endpoint as string;
    expect(endpoint).toContain("/v1.0/me/calendarView?");
  });

  it("hits the per-business error path when a Microsoft listing link is dead", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(microsoftConn);
    vi.mocked(nangoProxyForBusiness)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    // created flow → fetchRecentlyCreated null; then a separate poll for the
    // start flow → fetchUpcoming null. Both must log, not throw.
    await pollCalendarTriggers(dbWith([flowRow("f1", createdTrigger())]));
    await pollCalendarTriggers(dbWith([flowRow("f2", startTrigger(30))]));
    expect(
      vi
        .mocked(recordSystemLog)
        .mock.calls.filter((c) => c[0].event === "ai_flow_calendar_poll_failed")
    ).toHaveLength(2);
  });

  it("logs an overflow warning when a Microsoft shared upcoming listing fills the cap", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(microsoftConn);
    vi.mocked(nangoProxyForBusiness).mockResolvedValueOnce({
      data: {
        value: Array.from({ length: CALENDAR_POLL_MAX_EVENTS }, (_, i) => ({
          id: `m${i}`,
          subject: "x",
          start: { dateTime: isoIn(60).replace("Z", "") }
        }))
      }
    } as never);
    await pollCalendarTriggers(dbWith([flowRow("f1", startTrigger(120))]));
    expect(recordSystemLog).toHaveBeenCalledWith(
      expect.objectContaining({ event: "ai_flow_calendar_poll_overflow" })
    );
  });

  it("polls Google upcoming events with a dead link (throws into error path)", async () => {
    vi.mocked(nangoProxyForBusiness).mockResolvedValueOnce(null);
    await pollCalendarTriggers(dbWith([flowRow("f1", startTrigger(30))]));
    expect(recordSystemLog).toHaveBeenCalledWith(
      expect.objectContaining({ event: "ai_flow_calendar_poll_failed" })
    );
  });

  it("groups multiple businesses independently", async () => {
    const OTHER = "99999999-9999-4999-8999-999999999999";
    vi.mocked(resolveCalendarConnection)
      .mockResolvedValueOnce(googleConn)
      .mockResolvedValueOnce(null);
    vi.mocked(nangoProxyForBusiness).mockResolvedValueOnce({ data: { items: [] } } as never);
    const res = await pollCalendarTriggers(
      dbWith([flowRow("f1", createdTrigger()), flowRow("f2", createdTrigger(), OTHER)])
    );
    expect(res.businesses).toBe(2);
    // The second business's failure is isolated from the first's success.
    expect(recordSystemLog).toHaveBeenCalledWith(
      expect.objectContaining({ businessId: OTHER, event: "ai_flow_calendar_poll_failed" })
    );
  });
});
