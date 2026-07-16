/**
 * Calendly candidate-event fetcher for the AiFlow calendar-trigger poller
 * (src/lib/ai-flows/calendly-poll.ts): normalization, invitee context
 * (timezone/local-time/Q&A), mode windows, dedupe, overflow + enrichment
 * caps, and the not-connected contract.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

import {
  CALENDLY_CANCELED_SCAN_BACK_DAYS,
  CALENDLY_CANCELED_SCAN_FORWARD_DAYS,
  CALENDLY_CREATED_SCAN_DAYS,
  CALENDLY_END_MAX_EVENT_MINUTES,
  CALENDLY_INVITEE_FETCH_CAP,
  CALENDLY_POLL_PAGE_COUNT,
  applyInviteeContext,
  calendlyEventUuid,
  fetchCalendlyCandidateEvents,
  formatInviteeLocalTime,
  normalizeCalendlyEvent
} from "@/lib/ai-flows/calendly-poll";
import type { CalendarEventInput } from "@/lib/ai-flows/trigger-eval";

const BIZ = "11111111-1111-4111-8111-111111111111";
const CONN = {
  provider: "calendly" as const,
  providerConfigKey: "calendly-direct",
  connectionId: "cx-1"
};
const NOW = Date.parse("2026-07-16T12:00:00Z");
const USER_RES = { data: { resource: { uri: "https://api.calendly.com/users/U1" } } };

function rawEvent(uuid: string, overrides: Record<string, unknown> = {}) {
  return {
    uri: `https://api.calendly.com/scheduled_events/${uuid}`,
    name: "KYP Ads Free Strategy",
    status: "active",
    start_time: "2026-07-16T14:00:00Z",
    end_time: "2026-07-16T14:30:00Z",
    created_at: "2026-07-15T00:00:00Z",
    updated_at: "2026-07-15T00:00:00Z",
    ...overrides
  };
}

describe("calendlyEventUuid / normalizeCalendlyEvent", () => {
  it("extracts the bare uuid and normalizes to the poller shape", () => {
    expect(calendlyEventUuid("https://api.calendly.com/scheduled_events/EV1")).toBe("EV1");
    expect(calendlyEventUuid("EV2")).toBe("EV2");

    const ev = normalizeCalendlyEvent(rawEvent("EV1", { location: { join_url: "https://zoom.us/j/1" } }));
    expect(ev).toMatchObject({
      id: "EV1",
      title: "KYP Ads Free Strategy",
      location: "https://zoom.us/j/1",
      startIso: "2026-07-16T14:00:00Z",
      endIso: "2026-07-16T14:30:00Z",
      createdIso: "2026-07-15T00:00:00Z",
      updatedIso: "2026-07-15T00:00:00Z",
      cancelled: false,
      calendar: "primary"
    });
  });

  it("marks canceled events and covers every location arm", () => {
    expect(normalizeCalendlyEvent(rawEvent("EV1", { status: "canceled" }))?.cancelled).toBe(true);
    expect(
      normalizeCalendlyEvent(rawEvent("EV1", { location: { location: "123 Main St" } }))?.location
    ).toBe("123 Main St");
    expect(
      normalizeCalendlyEvent(rawEvent("EV1", { location: { type: "phone_call" } }))?.location
    ).toBe("phone_call");
    expect(normalizeCalendlyEvent(rawEvent("EV1", { location: {} }))?.location).toBeUndefined();
    expect(normalizeCalendlyEvent(rawEvent("EV1", { name: 7 }))?.title).toBe("");
  });

  it("rejects events without a usable uri", () => {
    expect(normalizeCalendlyEvent({ ...rawEvent("EV1"), uri: undefined })).toBeNull();
    expect(normalizeCalendlyEvent({ ...rawEvent("EV1"), uri: "" })).toBeNull();
    expect(
      normalizeCalendlyEvent({ ...rawEvent("EV1"), uri: "https://api.calendly.com/scheduled_events/" })
    ).toBeNull();
  });
});

describe("formatInviteeLocalTime", () => {
  it("renders the invitee's wall-clock start", () => {
    const out = formatInviteeLocalTime("2026-07-16T18:00:00Z", "America/Toronto");
    expect(out).toContain("2:00 PM");
    expect(out).toContain("July 16, 2026");
  });

  it("returns null for missing/unparseable inputs and bad timezones", () => {
    expect(formatInviteeLocalTime(undefined, "America/Toronto")).toBeNull();
    expect(formatInviteeLocalTime("2026-07-16T18:00:00Z", undefined)).toBeNull();
    expect(formatInviteeLocalTime("not-a-date", "America/Toronto")).toBeNull();
    expect(formatInviteeLocalTime("2026-07-16T18:00:00Z", "Fake/Zone")).toBeNull();
  });
});

describe("applyInviteeContext", () => {
  function baseEvent(overrides: Partial<CalendarEventInput> = {}): CalendarEventInput {
    return {
      id: "EV1",
      title: "Call",
      startIso: "2026-07-16T18:00:00Z",
      calendar: "primary",
      ...overrides
    };
  }

  it("folds name/email/phone/timezone/local-time/links/Q&A into the event", () => {
    const ev = baseEvent();
    applyInviteeContext(ev, [
      {
        name: "Uday Nandam",
        email: "uday@example.com",
        timezone: "America/Toronto",
        text_reminder_number: "+15551230000",
        reschedule_url: "https://calendly.com/reschedulings/abc",
        cancel_url: "https://calendly.com/cancellations/abc",
        questions_and_answers: [
          { question: "What can we help you with?", answer: "Meta ads" },
          { question: "no answer" },
          { answer: "no question" }
        ]
      }
    ]);
    expect(ev.attendees).toEqual(["Uday Nandam <uday@example.com>"]);
    expect(ev.description).toContain("invitee name: Uday Nandam");
    expect(ev.description).toContain("invitee email: uday@example.com");
    expect(ev.description).toContain("invitee phone: +15551230000");
    expect(ev.description).toContain("invitee timezone: America/Toronto");
    expect(ev.description).toContain("starts (invitee local time): ");
    expect(ev.description).toContain("2:00 PM");
    expect(ev.description).toContain("reschedule link: https://calendly.com/reschedulings/abc");
    expect(ev.description).toContain("cancel link: https://calendly.com/cancellations/abc");
    expect(ev.description).toContain('answer "What can we help you with?": Meta ads');
  });

  it("appends to an existing description and handles partial identities", () => {
    const ev = baseEvent({ description: "existing" });
    applyInviteeContext(ev, [
      { email: "solo@example.com" },
      { name: "Name Only" },
      // No identity at all: contributes nothing but must not crash.
      {}
    ]);
    expect(ev.description).toMatch(/^existing\n/);
    expect(ev.attendees).toEqual(["solo@example.com", "Name Only"]);
  });

  it("omits the local-time line when the timezone can't render the start", () => {
    const ev = baseEvent({ startIso: undefined });
    applyInviteeContext(ev, [{ name: "T", timezone: "America/Toronto" }]);
    expect(ev.description).toContain("invitee timezone: America/Toronto");
    expect(ev.description).not.toContain("starts (invitee local time)");
  });

  it("skips canceled invitees on active events but keeps them on canceled events", () => {
    const active = baseEvent();
    applyInviteeContext(active, [{ name: "Ghost", email: "g@x.co", status: "canceled" }]);
    expect(active.attendees).toBeUndefined();
    expect(active.description).toBeUndefined();

    const canceled = baseEvent({ cancelled: true });
    applyInviteeContext(canceled, [{ name: "Ghost", email: "g@x.co", status: "canceled" }]);
    expect(canceled.attendees).toEqual(["Ghost <g@x.co>"]);
  });

  it("no-ops cleanly on an empty invitee list", () => {
    const ev = baseEvent();
    applyInviteeContext(ev, []);
    expect(ev.attendees).toBeUndefined();
    expect(ev.description).toBeUndefined();
  });
});

describe("fetchCalendlyCandidateEvents", () => {
  type Req = { endpoint: string; params?: Record<string, string> };

  function requestStub(handlers: {
    user?: unknown;
    events?: (req: Req) => unknown;
    invitees?: (uuid: string) => unknown;
  }) {
    const calls: Req[] = [];
    const fn = vi.fn(async (_biz: string, _conn: unknown, config: Req) => {
      calls.push(config);
      if (config.endpoint === "/users/me") {
        return handlers.user === null ? null : ((handlers.user ?? USER_RES) as { data: unknown });
      }
      if (config.endpoint === "/scheduled_events") {
        const out = handlers.events?.(config);
        return out === null ? null : ({ data: out ?? { collection: [] } } as { data: unknown });
      }
      const m = /scheduled_events\/([^/]+)\/invitees/.exec(config.endpoint);
      if (m) {
        const out = handlers.invitees?.(m[1]); // handlers may throw (Error or not)
        return out === null ? null : ({ data: out ?? { collection: [] } } as { data: unknown });
      }
      throw new Error(`unexpected endpoint ${config.endpoint}`);
    });
    return { fn, calls };
  }

  const START_DUE = rawEvent("DUE1", {
    start_time: new Date(NOW + 60 * 60_000).toISOString(),
    end_time: new Date(NOW + 90 * 60_000).toISOString()
  });

  it("lists the start window, due-filters, and enriches due events with invitees", async () => {
    const { fn, calls } = requestStub({
      events: () => ({ collection: [START_DUE, rawEvent("FAR1", { start_time: new Date(NOW + 300 * 60_000).toISOString() })] }),
      invitees: () => ({ collection: [{ name: "Uday", email: "u@x.co", timezone: "America/Toronto" }] })
    });
    const res = await fetchCalendlyCandidateEvents(
      {
        businessId: BIZ,
        conn: CONN,
        nowMs: NOW,
        windows: {
          createdScan: false,
          startHorizonMinutes: 185,
          endBackMinutes: null,
          canceledScan: false
        },
        dueFilter: (ev) => ev.id === "DUE1"
      },
      { request: fn }
    );
    expect(res.overflowed).toBe(false);
    expect(res.events.map((e) => e.id)).toEqual(["DUE1"]);
    expect(res.events[0].attendees).toEqual(["Uday <u@x.co>"]);
    expect(res.events[0].description).toContain("invitee timezone: America/Toronto");

    const listing = calls.find((c) => c.endpoint === "/scheduled_events");
    expect(listing?.params).toMatchObject({
      user: "https://api.calendly.com/users/U1",
      status: "active",
      sort: "start_time:asc",
      count: String(CALENDLY_POLL_PAGE_COUNT),
      min_start_time: new Date(NOW).toISOString(),
      max_start_time: new Date(NOW + 185 * 60_000).toISOString()
    });
    // Only the DUE event got an invitees call.
    const inviteeCalls = calls.filter((c) => c.endpoint.includes("/invitees"));
    expect(inviteeCalls).toHaveLength(1);
    expect(inviteeCalls[0].endpoint).toContain("DUE1");
  });

  it("queries the created/end/canceled windows with their documented bounds and dedupes across windows", async () => {
    const seenParams: Array<Record<string, string> | undefined> = [];
    const { fn } = requestStub({
      events: (req) => {
        seenParams.push(req.params);
        return { collection: [START_DUE] };
      }
    });
    const res = await fetchCalendlyCandidateEvents(
      {
        businessId: BIZ,
        conn: CONN,
        nowMs: NOW,
        windows: {
          createdScan: true,
          startHorizonMinutes: 65,
          endBackMinutes: 45,
          canceledScan: true
        },
        dueFilter: () => true
      },
      { request: fn }
    );
    // Same event listed by all four windows → one candidate.
    expect(res.events.map((e) => e.id)).toEqual(["DUE1"]);

    const day = 24 * 60 * 60_000;
    expect(seenParams[0]).toMatchObject({
      status: "active",
      max_start_time: new Date(NOW + CALENDLY_CREATED_SCAN_DAYS * day).toISOString()
    });
    expect(seenParams[1]).toMatchObject({
      max_start_time: new Date(NOW + 65 * 60_000).toISOString()
    });
    expect(seenParams[2]).toMatchObject({
      min_start_time: new Date(
        NOW - (45 + CALENDLY_END_MAX_EVENT_MINUTES) * 60_000
      ).toISOString(),
      max_start_time: new Date(NOW).toISOString()
    });
    expect(seenParams[3]).toMatchObject({
      status: "canceled",
      min_start_time: new Date(NOW - CALENDLY_CANCELED_SCAN_BACK_DAYS * day).toISOString(),
      max_start_time: new Date(NOW + CALENDLY_CANCELED_SCAN_FORWARD_DAYS * day).toISOString()
    });
  });

  it("throws calendar_not_connected when the transport refuses (user probe and listing)", async () => {
    const refuseUser = requestStub({ user: null });
    await expect(
      fetchCalendlyCandidateEvents(
        {
          businessId: BIZ,
          conn: CONN,
          nowMs: NOW,
          windows: { createdScan: true, startHorizonMinutes: null, endBackMinutes: null, canceledScan: false },
          dueFilter: () => true
        },
        { request: refuseUser.fn }
      )
    ).rejects.toThrow("calendar_not_connected");

    const emptyUser = requestStub({ user: { data: { resource: {} } } });
    await expect(
      fetchCalendlyCandidateEvents(
        {
          businessId: BIZ,
          conn: CONN,
          nowMs: NOW,
          windows: { createdScan: true, startHorizonMinutes: null, endBackMinutes: null, canceledScan: false },
          dueFilter: () => true
        },
        { request: emptyUser.fn }
      )
    ).rejects.toThrow("calendar_not_connected");

    const refuseListing = requestStub({ events: () => null });
    await expect(
      fetchCalendlyCandidateEvents(
        {
          businessId: BIZ,
          conn: CONN,
          nowMs: NOW,
          windows: { createdScan: true, startHorizonMinutes: null, endBackMinutes: null, canceledScan: false },
          dueFilter: () => true
        },
        { request: refuseListing.fn }
      )
    ).rejects.toThrow("calendar_not_connected");

    // Non-Error window failures are wrapped into a real Error on rethrow.
    const throwString = requestStub({
      events: () => {
        throw "calendly string blast";
      }
    });
    await expect(
      fetchCalendlyCandidateEvents(
        {
          businessId: BIZ,
          conn: CONN,
          nowMs: NOW,
          windows: { createdScan: true, startHorizonMinutes: null, endBackMinutes: null, canceledScan: false },
          dueFilter: () => true
        },
        { request: throwString.fn }
      )
    ).rejects.toThrow("calendly string blast");
  });

  it("keeps earlier windows' events when a later window listing fails (per-window isolation)", async () => {
    // Bugbot Medium: a canceled-window refusal must not throw away the due
    // start-window events already collected this tick.
    let call = 0;
    const { fn } = requestStub({
      events: () => {
        call += 1;
        if (call === 1) return { collection: [START_DUE] };
        return null; // second window refused
      },
      invitees: () => ({ collection: [] })
    });
    const res = await fetchCalendlyCandidateEvents(
      {
        businessId: BIZ,
        conn: CONN,
        nowMs: NOW,
        windows: {
          createdScan: false,
          startHorizonMinutes: 120,
          endBackMinutes: null,
          canceledScan: true
        },
        dueFilter: () => true
      },
      { request: fn }
    );
    expect(res.events.map((e) => e.id)).toEqual(["DUE1"]);
  });

  it("flags overflow on a full page and tolerates malformed rows / missing collections", async () => {
    const fullPage = Array.from({ length: CALENDLY_POLL_PAGE_COUNT }, (_, i) =>
      rawEvent(`EV${i}`)
    );
    const { fn } = requestStub({
      events: (req) =>
        req.params?.status === "active"
          ? { collection: [...fullPage, { uri: "" }, { name: "no uri" }] }
          : {}
    });
    const res = await fetchCalendlyCandidateEvents(
      {
        businessId: BIZ,
        conn: CONN,
        nowMs: NOW,
        windows: { createdScan: true, startHorizonMinutes: null, endBackMinutes: null, canceledScan: true },
        dueFilter: () => false
      },
      { request: fn }
    );
    expect(res.overflowed).toBe(true);
    expect(res.events).toEqual([]);
  });

  it("caps invitee enrichment (overflow-flagged) and tolerates refused/thrown invitee calls", async () => {
    const many = Array.from({ length: CALENDLY_INVITEE_FETCH_CAP + 2 }, (_, i) =>
      rawEvent(`EV${i}`)
    );
    let inviteeCalls = 0;
    const { fn } = requestStub({
      events: () => ({ collection: many }),
      invitees: (uuid) => {
        inviteeCalls += 1;
        if (uuid === "EV0") return null; // transport refusal — event still fires
        if (uuid === "EV1") throw new Error("calendly 500"); // thrown Error — logged, not fatal
        if (uuid === "EV2") throw "calendly string blast"; // thrown non-Error — stringified
        if (uuid === "EV3") return {}; // body without a collection — tolerated
        return { collection: [{ name: "I", email: "i@x.co" }] };
      }
    });
    const res = await fetchCalendlyCandidateEvents(
      {
        businessId: BIZ,
        conn: CONN,
        nowMs: NOW,
        windows: { createdScan: true, startHorizonMinutes: null, endBackMinutes: null, canceledScan: false },
        dueFilter: () => true
      },
      { request: fn }
    );
    expect(res.overflowed).toBe(true);
    expect(res.events).toHaveLength(CALENDLY_INVITEE_FETCH_CAP + 2);
    expect(inviteeCalls).toBe(CALENDLY_INVITEE_FETCH_CAP);
    // EV0 (refused), EV1/EV2 (thrown), EV3 (no collection) still fire, just
    // without invitee context.
    for (const i of [0, 1, 2, 3]) expect(res.events[i].attendees).toBeUndefined();
    expect(res.events[4].attendees).toEqual(["I <i@x.co>"]);
  });
});
