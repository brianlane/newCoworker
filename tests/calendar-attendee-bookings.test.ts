/**
 * Shared attendee-bookings module (src/lib/calendar-tools/attendee-bookings.ts):
 *
 *  - the provider REGISTRY PARITY guard — every provider key
 *    `resolveCalendarConnection` can return must be registered (adapter or
 *    explicit `ledger_only`), parsed from the connections module's source so
 *    a new provider without a booking-visibility decision fails CI;
 *  - `findUpcomingBookingsForAttendee` (ledger + adapter merge, dedupe,
 *    ordering, fail-open);
 *  - the adapter branches the consumer suites (booking-precheck,
 *    contact-booking-context) don't reach.
 */
import fs from "node:fs";
import path from "node:path";
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
vi.mock("@/lib/db/vagaro-connections", () => ({ getActiveVagaroConnection: vi.fn() }));
vi.mock("@/lib/vagaro/client", () => ({ listVagaroAppointments: vi.fn() }));
vi.mock("@/lib/calendar-tools/booking-dedupe", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  findUpcomingBookingClaim: vi.fn(),
  findUpcomingBookingClaimByPhone: vi.fn()
}));

import {
  ATTENDEE_BOOKING_LOOKUPS,
  ATTENDEE_BOOKING_EVENT_SCAN,
  calendlyInviteeMatchesAttendee,
  findUpcomingBookingsForAttendee,
  lookupProviderBookingsForAttendee,
  vagaroAppointmentMatchesAttendee,
  type AttendeeBookingDeps
} from "@/lib/calendar-tools/attendee-bookings";
import {
  findUpcomingBookingClaim,
  findUpcomingBookingClaimByPhone
} from "@/lib/calendar-tools/booking-dedupe";
import { resolveCalendarConnection } from "@/lib/voice-tools/connections";
import { getActiveVagaroConnection, } from "@/lib/db/vagaro-connections";
import { listVagaroAppointments } from "@/lib/vagaro/client";
import { logger } from "@/lib/logger";

const BIZ = "11111111-1111-4111-8111-111111111111";
const CALENDLY_CONN = {
  provider: "calendly" as const,
  providerConfigKey: "calendly-direct",
  connectionId: "cx-1"
};
const VAGARO_CONN = {
  provider: "vagaro" as const,
  providerConfigKey: "vagaro",
  connectionId: "vg-1"
};
const MICROSOFT_CONN = {
  provider: "microsoft" as const,
  providerConfigKey: "outlook",
  connectionId: "ms-1"
};
const USER_URI = "https://api.calendly.com/users/U1";
const FUTURE = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
const LATER = new Date(Date.now() + 48 * 60 * 60_000).toISOString();

