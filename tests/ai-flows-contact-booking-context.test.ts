/**
 * Contact booking context (src/lib/ai-flows/contact-booking-context.ts): the
 * SMS agent's "booking status" line — connection gating, contact-identifier
 * resolution, the active/canceled Calendly scans (email-narrowed, capped,
 * fail-open), the rescheduled/canceled classification, and line wording.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServiceClient: vi.fn() }));
vi.mock("@/lib/nango/workspace", () => ({ nangoProxyForBusiness: vi.fn() }));
vi.mock("@/lib/voice-tools/connections", () => ({
  resolveCalendarConnection: vi.fn(),
  isWorkspaceCalendarProvider: (p: string) => p === "google" || p === "microsoft",
  CALENDLY_DIRECT_KEY: "calendly-direct"
}));
vi.mock("@/lib/calendar-tools/calendly", () => ({ calendlyRequest: vi.fn() }));
vi.mock("@/lib/db/calendly-connections", () => ({
  getActiveCalendlyConnectionUserUri: vi.fn(),
  setCalendlyConnectionUserUri: vi.fn()
}));
vi.mock("@/lib/db/system-logs", () => ({ recordSystemLog: vi.fn() }));
vi.mock("@/lib/db/contact-emails", () => ({ findContactsByEmails: vi.fn() }));
vi.mock("@/lib/calendly/webhook-subscriptions", () => ({
  ensureCalendlyWebhookSubscription: vi.fn()
}));
vi.mock("@/lib/ai-flows/db", () => ({ enqueueAiFlowRun: vi.fn() }));
vi.mock("@/lib/calendar-tools/shared-calendar", () => ({ getSharedCalendar: vi.fn() }));
vi.mock("@/lib/db/vagaro-connections", () => ({ getActiveVagaroConnection: vi.fn() }));
vi.mock("@/lib/vagaro/client", () => ({ listVagaroAppointments: vi.fn() }));

import {
  BOOKING_CONTEXT_INVITEE_FETCH_CAP,
  bookingContextLine,
  contactBookingContextForPhone,
  contactIdentifiers,
  inviteeMatchesContact,
  vagaroAppointmentMatchesContact,
  type ContactBookingContextDeps
} from "@/lib/ai-flows/contact-booking-context";
import { resolveCalendarConnection } from "@/lib/voice-tools/connections";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { logger } from "@/lib/logger";

const BIZ = "11111111-1111-4111-8111-111111111111";
const PHONE = "+17808039935";
const CONN = {
  provider: "calendly" as const,
  providerConfigKey: "calendly-direct",
  connectionId: "cx-1"
};
const USER_URI = "https://api.calendly.com/users/U1";
const FUTURE = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
const PAST = new Date(Date.now() - 60 * 60_000).toISOString();

type QueuedResult = { data?: unknown; error?: { message: string } | null };

/** Minimal chainable contacts fake (same shape as the precheck suite's). */
function fakeDb(rows: QueuedResult[], opts: { throwOn?: boolean } = {}) {
  return {
    from() {
      const chain: Record<string, (...args: unknown[]) => unknown> = {};
      for (const m of ["select", "eq", "or", "limit"]) chain[m] = () => chain;
      chain.maybeSingle = () => {
        // Thrown as a bare string so the String(err) logging arm is covered.
        if (opts.throwOn) throw "contacts exploded";
        const r = rows.shift() ?? { data: null, error: null };
        return Promise.resolve({ data: r.data ?? null, error: r.error ?? null });
      };
      return chain;
    }
  } as never;
}

const CONTACT_ROW = {
  data: {
    customer_e164: PHONE,
    alias_e164s: ["+15145550000"],
    email: " Tim@TrustYourTalent.CA "
  }
};

function deps(overrides: Partial<ContactBookingContextDeps> = {}): ContactBookingContextDeps {
  return {
    request: vi.fn().mockResolvedValue(null),
    resolveConnection: vi.fn().mockResolvedValue(CONN),
    getCachedUserUri: vi.fn().mockResolvedValue(USER_URI),
    persistUserUri: vi.fn().mockResolvedValue(undefined),
    ...overrides
  };
}

type Cfg = { endpoint: string; params?: Record<string, string> };

/**
 * A Calendly transport answering the events listing per status and each
 * event's invitees. `events` maps status → listing collection; `invitees`
 * maps event uuid → invitee collection (undefined = refuse that fetch).
 */
function calendlyFake(
  events: Partial<Record<"active" | "canceled", unknown[]>>,
  invitees: Record<string, unknown[] | undefined> = {}
) {
  return vi.fn(async (_b: string, _c: unknown, config: Cfg) => {
    if (config.endpoint === "/scheduled_events") {
      const status = config.params?.status as "active" | "canceled";
      return { data: { collection: events[status] ?? [] } };
    }
    const m = config.endpoint.match(/^\/scheduled_events\/(.+)\/invitees$/);
    if (m) {
      const list = invitees[decodeURIComponent(m[1])];
      if (list === undefined) return null; // refused fetch → fail open
      return { data: { collection: list } };
    }
    throw new Error(`unexpected endpoint ${config.endpoint}`);
  });
}

const event = (uuid: string, startIso: string, name?: string) => ({
  uri: `https://api.calendly.com/scheduled_events/${uuid}`,
  start_time: startIso,
  ...(name !== undefined ? { name } : {})
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("contactIdentifiers", () => {
  it("unions the seed phone with the contact row's numbers and lowercases the email", async () => {
    const out = await contactIdentifiers(fakeDb([CONTACT_ROW]), BIZ, PHONE);
    expect(out.phoneDigits).toEqual(["17808039935", "15145550000"]);
    expect(out.email).toBe("tim@trustyourtalent.ca");
  });

  it("degrades to phone-only on a contacts read error (and on a thrown read)", async () => {
    const errored = await contactIdentifiers(
      fakeDb([{ error: { message: "boom" } }]),
      BIZ,
      PHONE
    );
    expect(errored).toEqual({ phoneDigits: ["17808039935"], email: null });
    const thrown = await contactIdentifiers(fakeDb([], { throwOn: true }), BIZ, PHONE);
    expect(thrown).toEqual({ phoneDigits: ["17808039935"], email: null });
    expect(vi.mocked(logger.warn)).toHaveBeenCalledTimes(2);
  });

  it("ignores a contact email without an @ and blank alias numbers", async () => {
    const out = await contactIdentifiers(
      fakeDb([{ data: { customer_e164: "", alias_e164s: [""], email: "none" } }]),
      BIZ,
      PHONE
    );
    expect(out).toEqual({ phoneDigits: ["17808039935"], email: null });
  });
});

describe("inviteeMatchesContact", () => {
  const ids = { phoneDigits: ["17808039935"], email: "tim@trustyourtalent.ca" };

  it("matches by email case-insensitively", () => {
    expect(inviteeMatchesContact({ email: "TIM@trustyourtalent.ca" }, ids)).toBe(true);
  });

  it("matches the SMS-reminder phone country-code-tolerantly", () => {
    expect(inviteeMatchesContact({ text_reminder_number: "(780) 803-9935" }, ids)).toBe(true);
  });

  it("no identifiers on the invitee → no match", () => {
    expect(inviteeMatchesContact({}, ids)).toBe(false);
    expect(inviteeMatchesContact({ email: "other@x.com" }, ids)).toBe(false);
  });
});

describe("bookingContextLine", () => {
  const ev = { name: "Free Strategy Call", startIso: "2026-07-23T18:00:00Z" };

  it("renders the start business-local WITH a named timezone — never a raw UTC ISO (KYP/Ayanna Jul 20 2026)", () => {
    // A raw "2026-07-23T18:00:00Z" invites the model to misconvert silently;
    // timezone-less times are the defect class that no-showed Ayanna.
    expect(bookingContextLine("booked", ev, { timezone: "America/Toronto" })).toBe(
      'This contact has an upcoming booking: "Free Strategy Call" starting Thu, Jul 23, 2026, 2:00 PM EDT.'
    );
    // No timezone on file → honest UTC labeling, still never a bare ISO.
    expect(bookingContextLine("booked", ev)).toBe(
      'This contact has an upcoming booking: "Free Strategy Call" starting Thu, Jul 23, 2026, 6:00 PM UTC.'
    );
    expect(bookingContextLine("booked", ev, { timezone: "  " })).toContain("6:00 PM UTC");
    // An unrecognized timezone string falls back to the raw ISO rather than throwing.
    expect(bookingContextLine("booked", ev, { timezone: "Mars/Olympus" })).toContain(ev.startIso);
  });

  it("booked / rescheduled / canceled / rescheduled-away wordings", () => {
    expect(bookingContextLine("rescheduled", ev, { timezone: "America/Toronto" })).toContain(
      "they RESCHEDULED it"
    );
    expect(bookingContextLine("canceled", ev)).toContain("CANCELED");
    expect(bookingContextLine("canceled", ev)).toContain("has not rebooked");
    expect(bookingContextLine("canceled", ev, { rescheduledAway: true })).toContain(
      "rescheduled their"
    );
  });
});

describe("contactBookingContextForPhone", () => {
  it("answers none for a non-Calendly (or absent) connection — default deps path", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(null);
    expect(await contactBookingContextForPhone(BIZ, PHONE)).toEqual({
      status: "none",
      line: null
    });
    vi.mocked(resolveCalendarConnection).mockResolvedValue({
      provider: "google",
      providerConfigKey: "google",
      connectionId: "cx-g"
    } as never);
    expect(await contactBookingContextForPhone(BIZ, PHONE)).toEqual({
      status: "none",
      line: null
    });
  });

  it("answers none when the texter yields no identifiers at all", async () => {
    const d = deps();
    const out = await contactBookingContextForPhone(BIZ, "+", d, fakeDb([{ data: null }]));
    expect(out.status).toBe("none");
    expect(d.request).not.toHaveBeenCalled();
  });

  it("answers none when the user URI cannot be resolved", async () => {
    const d = deps({ getCachedUserUri: vi.fn().mockResolvedValue(null) });
    const out = await contactBookingContextForPhone(BIZ, PHONE, d, fakeDb([CONTACT_ROW]));
    expect(out.status).toBe("none");
  });

  it("reports an upcoming active booking as booked (email-narrowed listing, business-local time)", async () => {
    const request = calendlyFake(
      { active: [event("EV1", FUTURE, "Free Strategy Call")] },
      { EV1: [{ status: "active", email: "tim@trustyourtalent.ca" }] }
    );
    const out = await contactBookingContextForPhone(
      BIZ,
      PHONE,
      deps({ request }),
      fakeDb([CONTACT_ROW]),
      "America/Toronto"
    );
    expect(out.status).toBe("booked");
    expect(out.line).toContain('"Free Strategy Call"');
    // Business-local rendering with a named timezone, never the raw ISO.
    expect(out.line).not.toContain(FUTURE);
    expect(out.line).toMatch(
      /starting [A-Z][a-z]{2}, [A-Z][a-z]{2} \d{1,2}, \d{4}, \d{1,2}:\d{2} (AM|PM) E[DS]T\.$/
    );
    // The listing was narrowed by the contact's email, and its window floors
    // at NOW — a past-start active event must never shadow the upcoming slot.
    const listCall = request.mock.calls.find(
      (c) => (c[2] as Cfg).endpoint === "/scheduled_events"
    );
    expect((listCall?.[2] as Cfg).params?.invitee_email).toBe("tim@trustyourtalent.ca");
    const minStart = Date.parse((listCall?.[2] as Cfg).params?.min_start_time ?? "");
    expect(Math.abs(minStart - Date.now())).toBeLessThan(60_000);
  });

  it("reports a replacement slot (old_invitee) as rescheduled", async () => {
    const request = calendlyFake(
      { active: [event("EV1", FUTURE)] },
      {
        EV1: [
          {
            status: "active",
            text_reminder_number: "780-803-9935",
            old_invitee: "https://api.calendly.com/scheduled_events/OLD/invitees/I0"
          }
        ]
      }
    );
    const out = await contactBookingContextForPhone(
      BIZ,
      PHONE,
      deps({ request }),
      // No contact row → phone-only matching (also covers the null-row path).
      fakeDb([{ data: null }])
    );
    expect(out.status).toBe("rescheduled");
    // Default event name when Calendly omits one.
    expect(out.line).toContain('"Appointment"');
  });

  it("a matched active booking whose start already passed falls through to the canceled scan", async () => {
    // Defense in depth behind the now-floored listing window: a provider
    // answering boundary/past starts anyway must still not be reported as
    // an upcoming booking.
    const request = calendlyFake(
      {
        active: [event("EV1", PAST, "Strategy Call")],
        canceled: [event("EV2", PAST, "Strategy Call")]
      },
      {
        EV1: [{ status: "active", email: "tim@trustyourtalent.ca" }],
        EV2: [{ status: "canceled", email: "tim@trustyourtalent.ca", rescheduled: false }]
      }
    );
    const out = await contactBookingContextForPhone(
      BIZ,
      PHONE,
      deps({ request }),
      fakeDb([CONTACT_ROW])
    );
    expect(out.status).toBe("canceled");
    expect(out.line).toContain("has not rebooked");
    // The canceled scan's window reaches back for recent cancels, and lists
    // latest-slot-first so the MOST RECENT cancellation is the one reported.
    const cancelCall = request.mock.calls.find(
      (c) => (c[2] as Cfg).endpoint === "/scheduled_events" && (c[2] as Cfg).params?.status === "canceled"
    );
    const minStart = Date.parse((cancelCall?.[2] as Cfg).params?.min_start_time ?? "");
    expect(Date.now() - minStart).toBeGreaterThan(6 * 24 * 60 * 60_000);
    expect((cancelCall?.[2] as Cfg).params?.sort).toBe("start_time:desc");
    // The active scan keeps soonest-upcoming-first.
    const activeCall = request.mock.calls.find(
      (c) => (c[2] as Cfg).endpoint === "/scheduled_events" && (c[2] as Cfg).params?.status === "active"
    );
    expect((activeCall?.[2] as Cfg).params?.sort).toBe("start_time:asc");
  });

  it("a canceled invitee flagged rescheduled reads as rescheduled-away", async () => {
    const request = calendlyFake(
      { active: [], canceled: [event("EV2", PAST, "Strategy Call")] },
      { EV2: [{ status: "canceled", email: "tim@trustyourtalent.ca", rescheduled: true }] }
    );
    const out = await contactBookingContextForPhone(
      BIZ,
      PHONE,
      deps({ request }),
      fakeDb([CONTACT_ROW])
    );
    expect(out.status).toBe("canceled");
    expect(out.line).toContain("their new time was not found");
  });

  it("skips malformed listings, refused invitee fetches, and non-matching invitees", async () => {
    const request = calendlyFake(
      {
        active: [
          { start_time: FUTURE }, // no uri → filtered
          { uri: "https://api.calendly.com/scheduled_events/EV0" }, // no start → filtered
          event("EV1", FUTURE), // invitee fetch refused
          event("EV2", FUTURE), // wrong person
          event("EV3", FUTURE, "Kept Call") // the real match
        ],
        canceled: []
      },
      {
        EV1: undefined,
        EV2: [{ status: "active", email: "someone-else@x.com" }],
        EV3: [{ status: "active", text_reminder_number: "+1 780 803 9935" }]
      }
    );
    const out = await contactBookingContextForPhone(
      BIZ,
      PHONE,
      deps({ request }),
      fakeDb([CONTACT_ROW])
    );
    expect(out.status).toBe("booked");
    expect(out.line).toContain('"Kept Call"');
  });

  it("a refused events listing answers none (fail open)", async () => {
    const request = vi.fn().mockResolvedValue(null);
    const out = await contactBookingContextForPhone(
      BIZ,
      PHONE,
      deps({ request }),
      fakeDb([CONTACT_ROW])
    );
    expect(out.status).toBe("none");
  });

  it("tolerates listings and invitee responses without a collection", async () => {
    const request = vi.fn(async (_b: string, _c: unknown, config: Cfg) => {
      if (config.endpoint === "/scheduled_events") {
        return config.params?.status === "active"
          ? { data: {} } // no collection key at all
          : { data: { collection: [event("EC1", PAST)] } };
      }
      return { data: {} }; // invitee response without a collection
    });
    const out = await contactBookingContextForPhone(
      BIZ,
      PHONE,
      deps({ request }),
      fakeDb([CONTACT_ROW])
    );
    expect(out.status).toBe("none");
  });

  it("stops at the invitee-fetch budget across both scans", async () => {
    // More active events than the whole budget, none matching: the canceled
    // scan must get ZERO invitee fetches (its listing still happens).
    const activeEvents = Array.from({ length: BOOKING_CONTEXT_INVITEE_FETCH_CAP + 2 }, (_, i) =>
      event(`EA${i}`, FUTURE)
    );
    const inviteeMap: Record<string, unknown[]> = {};
    for (let i = 0; i < activeEvents.length; i += 1) {
      inviteeMap[`EA${i}`] = [{ status: "active", email: "someone-else@x.com" }];
    }
    inviteeMap.EC0 = [{ status: "canceled", email: "tim@trustyourtalent.ca" }];
    const request = calendlyFake(
      { active: activeEvents, canceled: [event("EC0", PAST)] },
      inviteeMap
    );
    const out = await contactBookingContextForPhone(
      BIZ,
      PHONE,
      deps({ request }),
      fakeDb([CONTACT_ROW])
    );
    expect(out.status).toBe("none");
    const inviteeFetches = request.mock.calls.filter((c) =>
      (c[2] as Cfg).endpoint.includes("/invitees")
    );
    expect(inviteeFetches).toHaveLength(BOOKING_CONTEXT_INVITEE_FETCH_CAP);
  });

  it("builds its own service client when none is injected", async () => {
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(fakeDb([CONTACT_ROW]) as never);
    const request = calendlyFake(
      { active: [event("EV1", FUTURE, "Own-client Call")] },
      { EV1: [{ status: "active", email: "tim@trustyourtalent.ca" }] }
    );
    const out = await contactBookingContextForPhone(BIZ, PHONE, deps({ request }));
    expect(out.status).toBe("booked");
    expect(createSupabaseServiceClient).toHaveBeenCalledTimes(1);
  });

  it("answers none (and warns) when the lookup throws — Error and bare-string shapes", async () => {
    const d = deps({ resolveConnection: vi.fn().mockRejectedValue(new Error("nango down")) });
    const out = await contactBookingContextForPhone(BIZ, PHONE, d, fakeDb([]));
    expect(out).toEqual({ status: "none", line: null });
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      "contact booking context: lookup failed (answering none)",
      expect.objectContaining({ businessId: BIZ, error: "nango down" })
    );
    const d2 = deps({ resolveConnection: vi.fn().mockRejectedValue("nango string") });
    expect(await contactBookingContextForPhone(BIZ, PHONE, d2, fakeDb([]))).toEqual({
      status: "none",
      line: null
    });
    expect(vi.mocked(logger.warn)).toHaveBeenLastCalledWith(
      "contact booking context: lookup failed (answering none)",
      expect.objectContaining({ error: "nango string" })
    );
  });
});