function deps(overrides: Partial<AttendeeBookingDeps> = {}): AttendeeBookingDeps {
  return {
    request: vi.fn().mockResolvedValue(null),
    resolveConnection: vi.fn().mockResolvedValue(CALENDLY_CONN),
    getCachedUserUri: vi.fn().mockResolvedValue(USER_URI),
    persistUserUri: vi.fn().mockResolvedValue(undefined),
    findLedgerClaim: vi.fn().mockResolvedValue(null),
    findLedgerClaimByPhone: vi.fn().mockResolvedValue(null),
    ...overrides
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("provider registry parity (the future-integration guard)", () => {
  it("every provider resolveCalendarConnection can return is registered — adapter or explicit ledger_only", () => {
    // Parse the provider union straight out of the connections module's
    // source (same spirit as the agent-tool seed parity test): a new
    // provider added to ResolvedVoiceConnection without a registry decision
    // must fail here, not silently ship invisible bookings.
    const source = fs.readFileSync(
      path.resolve(__dirname, "../src/lib/voice-tools/connections.ts"),
      "utf8"
    );
    const unionMatch = source.match(
      /export type ResolvedVoiceConnection = \{[^}]*?provider:\s*([^;]+);/s
    );
    expect(unionMatch, "ResolvedVoiceConnection.provider union not found").toBeTruthy();
    const declared = [...unionMatch![1].matchAll(/"([a-z0-9_-]+)"/g)].map((m) => m[1]).sort();
    expect(declared.length).toBeGreaterThanOrEqual(5);
    expect(Object.keys(ATTENDEE_BOOKING_LOOKUPS).sort()).toEqual(declared);
  });

  it("workspace + CalDAV providers are deliberate ledger_only entries; Calendly and Vagaro have adapters", () => {
    expect(ATTENDEE_BOOKING_LOOKUPS.google).toEqual({ kind: "ledger_only" });
    expect(ATTENDEE_BOOKING_LOOKUPS.microsoft).toEqual({ kind: "ledger_only" });
    expect(ATTENDEE_BOOKING_LOOKUPS.caldav).toEqual({ kind: "ledger_only" });
    expect(ATTENDEE_BOOKING_LOOKUPS.calendly.kind).toBe("adapter");
    expect(ATTENDEE_BOOKING_LOOKUPS.vagaro.kind).toBe("adapter");
  });
});

describe("lookupProviderBookingsForAttendee", () => {
  it("answers empty ok for a ledger-only provider (nothing off-platform can exist)", async () => {
    const d = deps();
    const res = await lookupProviderBookingsForAttendee(
      BIZ,
      MICROSOFT_CONN,
      { phones: ["+16136067906"], email: null },
      d
    );
    expect(res).toEqual({ ok: true, bookings: [] });
    expect(d.request).not.toHaveBeenCalled();
  });

  it("existence email-only lookup with no hit skips the phone path and answers empty", async () => {
    const request = vi.fn(
      async (_b: string, _c: unknown, config: { endpoint: string; params?: Record<string, string> }) => {
        expect(config.params?.invitee_email).toBe("tim@x.com");
        return { data: { collection: [] } };
      }
    );
    const res = await lookupProviderBookingsForAttendee(
      BIZ,
      CALENDLY_CONN,
      { phones: [], email: "tim@x.com" },
      deps({ request: request as never }),
      { mode: "existence" }
    );
    expect(res).toEqual({ ok: true, bookings: [] });
    // One email-narrowed listing only — no full phone-path listing.
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("existence email hit carries the listed event's name, uuid, and start", async () => {
    const request = vi.fn().mockResolvedValue({
      data: {
        collection: [
          {
            uri: "https://api.calendly.com/scheduled_events/EV9",
            name: "Intro Call",
            start_time: FUTURE
          }
        ]
      }
    });
    const res = await lookupProviderBookingsForAttendee(
      BIZ,
      CALENDLY_CONN,
      { phones: [], email: "tim@x.com" },
      deps({ request }),
      { mode: "existence" }
    );
    expect(res).toEqual({
      ok: true,
      bookings: [
        {
          provider: "calendly",
          source: "external",
          eventId: "EV9",
          startIso: FUTURE,
          name: "Intro Call",
          rescheduled: false
        }
      ]
    });
  });

  it("a caller-resolved calendlyUserUri skips the adapter's own resolution", async () => {
    const request = vi.fn(
      async (_b: string, _c: unknown, config: { endpoint: string; params?: Record<string, string> }) => {
        expect(config.endpoint).not.toBe("/users/me");
        expect(config.params?.user).toBe("https://api.calendly.com/users/HINTED");
        return { data: { collection: [] } };
      }
    );
    const d = deps({ request: request as never, getCachedUserUri: vi.fn() });
    const res = await lookupProviderBookingsForAttendee(
      BIZ,
      CALENDLY_CONN,
      { phones: [], email: "tim@x.com" },
      d,
      { mode: "existence", calendlyUserUri: "https://api.calendly.com/users/HINTED" }
    );
    expect(res.ok).toBe(true);
    expect(d.getCachedUserUri).not.toHaveBeenCalled();
  });

  it("binds the production transport and caches when no deps are injected", async () => {
    // Module-level mocks: the cached-URI read answers null and the
    // production transport (mocked) refuses /users/me → refused, having
    // exercised every default-dep binding.
    const { calendlyRequest } = await import("@/lib/calendar-tools/calendly");
    const { getActiveCalendlyConnectionUserUri } = await import("@/lib/db/calendly-connections");
    vi.mocked(calendlyRequest).mockResolvedValue(null);
    vi.mocked(getActiveCalendlyConnectionUserUri).mockResolvedValue(null);
    const res = await lookupProviderBookingsForAttendee(
      BIZ,
      CALENDLY_CONN,
      { phones: ["+16136067906"], email: null },
      {}
    );
    expect(res).toEqual({ ok: false, reason: "refused" });
    expect(calendlyRequest).toHaveBeenCalledWith(
      BIZ,
      CALENDLY_CONN,
      expect.objectContaining({ endpoint: "/users/me" })
    );
  });

  it("detail mode refuses when the listing transport refuses", async () => {
    const res = await lookupProviderBookingsForAttendee(
      BIZ,
      CALENDLY_CONN,
      { phones: ["+16136067906"], email: null },
      deps({
        request: vi.fn(async (_b: string, _c: unknown, config: { endpoint: string }) =>
          config.endpoint === "/scheduled_events" ? null : { data: {} }
        ) as never
      }),
      { mode: "detail" }
    );
    expect(res).toEqual({ ok: false, reason: "refused" });
  });

  it("detail mode lists with the full scan count and reports lineage from old_invitee", async () => {
    const request = vi.fn(
      async (_b: string, _c: unknown, config: { endpoint: string; params?: Record<string, string> }) => {
        if (config.endpoint === "/scheduled_events") {
          expect(config.params?.count).toBe(String(ATTENDEE_BOOKING_EVENT_SCAN));
          return {
            data: {
              collection: [
                { uri: "https://api.calendly.com/scheduled_events/EVA", start_time: FUTURE }
              ]
            }
          };
        }
        return {
          data: {
            collection: [
              {
                status: "active",
                text_reminder_number: "613-606-7906",
                old_invitee: "https://api.calendly.com/scheduled_events/OLD/invitees/I1"
              }
            ]
          }
        };
      }
    );
    const res = await lookupProviderBookingsForAttendee(
      BIZ,
      CALENDLY_CONN,
      { phones: ["+16136067906"], email: null },
      deps({ request: request as never }),
      { mode: "detail" }
    );
    expect(res.ok && res.bookings[0]).toMatchObject({
      eventId: "EVA",
      name: "Appointment",
      rescheduled: true
    });
  });

  it("vagaro: a blank appointment id reads as a null eventId", async () => {
    vi.mocked(getActiveVagaroConnection).mockResolvedValue({ id: "vg" } as never);
    vi.mocked(listVagaroAppointments).mockResolvedValue([
      {
        id: "",
        startIso: FUTURE,
        endIso: null,
        createdIso: null,
        updatedIso: null,
        status: "confirmed",
        cancelled: false,
        serviceId: null,
        serviceName: null,
        customerName: null,
        customerPhone: "+16136067906",
        customerEmail: null
      } as never
    ]);
    const res = await lookupProviderBookingsForAttendee(
      BIZ,
      VAGARO_CONN,
      { phones: ["+16136067906"], email: null },
      {}
    );
    expect(res.ok && res.bookings[0]).toMatchObject({
      provider: "vagaro",
      eventId: null,
      name: null
    });
  });
});

describe("findUpcomingBookingsForAttendee", () => {
  const LEDGER_CLAIM = {
    id: "claim-1",
    eventId: "AAMk-ledger",
    startAt: "2026-07-22 13:00:00+00",
    zoomMeetingId: null
  };

  it("reports the ledger's soonest upcoming claim (exact attendee key first)", async () => {
    const d = deps({ findLedgerClaim: vi.fn().mockResolvedValue(LEDGER_CLAIM) });
    const out = await findUpcomingBookingsForAttendee(
      BIZ,
      { phones: ["+16136067906"], email: null, name: "shabir" },
      d
    );
    expect(out).toEqual([
      {
        provider: "ledger",
        source: "platform",
        eventId: "AAMk-ledger",
        startIso: "2026-07-22T13:00:00.000Z",
        name: null,
        rescheduled: false
      }
    ]);
    expect(d.findLedgerClaim).toHaveBeenCalledWith(BIZ, "phone:+16136067906");
    expect(d.findLedgerClaimByPhone).not.toHaveBeenCalled();
  });

  it("falls back to the phone-tolerant ledger lookup when the exact key misses", async () => {
    const d = deps({ findLedgerClaimByPhone: vi.fn().mockResolvedValue(LEDGER_CLAIM) });
    const out = await findUpcomingBookingsForAttendee(BIZ, { phones: ["+16136067906"], email: null }, d);
    expect(out).toHaveLength(1);
    expect(d.findLedgerClaimByPhone).toHaveBeenCalledWith(BIZ, "+16136067906");
  });

  it("skips the phone-tolerant fallback for a phoneless attendee", async () => {
    const d = deps({ resolveConnection: vi.fn().mockResolvedValue(null) });
    const out = await findUpcomingBookingsForAttendee(BIZ, { phones: [], email: "a@b.c" }, d);
    expect(out).toEqual([]);
    expect(d.findLedgerClaimByPhone).not.toHaveBeenCalled();
  });

  it("merges provider bookings after the ledger, de-duplicated by event id, sorted soonest-first", async () => {
    const request = vi.fn().mockResolvedValue({
      data: {
        collection: [
          // Same event the ledger already holds → deduped.
          { uri: "https://api.calendly.com/scheduled_events/AAMk-ledger", start_time: FUTURE },
          { uri: "https://api.calendly.com/scheduled_events/EV-other", start_time: LATER }
        ]
      }
    });
    const d = deps({
      findLedgerClaim: vi.fn().mockResolvedValue({ ...LEDGER_CLAIM, startAt: LATER }),
      request
    });
    const out = await findUpcomingBookingsForAttendee(BIZ, { phones: [], email: "a@b.c" }, d, {
      mode: "detail"
    });
    // Detail mode returns at most one booking; the email-narrowed listing's
    // first event shares the ledger claim's id, so only the ledger row and
    // no duplicate survive. (The detail invitee fetch is refused → the
    // match scan answers empty; existence mode below exercises the merge.)
    expect(out.map((b) => b.eventId)).toEqual(["AAMk-ledger"]);

    const existenceOut = await findUpcomingBookingsForAttendee(
      BIZ,
      { phones: [], email: "a@b.c" },
      deps({
        findLedgerClaim: vi.fn().mockResolvedValue({ ...LEDGER_CLAIM, startAt: LATER }),
        request: vi.fn().mockResolvedValue({
          data: {
            collection: [
              { uri: "https://api.calendly.com/scheduled_events/EV-soon", start_time: FUTURE }
            ]
          }
        })
      }),
      { mode: "existence" }
    );
    expect(existenceOut.map((b) => [b.eventId, b.provider])).toEqual([
      ["EV-soon", "calendly"],
      ["AAMk-ledger", "ledger"]
    ]);
  });

  it("dedupes an existence-mode provider hit that matches the ledger claim's event", async () => {
    const d = deps({
      findLedgerClaim: vi.fn().mockResolvedValue({ ...LEDGER_CLAIM, eventId: "EV9" }),
      request: vi.fn().mockResolvedValue({
        data: { collection: [{ uri: "https://api.calendly.com/scheduled_events/EV9" }] }
      })
    });
    const out = await findUpcomingBookingsForAttendee(BIZ, { phones: [], email: "a@b.c" }, d);
    expect(out).toHaveLength(1);
    expect(out[0].provider).toBe("ledger");
  });

  it("sorts a provider hit without a start after known-time bookings", async () => {
    // The existence email fast path can answer without a start_time; that
    // booking must sort AFTER the ledger's known-time claim.
    const d = deps({
      findLedgerClaim: vi.fn().mockResolvedValue(LEDGER_CLAIM),
      request: vi.fn().mockResolvedValue({ data: { collection: [{ uri: "EV-nostart" }] } })
    });
    const out = await findUpcomingBookingsForAttendee(BIZ, { phones: [], email: "a@b.c" }, d);
    expect(out.map((b) => b.eventId)).toEqual(["AAMk-ledger", "EV-nostart"]);
    expect(out[1].startIso).toBe("");
  });

  it("keeps the ledger answer when the provider lookup refuses", async () => {
    const d = deps({
      findLedgerClaim: vi.fn().mockResolvedValue(LEDGER_CLAIM),
      getCachedUserUri: vi.fn().mockResolvedValue(null),
      request: vi.fn().mockResolvedValue(null) // /users/me refused
    });
    const out = await findUpcomingBookingsForAttendee(BIZ, { phones: ["+16136067906"], email: null }, d);
    expect(out.map((b) => b.provider)).toEqual(["ledger"]);
  });

  it("fails open (with a warning) when the provider lookup throws — Error and string shapes", async () => {
    const d = deps({
      findLedgerClaim: vi.fn().mockResolvedValue(LEDGER_CLAIM),
      resolveConnection: vi.fn().mockResolvedValue(VAGARO_CONN),
      getVagaroConnection: vi.fn().mockResolvedValue({ id: "vg" } as never),
      listAppointments: vi.fn().mockRejectedValue(new Error("vagaro down"))
    });
    const out = await findUpcomingBookingsForAttendee(BIZ, { phones: ["+16136067906"], email: null }, d);
    expect(out.map((b) => b.provider)).toEqual(["ledger"]);
    expect(logger.warn).toHaveBeenCalledWith(
      "attendee bookings: provider lookup failed (fail-open)",
      expect.objectContaining({ businessId: BIZ, error: "vagaro down" })
    );

    const d2 = deps({
      resolveConnection: vi.fn().mockRejectedValue("resolve string sad")
    });
    expect(await findUpcomingBookingsForAttendee(BIZ, { phones: [], email: "a@b.c" }, d2)).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      "attendee bookings: provider lookup failed (fail-open)",
      expect.objectContaining({ error: "resolve string sad" })
    );
  });

  it("uses the production ledger reads and connection resolver when none are injected", async () => {
    vi.mocked(findUpcomingBookingClaim).mockResolvedValue(null);
    vi.mocked(findUpcomingBookingClaimByPhone).mockResolvedValue(null);
    vi.mocked(resolveCalendarConnection).mockResolvedValue(null);
    const out = await findUpcomingBookingsForAttendee(BIZ, { phones: ["+16136067906"], email: null });
    expect(out).toEqual([]);
    expect(findUpcomingBookingClaim).toHaveBeenCalledWith(BIZ, "phone:+16136067906");
    expect(findUpcomingBookingClaimByPhone).toHaveBeenCalledWith(BIZ, "+16136067906");
    expect(resolveCalendarConnection).toHaveBeenCalledWith(BIZ);
  });
});

describe("matchers", () => {
  const ids = { phones: ["+16136067906"], email: "shabir@x.com" };

  it("calendlyInviteeMatchesAttendee: canceled invitees never match; email and tolerant phone do", () => {
    expect(
      calendlyInviteeMatchesAttendee(
        { status: "canceled", text_reminder_number: "+16136067906" },
        ids
      )
    ).toBe(false);
    expect(calendlyInviteeMatchesAttendee({ email: "SHABIR@x.com" }, ids)).toBe(true);
    expect(calendlyInviteeMatchesAttendee({ text_reminder_number: "613-606-7906" }, ids)).toBe(true);
    expect(calendlyInviteeMatchesAttendee({}, ids)).toBe(false);
    expect(
      calendlyInviteeMatchesAttendee(
        { text_reminder_number: "613-606-7906" },
        { phones: ["+"], email: null }
      )
    ).toBe(false);
  });

  it("vagaroAppointmentMatchesAttendee mirrors the invitee matcher", () => {
    expect(
      vagaroAppointmentMatchesAttendee({ customerEmail: "shabir@x.com", customerPhone: null }, ids)
    ).toBe(true);
    expect(
      vagaroAppointmentMatchesAttendee({ customerEmail: null, customerPhone: "6136067906" }, ids)
    ).toBe(true);
    expect(vagaroAppointmentMatchesAttendee({}, ids)).toBe(false);
  });
});