describe("contactBookingContextForPhone — Vagaro arm", () => {
  const VAGARO_CONN = {
    provider: "vagaro" as const,
    providerConfigKey: "vagaro",
    connectionId: "vg-1"
  };
  const VG_ROW = { id: "vg-1", business_id: BIZ } as never;

  function vgAppt(overrides: Record<string, unknown> = {}) {
    return {
      id: "appt-1",
      startIso: FUTURE,
      endIso: null,
      createdIso: null,
      updatedIso: null,
      status: "confirmed",
      cancelled: false,
      serviceId: null,
      serviceName: "Gel Manicure",
      customerName: null,
      customerPhone: PHONE,
      customerEmail: null,
      ...overrides
    };
  }

  function vagaroDeps(overrides: Partial<ContactBookingContextDeps> = {}) {
    return deps({
      resolveConnection: vi.fn().mockResolvedValue(VAGARO_CONN),
      getVagaroConnection: vi.fn().mockResolvedValue(VG_ROW),
      listAppointments: vi.fn().mockResolvedValue([]),
      ...overrides
    });
  }

  it("reports the soonest upcoming matching appointment as booked", async () => {
    const sooner = new Date(Date.now() + 2 * 60 * 60_000).toISOString();
    const later = new Date(Date.now() + 26 * 60 * 60_000).toISOString();
    const d = vagaroDeps({
      listAppointments: vi.fn().mockResolvedValue([
        vgAppt({ id: "later", startIso: later, serviceName: "Color" }),
        vgAppt({ id: "sooner", startIso: sooner }),
        // Non-matching, canceled, past, and junk-start rows are all skipped.
        vgAppt({ id: "other", customerPhone: "+15550009999" }),
        vgAppt({ id: "gone", cancelled: true }),
        vgAppt({ id: "past", startIso: PAST }),
        vgAppt({ id: "junk", startIso: "junk" })
      ])
    });
    const out = await contactBookingContextForPhone(
      BIZ,
      PHONE,
      d,
      fakeDb([CONTACT_ROW]),
      "America/Phoenix"
    );
    expect(out.status).toBe("booked");
    expect(out.line).toContain('"Gel Manicure"');
    expect(out.line).toContain("upcoming booking");
    // Only the upcoming listing ran — a booked hit skips the canceled scan.
    expect(d.listAppointments).toHaveBeenCalledTimes(1);
  });

  it("matches by contact email and falls back to 'Appointment' without a service name", async () => {
    const d = vagaroDeps({
      listAppointments: vi.fn().mockResolvedValue([
        vgAppt({
          customerPhone: null,
          customerEmail: "tim@trustyourtalent.ca",
          serviceName: null
        })
      ])
    });
    const out = await contactBookingContextForPhone(BIZ, PHONE, d, fakeDb([CONTACT_ROW]));
    expect(out.status).toBe("booked");
    expect(out.line).toContain('"Appointment"');
  });

  it("reports a recent canceled appointment when nothing upcoming matches", async () => {
    const recentCancel = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
    const olderCancel = new Date(Date.now() - 30 * 60 * 60_000).toISOString();
    const listAppointments = vi
      .fn()
      // Upcoming scan: nothing.
      .mockResolvedValueOnce([])
      // Canceled scan: most recent start wins; un-cancelled rows (an API
      // that ignored the status filter) are never misreported.
      .mockResolvedValueOnce([
        vgAppt({ id: "old", startIso: olderCancel, cancelled: true, status: "cancelled" }),
        vgAppt({
          id: "recent",
          startIso: recentCancel,
          cancelled: true,
          status: "cancelled",
          serviceName: null
        }),
        vgAppt({ id: "not-actually-canceled", startIso: recentCancel })
      ]);
    const d = vagaroDeps({ listAppointments });
    const out = await contactBookingContextForPhone(BIZ, PHONE, d, fakeDb([CONTACT_ROW]));
    expect(out.status).toBe("canceled");
    expect(out.line).toContain("CANCELED");
    expect(out.line).toContain('"Appointment"');
    // The canceled scan asked Vagaro for cancelled appointments explicitly.
    expect(listAppointments.mock.calls[1][1]).toMatchObject({ status: "cancelled" });
  });

  it("answers none when neither scan matches and when the connection row is gone", async () => {
    const d = vagaroDeps();
    expect(await contactBookingContextForPhone(BIZ, PHONE, d, fakeDb([CONTACT_ROW]))).toEqual({
      status: "none",
      line: null
    });
    const gone = vagaroDeps({ getVagaroConnection: vi.fn().mockResolvedValue(null) });
    expect(
      await contactBookingContextForPhone(BIZ, PHONE, gone, fakeDb([CONTACT_ROW]))
    ).toEqual({ status: "none", line: null });
  });

  it("fails open to none when the Vagaro listing throws", async () => {
    const d = vagaroDeps({
      listAppointments: vi.fn().mockRejectedValue(new Error("vagaro down"))
    });
    expect(await contactBookingContextForPhone(BIZ, PHONE, d, fakeDb([CONTACT_ROW]))).toEqual({
      status: "none",
      line: null
    });
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      "contact booking context: lookup failed (answering none)",
      expect.objectContaining({ businessId: BIZ, error: "vagaro down" })
    );
  });

  it("uses the module-level lookups when none are injected (mocked: no row → none)", async () => {
    const d = deps({ resolveConnection: vi.fn().mockResolvedValue(VAGARO_CONN) });
    expect(await contactBookingContextForPhone(BIZ, PHONE, d, fakeDb([CONTACT_ROW]))).toEqual({
      status: "none",
      line: null
    });
  });
});

describe("vagaroAppointmentMatchesContact", () => {
  const item = (overrides: Record<string, unknown> = {}) =>
    ({
      id: "a",
      startIso: FUTURE,
      endIso: null,
      createdIso: null,
      updatedIso: null,
      status: "",
      cancelled: false,
      serviceId: null,
      serviceName: null,
      customerName: null,
      customerPhone: null,
      customerEmail: null,
      ...overrides
    }) as never;

  it("matches on email or country-code-tolerant phone, else not", () => {
    const ids = { phoneDigits: ["17808039935"], email: "tim@trustyourtalent.ca" };
    expect(
      vagaroAppointmentMatchesContact(item({ customerEmail: "tim@trustyourtalent.ca" }), ids)
    ).toBe(true);
    expect(vagaroAppointmentMatchesContact(item({ customerPhone: "780-803-9935" }), ids)).toBe(
      true
    );
    expect(vagaroAppointmentMatchesContact(item({ customerPhone: "+15550001111" }), ids)).toBe(
      false
    );
    expect(vagaroAppointmentMatchesContact(item(), ids)).toBe(false);
  });
});
