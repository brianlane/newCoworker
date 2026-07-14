import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/voice-tools/connections", () => ({ resolveCalendarConnection: vi.fn() }));
vi.mock("@/lib/nango/workspace", () => ({ nangoProxyForBusiness: vi.fn() }));
vi.mock("@/lib/calendar-tools/shared-calendar", () => ({ getSharedCalendar: vi.fn() }));
vi.mock("@/lib/calendar-tools/booking-dedupe", () => ({
  bookingAttendeeKey: vi.fn(() => "phone:+15485773546"),
  findUpcomingBookingClaim: vi.fn(),
  findUpcomingBookingClaimByPhone: vi.fn(),
  rescheduleBookingClaim: vi.fn(),
  deleteBookingClaim: vi.fn(),
  deleteBookingClaimsByEvent: vi.fn(),
  recordExternalBookingClaim: vi.fn()
}));
vi.mock("@/lib/calendar-tools/handlers", () => ({
  resolveToolTimezone: vi.fn(async () => "America/New_York"),
  wallClockInZone: vi.fn((d: Date, tz: string) => `wall(${d.toISOString()},${tz})`)
}));
vi.mock("@/lib/calendar-tools/calendly", () => ({
  cancelCalendlyAppointment: vi.fn(),
  createCalendlyRescheduleLink: vi.fn()
}));
vi.mock("@/lib/calendar-tools/vagaro", () => ({
  cancelVagaroAppointment: vi.fn(),
  rescheduleVagaroAppointment: vi.fn()
}));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn() } }));

import {
  cancelCalendarAppointment,
  rescheduleCalendarAppointment
} from "@/lib/calendar-tools/reschedule";
import { resolveCalendarConnection } from "@/lib/voice-tools/connections";
import { nangoProxyForBusiness } from "@/lib/nango/workspace";
import { getSharedCalendar } from "@/lib/calendar-tools/shared-calendar";
import {
  deleteBookingClaim,
  deleteBookingClaimsByEvent,
  findUpcomingBookingClaim,
  findUpcomingBookingClaimByPhone,
  recordExternalBookingClaim,
  rescheduleBookingClaim
} from "@/lib/calendar-tools/booking-dedupe";
import {
  cancelCalendlyAppointment,
  createCalendlyRescheduleLink
} from "@/lib/calendar-tools/calendly";
import {
  cancelVagaroAppointment,
  rescheduleVagaroAppointment
} from "@/lib/calendar-tools/vagaro";

/**
 * Appointment lifecycle cores (Truly Issue 4): a reschedule PATCHes the
 * existing provider event (updated invitation, not a second one) and a
 * cancel DELETEs it (single cancellation email). Event resolution is ledger
 * first, provider search second.
 */

const BIZ = "11111111-1111-4111-8111-111111111111";
const PHONE = "+15485773546";

const GOOGLE_CONN = {
  provider: "google",
  connectionId: "conn-1",
  providerConfigKey: "google-calendar"
} as never;
const MS_CONN = {
  provider: "microsoft",
  connectionId: "conn-2",
  providerConfigKey: "microsoft-calendar"
} as never;
const CALENDLY_CONN = { provider: "calendly", connectionId: "c", providerConfigKey: "k" } as never;
const VAGARO_CONN = { provider: "vagaro", connectionId: "v", providerConfigKey: "vk" } as never;
const CALDAV_CONN = { provider: "caldav", connectionId: "d", providerConfigKey: "dk" } as never;

const RESCHEDULE_ARGS = {
  newStartIso: "2026-07-15T20:00:00.000Z",
  newEndIso: "2026-07-15T20:30:00.000Z",
  attendeePhone: PHONE
};

const CLAIM = { id: "claim-1", eventId: "evt-1", startAt: "2026-07-13T20:00:00Z" };

beforeEach(() => {
  vi.clearAllMocks();
  // Full reset (not just clear): clearAllMocks leaves mockResolvedValueOnce
  // queues intact, so a test that queues more responses than it consumes
  // would silently shift the next test's queue.
  vi.mocked(nangoProxyForBusiness).mockReset();
  vi.mocked(getSharedCalendar).mockResolvedValue(null);
  vi.mocked(findUpcomingBookingClaim).mockResolvedValue(null);
  vi.mocked(findUpcomingBookingClaimByPhone).mockResolvedValue(null);
});

describe("rescheduleCalendarAppointment", () => {
  it("rejects an inverted window before touching anything", async () => {
    const result = await rescheduleCalendarAppointment(BIZ, {
      ...RESCHEDULE_ARGS,
      newEndIso: RESCHEDULE_ARGS.newStartIso
    });
    expect(result).toEqual({ ok: false, detail: "invalid_window" });
    expect(vi.mocked(resolveCalendarConnection)).not.toHaveBeenCalled();
  });

  it("returns calendar_not_connected when no calendar is linked", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(null as never);
    expect(await rescheduleCalendarAppointment(BIZ, RESCHEDULE_ARGS)).toEqual({
      ok: false,
      detail: "calendar_not_connected"
    });
  });

  it("refuses CalDAV as not supported", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(CALDAV_CONN);
    expect(await rescheduleCalendarAppointment(BIZ, RESCHEDULE_ARGS)).toEqual({
      ok: false,
      detail: "reschedule_not_supported"
    });
    expect(vi.mocked(nangoProxyForBusiness)).not.toHaveBeenCalled();
  });

  it("Calendly: delegates to the reschedule-link core with the caller's identity", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(CALENDLY_CONN);
    const linkResult = {
      ok: true,
      detail: "reschedule_link_created",
      data: { rescheduleLink: "https://calendly.com/reschedulings/abc" }
    } as never;
    vi.mocked(createCalendlyRescheduleLink).mockResolvedValue(linkResult);

    expect(await rescheduleCalendarAppointment(BIZ, RESCHEDULE_ARGS)).toBe(linkResult);
    expect(vi.mocked(createCalendlyRescheduleLink)).toHaveBeenCalledWith(BIZ, CALENDLY_CONN, {
      phone: PHONE,
      email: null
    });
    expect(vi.mocked(nangoProxyForBusiness)).not.toHaveBeenCalled();
    // No ledger writes: Calendly link bookings never hold ledger rows.
    expect(vi.mocked(rescheduleBookingClaim)).not.toHaveBeenCalled();
  });

  it("Calendly: forwards the attendee email when provided", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(CALENDLY_CONN);
    vi.mocked(createCalendlyRescheduleLink).mockResolvedValue({
      ok: false,
      detail: "booking_not_found"
    } as never);
    await rescheduleCalendarAppointment(BIZ, {
      ...RESCHEDULE_ARGS,
      attendeeEmail: "joe@acme.com"
    });
    expect(vi.mocked(createCalendlyRescheduleLink)).toHaveBeenCalledWith(BIZ, CALENDLY_CONN, {
      phone: PHONE,
      email: "joe@acme.com"
    });
  });

  it("Vagaro: moves the ledger-resolved appointment and shifts the claim on success", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(VAGARO_CONN);
    vi.mocked(findUpcomingBookingClaim).mockResolvedValue(CLAIM);
    const moved = {
      ok: true,
      data: { eventId: "evt-1", provider: "vagaro", rescheduled: true }
    } as never;
    vi.mocked(rescheduleVagaroAppointment).mockResolvedValue(moved);

    expect(await rescheduleCalendarAppointment(BIZ, RESCHEDULE_ARGS)).toBe(moved);
    expect(vi.mocked(rescheduleVagaroAppointment)).toHaveBeenCalledWith(
      BIZ,
      "evt-1",
      RESCHEDULE_ARGS.newStartIso,
      RESCHEDULE_ARGS.newEndIso
    );
    expect(vi.mocked(rescheduleBookingClaim)).toHaveBeenCalledWith(
      BIZ,
      "phone:+15485773546",
      "claim-1",
      "2026-07-15T20:00:00.000Z"
    );
  });

  it("Vagaro: keeps the claim in place when the provider move fails", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(VAGARO_CONN);
    vi.mocked(findUpcomingBookingClaim).mockResolvedValue(CLAIM);
    vi.mocked(rescheduleVagaroAppointment).mockResolvedValue({
      ok: false,
      detail: "vagaro_auth_failed"
    } as never);
    expect(await rescheduleCalendarAppointment(BIZ, RESCHEDULE_ARGS)).toEqual({
      ok: false,
      detail: "vagaro_auth_failed"
    });
    expect(vi.mocked(rescheduleBookingClaim)).not.toHaveBeenCalled();
  });

  it("Vagaro: booking_not_found without a ledger claim (no provider search exists)", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(VAGARO_CONN);
    expect(await rescheduleCalendarAppointment(BIZ, RESCHEDULE_ARGS)).toEqual({
      ok: false,
      detail: "booking_not_found"
    });
    expect(vi.mocked(rescheduleVagaroAppointment)).not.toHaveBeenCalled();
    // The tolerant fallback ran (a phone exists) — it just found nothing.
    expect(vi.mocked(findUpcomingBookingClaimByPhone)).toHaveBeenCalledWith(BIZ, PHONE);
  });

  it("Vagaro: the phone-tolerant fallback resolves format drift and moves the ROW's key", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(VAGARO_CONN);
    // Exact key misses (booking stored a different phone shape) …
    vi.mocked(findUpcomingBookingClaim).mockResolvedValue(null);
    // … the digits-tolerant lookup finds the row, carrying ITS stored key.
    vi.mocked(findUpcomingBookingClaimByPhone).mockResolvedValue({
      ...CLAIM,
      attendeeKey: "phone:5485773546"
    });
    vi.mocked(rescheduleVagaroAppointment).mockResolvedValue({
      ok: true,
      data: { eventId: "evt-1" }
    } as never);

    expect((await rescheduleCalendarAppointment(BIZ, RESCHEDULE_ARGS)).ok).toBe(true);
    // Ledger move targets the key the row is stored under, not the caller's.
    expect(vi.mocked(rescheduleBookingClaim)).toHaveBeenCalledWith(
      BIZ,
      "phone:5485773546",
      "claim-1",
      "2026-07-15T20:00:00.000Z"
    );
  });

  it("Vagaro: no tolerant fallback without a phone (email-only identity)", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(VAGARO_CONN);
    expect(
      await rescheduleCalendarAppointment(BIZ, {
        newStartIso: RESCHEDULE_ARGS.newStartIso,
        newEndIso: RESCHEDULE_ARGS.newEndIso,
        attendeeEmail: "joe@acme.com"
      })
    ).toEqual({ ok: false, detail: "booking_not_found" });
    expect(vi.mocked(findUpcomingBookingClaimByPhone)).not.toHaveBeenCalled();
  });

  it("booking_not_found when neither the ledger nor the provider search locates an event", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(GOOGLE_CONN);
    vi.mocked(nangoProxyForBusiness).mockResolvedValue({ data: { items: [] } } as never);
    expect(await rescheduleCalendarAppointment(BIZ, RESCHEDULE_ARGS)).toEqual({
      ok: false,
      detail: "booking_not_found"
    });
  });

  it("booking_not_found with NO provider search when there is no phone/email marker", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(GOOGLE_CONN);
    const result = await rescheduleCalendarAppointment(BIZ, {
      newStartIso: RESCHEDULE_ARGS.newStartIso,
      newEndIso: RESCHEDULE_ARGS.newEndIso,
      attendeeName: "Joe"
    });
    expect(result).toEqual({ ok: false, detail: "booking_not_found" });
    expect(vi.mocked(nangoProxyForBusiness)).not.toHaveBeenCalled();
  });

  it("PATCHes the Google event from the ledger claim and moves the claim to the new start", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(GOOGLE_CONN);
    vi.mocked(findUpcomingBookingClaim).mockResolvedValue(CLAIM);
    vi.mocked(nangoProxyForBusiness).mockResolvedValue({ data: {} } as never);

    const result = await rescheduleCalendarAppointment(BIZ, RESCHEDULE_ARGS);
    expect(result).toEqual({
      ok: true,
      data: {
        eventId: "evt-1",
        provider: "google",
        startIso: "2026-07-15T20:00:00.000Z",
        endIso: "2026-07-15T20:30:00.000Z",
        rescheduled: true
      }
    });
    const [, , config] = vi.mocked(nangoProxyForBusiness).mock.calls[0];
    expect(config).toMatchObject({
      endpoint: "/calendar/v3/calendars/primary/events/evt-1",
      method: "PATCH",
      data: {
        start: { dateTime: "2026-07-15T20:00:00.000Z", timeZone: "America/New_York" },
        end: { dateTime: "2026-07-15T20:30:00.000Z", timeZone: "America/New_York" }
      }
    });
    expect(vi.mocked(rescheduleBookingClaim)).toHaveBeenCalledWith(
      BIZ,
      "phone:+15485773546",
      "claim-1",
      "2026-07-15T20:00:00.000Z"
    );
    expect(vi.mocked(recordExternalBookingClaim)).not.toHaveBeenCalled();
  });

  it("tries the shared NewCoworker calendar first, falling back to primary when it 404s", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(GOOGLE_CONN);
    vi.mocked(findUpcomingBookingClaim).mockResolvedValue(CLAIM);
    vi.mocked(getSharedCalendar).mockResolvedValue({ calendarId: "shared-cal" } as never);
    vi.mocked(nangoProxyForBusiness)
      .mockRejectedValueOnce(new Error("404 not found"))
      .mockResolvedValueOnce({ data: {} } as never);

    const result = await rescheduleCalendarAppointment(BIZ, RESCHEDULE_ARGS);
    expect(result.ok).toBe(true);
    const endpoints = vi
      .mocked(nangoProxyForBusiness)
      .mock.calls.map((c) => (c[2] as { endpoint: string }).endpoint);
    expect(endpoints).toEqual([
      "/calendar/v3/calendars/shared-cal/events/evt-1",
      "/calendar/v3/calendars/primary/events/evt-1"
    ]);
  });

  it("calendar_reschedule_failed when every Google calendar attempt fails", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(GOOGLE_CONN);
    vi.mocked(findUpcomingBookingClaim).mockResolvedValue(CLAIM);
    vi.mocked(nangoProxyForBusiness).mockRejectedValue(new Error("boom"));
    expect(await rescheduleCalendarAppointment(BIZ, RESCHEDULE_ARGS)).toEqual({
      ok: false,
      detail: "calendar_reschedule_failed"
    });
    expect(vi.mocked(rescheduleBookingClaim)).not.toHaveBeenCalled();
  });

  it("a null Google mutate response counts as a failed attempt (not a success)", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(GOOGLE_CONN);
    vi.mocked(findUpcomingBookingClaim).mockResolvedValue(CLAIM);
    vi.mocked(nangoProxyForBusiness).mockResolvedValue(null as never);
    expect(await rescheduleCalendarAppointment(BIZ, RESCHEDULE_ARGS)).toEqual({
      ok: false,
      detail: "calendar_reschedule_failed"
    });
  });

  it("PATCHes the Microsoft event with naive wall time and records an external claim for a searched event", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(MS_CONN);
    // Not in the ledger (pre-ledger booking) → provider search finds it via
    // the FULL body: long notes push the Phone: marker out of bodyPreview
    // (Graph truncates it), so the truncated preview alone must not decide.
    vi.mocked(nangoProxyForBusiness)
      .mockResolvedValueOnce({
        data: {
          value: [
            {
              id: "evt-search",
              bodyPreview: "Very long free-form notes that crowd out the marker…",
              body: {
                content: `<html>Very long notes…\nAttendee: Joe\nPhone: ${PHONE}</html>`
              }
            }
          ]
        }
      } as never)
      .mockResolvedValueOnce({ data: {} } as never);

    const result = await rescheduleCalendarAppointment(BIZ, RESCHEDULE_ARGS);
    expect(result.ok).toBe(true);
    expect((result.data as { eventId: string }).eventId).toBe("evt-search");
    const patchCall = vi.mocked(nangoProxyForBusiness).mock.calls[1][2] as {
      endpoint: string;
      method: string;
      data: { start: { dateTime: string; timeZone: string } };
    };
    expect(patchCall.endpoint).toBe("/v1.0/me/events/evt-search");
    expect(patchCall.method).toBe("PATCH");
    expect(patchCall.data.start.dateTime).toBe("wall(2026-07-15T20:00:00.000Z,America/New_York)");
    // A searched event may hold a ledger row under a DIFFERENT attendee key
    // (booked by phone, rescheduled by email): stale rows are dropped by
    // event id before the fresh claim is recorded.
    expect(vi.mocked(deleteBookingClaimsByEvent)).toHaveBeenCalledWith(BIZ, "evt-search");
    expect(vi.mocked(recordExternalBookingClaim)).toHaveBeenCalledWith(
      BIZ,
      "phone:+15485773546",
      "2026-07-15T20:00:00.000Z",
      "evt-search"
    );
  });

  it("Microsoft search scans the shared calendar view first and skips non-matching events", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(MS_CONN);
    vi.mocked(getSharedCalendar).mockResolvedValue({ calendarId: "shared-ms" } as never);
    vi.mocked(nangoProxyForBusiness)
      // Shared view: an event for someone else — no match (bodyPreview-only
      // rows still match when short enough; id-less rows are skipped).
      .mockResolvedValueOnce({
        data: { value: [{ id: "evt-other", bodyPreview: "Phone: +15550000000" }, { bodyPreview: PHONE }] }
      } as never)
      // Default view: the match.
      .mockResolvedValueOnce({
        data: { value: [{ id: "evt-mine", bodyPreview: `Phone: ${PHONE}` }] }
      } as never)
      .mockResolvedValueOnce({ data: {} } as never);

    const result = await rescheduleCalendarAppointment(BIZ, RESCHEDULE_ARGS);
    expect(result.ok).toBe(true);
    const endpoints = vi
      .mocked(nangoProxyForBusiness)
      .mock.calls.map((c) => (c[2] as { endpoint: string }).endpoint);
    expect(endpoints[0]).toBe("/v1.0/me/calendars/shared-ms/calendarView");
    expect(endpoints[1]).toBe("/v1.0/me/calendarView");
  });

  it("Microsoft search tolerates per-view failures and empty bodies", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(MS_CONN);
    vi.mocked(nangoProxyForBusiness)
      .mockRejectedValueOnce(new Error("view down"))
      .mockResolvedValueOnce(null as never);
    expect(await rescheduleCalendarAppointment(BIZ, RESCHEDULE_ARGS)).toEqual({
      ok: false,
      detail: "booking_not_found"
    });
  });

  it("Microsoft search tolerates non-Error throws, missing value arrays, and preview-less events", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(MS_CONN);
    vi.mocked(getSharedCalendar).mockResolvedValue({ calendarId: "shared-ms" } as never);
    vi.mocked(nangoProxyForBusiness)
      .mockRejectedValueOnce("raw view failure" as never) // shared view: non-Error throw
      .mockResolvedValueOnce({ data: { value: [{ id: "evt-no-preview" }] } } as never); // no bodyPreview → no match
    expect(await rescheduleCalendarAppointment(BIZ, RESCHEDULE_ARGS)).toEqual({
      ok: false,
      detail: "booking_not_found"
    });

    vi.mocked(getSharedCalendar).mockResolvedValue(null);
    vi.mocked(nangoProxyForBusiness).mockReset();
    vi.mocked(nangoProxyForBusiness).mockResolvedValueOnce({ data: {} } as never); // no value key
    expect(await rescheduleCalendarAppointment(BIZ, RESCHEDULE_ARGS)).toEqual({
      ok: false,
      detail: "booking_not_found"
    });

    vi.mocked(nangoProxyForBusiness).mockReset();
    vi.mocked(nangoProxyForBusiness).mockResolvedValueOnce({ data: undefined } as never); // response without data
    expect(await rescheduleCalendarAppointment(BIZ, RESCHEDULE_ARGS)).toEqual({
      ok: false,
      detail: "booking_not_found"
    });
  });

  it("Google search tolerates null responses, missing items, and non-Error throws", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(GOOGLE_CONN);
    vi.mocked(getSharedCalendar).mockResolvedValue({ calendarId: "shared-cal" } as never);
    vi.mocked(nangoProxyForBusiness)
      .mockResolvedValueOnce(null as never) // shared search: null response
      .mockResolvedValueOnce({ data: undefined } as never); // primary: response without data
    expect(await rescheduleCalendarAppointment(BIZ, RESCHEDULE_ARGS)).toEqual({
      ok: false,
      detail: "booking_not_found"
    });

    vi.mocked(nangoProxyForBusiness).mockReset();
    vi.mocked(getSharedCalendar).mockResolvedValue(null);
    vi.mocked(nangoProxyForBusiness).mockRejectedValueOnce("raw search failure" as never);
    expect(await rescheduleCalendarAppointment(BIZ, RESCHEDULE_ARGS)).toEqual({
      ok: false,
      detail: "booking_not_found"
    });
  });

  it("Google mutate tolerates a non-Error throw on one calendar attempt", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(GOOGLE_CONN);
    vi.mocked(findUpcomingBookingClaim).mockResolvedValue(CLAIM);
    vi.mocked(getSharedCalendar).mockResolvedValue({ calendarId: "shared-cal" } as never);
    vi.mocked(nangoProxyForBusiness)
      .mockRejectedValueOnce("raw patch failure" as never)
      .mockResolvedValueOnce({ data: {} } as never);
    expect((await rescheduleCalendarAppointment(BIZ, RESCHEDULE_ARGS)).ok).toBe(true);
  });

  it("a null Microsoft PATCH response is a FAILED MUTATION, never calendar_not_connected", async () => {
    // The connection resolved moments earlier — misreporting it as missing
    // would steer the model to "you cannot change any appointment".
    vi.mocked(resolveCalendarConnection).mockResolvedValue(MS_CONN);
    vi.mocked(findUpcomingBookingClaim).mockResolvedValue(CLAIM);
    vi.mocked(nangoProxyForBusiness).mockResolvedValue(null as never);
    expect(await rescheduleCalendarAppointment(BIZ, RESCHEDULE_ARGS)).toEqual({
      ok: false,
      detail: "calendar_reschedule_failed"
    });
  });

  it("marker matching is boundary-guarded: a longer number or wrapping email never matches", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(MS_CONN);
    vi.mocked(nangoProxyForBusiness).mockResolvedValueOnce({
      data: {
        value: [
          // The lead's E.164 as a PREFIX of a longer number — not a match.
          { id: "evt-longer", bodyPreview: `Phone: ${PHONE}789` },
          // The email marker inside a longer address — not a match either.
          { id: "evt-wrapped", bodyPreview: "Email: notjoe@acme.com" }
        ]
      }
    } as never);
    expect(await rescheduleCalendarAppointment(BIZ, RESCHEDULE_ARGS)).toEqual({
      ok: false,
      detail: "booking_not_found"
    });
  });

  it("Google search falls back to the email marker and tolerates search errors", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(GOOGLE_CONN);
    vi.mocked(getSharedCalendar).mockResolvedValue({ calendarId: "shared-cal" } as never);
    vi.mocked(nangoProxyForBusiness)
      .mockRejectedValueOnce(new Error("search boom")) // shared search fails
      .mockResolvedValueOnce({
        // Primary search: a loose q hit WITHOUT the marker in its description
        // must be rejected; only the verified event wins.
        data: {
          items: [
            { id: "evt-fuzzy", description: "unrelated event that q matched loosely" },
            { id: "evt-bare" }, // no description at all — also rejected
            // Stored with the form's original casing; the lowercased marker
            // must still match (case-insensitive verification).
            { id: "evt-mail", description: "Attendee: Joe\nEmail: Joe@Acme.com" }
          ]
        }
      } as never)
      .mockResolvedValueOnce({ data: {} } as never); // PATCH shared succeeds

    const result = await rescheduleCalendarAppointment(BIZ, {
      newStartIso: RESCHEDULE_ARGS.newStartIso,
      newEndIso: RESCHEDULE_ARGS.newEndIso,
      attendeeEmail: "joe@acme.com"
    });
    expect(result.ok).toBe(true);
    const searchCall = vi.mocked(nangoProxyForBusiness).mock.calls[1][2] as unknown as {
      params: { q: string };
    };
    expect(searchCall.params.q).toBe("joe@acme.com");
    // The unverified fuzzy hit lost; the marker-verified event was mutated.
    const patchCall = vi.mocked(nangoProxyForBusiness).mock.calls[2][2] as { endpoint: string };
    expect(patchCall.endpoint).toContain("evt-mail");
    expect(patchCall.endpoint).not.toContain("evt-fuzzy");
  });

  it("uses the surface fallback phone when the model omits attendee identity", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(MS_CONN);
    vi.mocked(findUpcomingBookingClaim).mockResolvedValue(CLAIM);
    vi.mocked(nangoProxyForBusiness).mockResolvedValue({ data: {} } as never);
    const result = await rescheduleCalendarAppointment(
      BIZ,
      { newStartIso: RESCHEDULE_ARGS.newStartIso, newEndIso: RESCHEDULE_ARGS.newEndIso },
      PHONE
    );
    expect(result.ok).toBe(true);
  });

  it("maps unexpected throws (Error and non-Error) to calendar_reschedule_failed", async () => {
    vi.mocked(resolveCalendarConnection).mockRejectedValue(new Error("resolver down"));
    expect((await rescheduleCalendarAppointment(BIZ, RESCHEDULE_ARGS)).detail).toBe(
      "calendar_reschedule_failed"
    );
    vi.mocked(resolveCalendarConnection).mockRejectedValue("string failure");
    expect((await rescheduleCalendarAppointment(BIZ, RESCHEDULE_ARGS)).detail).toBe(
      "calendar_reschedule_failed"
    );
  });
});

describe("cancelCalendarAppointment", () => {
  const CANCEL_ARGS = { attendeePhone: PHONE };

  it("returns calendar_not_connected when no calendar is linked", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(null as never);
    expect(await cancelCalendarAppointment(BIZ, CANCEL_ARGS)).toEqual({
      ok: false,
      detail: "calendar_not_connected"
    });
  });

  it("refuses CalDAV as not supported", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(CALDAV_CONN);
    expect(await cancelCalendarAppointment(BIZ, CANCEL_ARGS)).toEqual({
      ok: false,
      detail: "cancel_not_supported"
    });
  });

  it("Calendly: delegates to the API-side cancellation core", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(CALENDLY_CONN);
    const canceled = {
      ok: true,
      data: { eventId: "uuid-1", provider: "calendly", canceled: true }
    } as never;
    vi.mocked(cancelCalendlyAppointment).mockResolvedValue(canceled);

    expect(await cancelCalendarAppointment(BIZ, { ...CANCEL_ARGS, attendeeEmail: "joe@acme.com" })).toBe(
      canceled
    );
    expect(vi.mocked(cancelCalendlyAppointment)).toHaveBeenCalledWith(BIZ, CALENDLY_CONN, {
      phone: PHONE,
      email: "joe@acme.com"
    });
    expect(vi.mocked(nangoProxyForBusiness)).not.toHaveBeenCalled();
  });

  it("Calendly: null email when the model omits it", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(CALENDLY_CONN);
    vi.mocked(cancelCalendlyAppointment).mockResolvedValue({
      ok: false,
      detail: "booking_not_found"
    } as never);
    await cancelCalendarAppointment(BIZ, CANCEL_ARGS);
    expect(vi.mocked(cancelCalendlyAppointment)).toHaveBeenCalledWith(BIZ, CALENDLY_CONN, {
      phone: PHONE,
      email: null
    });
  });

  it("Vagaro: cancels the ledger-resolved appointment and drops the claim", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(VAGARO_CONN);
    vi.mocked(findUpcomingBookingClaim).mockResolvedValue(CLAIM);
    const canceled = {
      ok: true,
      data: { eventId: "evt-1", provider: "vagaro", canceled: true }
    } as never;
    vi.mocked(cancelVagaroAppointment).mockResolvedValue(canceled);

    expect(await cancelCalendarAppointment(BIZ, CANCEL_ARGS)).toBe(canceled);
    expect(vi.mocked(cancelVagaroAppointment)).toHaveBeenCalledWith(BIZ, "evt-1");
    expect(vi.mocked(deleteBookingClaim)).toHaveBeenCalledWith("claim-1");
  });

  it("Vagaro: keeps the claim when the provider cancel fails", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(VAGARO_CONN);
    vi.mocked(findUpcomingBookingClaim).mockResolvedValue(CLAIM);
    vi.mocked(cancelVagaroAppointment).mockResolvedValue({
      ok: false,
      detail: "calendar_cancel_failed"
    } as never);
    expect(await cancelCalendarAppointment(BIZ, CANCEL_ARGS)).toEqual({
      ok: false,
      detail: "calendar_cancel_failed"
    });
    expect(vi.mocked(deleteBookingClaim)).not.toHaveBeenCalled();
  });

  it("Vagaro: booking_not_found without a ledger claim", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(VAGARO_CONN);
    expect(await cancelCalendarAppointment(BIZ, CANCEL_ARGS)).toEqual({
      ok: false,
      detail: "booking_not_found"
    });
    expect(vi.mocked(cancelVagaroAppointment)).not.toHaveBeenCalled();
  });

  it("Vagaro: the phone-tolerant fallback resolves format drift on cancel", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(VAGARO_CONN);
    vi.mocked(findUpcomingBookingClaimByPhone).mockResolvedValue({
      ...CLAIM,
      attendeeKey: "phone:5485773546"
    });
    vi.mocked(cancelVagaroAppointment).mockResolvedValue({ ok: true } as never);
    expect((await cancelCalendarAppointment(BIZ, CANCEL_ARGS)).ok).toBe(true);
    expect(vi.mocked(cancelVagaroAppointment)).toHaveBeenCalledWith(BIZ, "evt-1");
    expect(vi.mocked(deleteBookingClaim)).toHaveBeenCalledWith("claim-1");
  });

  it("booking_not_found when nothing locates the event", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(GOOGLE_CONN);
    vi.mocked(nangoProxyForBusiness).mockResolvedValue({ data: { items: [] } } as never);
    expect(await cancelCalendarAppointment(BIZ, CANCEL_ARGS)).toEqual({
      ok: false,
      detail: "booking_not_found"
    });
  });

  it("falls back to the email marker, the surface phone, or refuses with no identity at all", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(MS_CONN);
    vi.mocked(findUpcomingBookingClaim).mockResolvedValue(CLAIM);
    vi.mocked(nangoProxyForBusiness).mockResolvedValue({ data: {} } as never);
    // Email-only identity: still resolves via the ledger key.
    expect((await cancelCalendarAppointment(BIZ, { attendeeEmail: "joe@acme.com" })).ok).toBe(true);
    // No model-provided identity: the surface fallback phone carries it.
    expect((await cancelCalendarAppointment(BIZ, {}, PHONE)).ok).toBe(true);

    // No identity at all: no ledger row, no searchable marker → not found.
    vi.mocked(findUpcomingBookingClaim).mockResolvedValue(null);
    expect(await cancelCalendarAppointment(BIZ, {})).toEqual({
      ok: false,
      detail: "booking_not_found"
    });
    expect(await cancelCalendarAppointment(BIZ, { attendeeName: "Joe" })).toEqual({
      ok: false,
      detail: "booking_not_found"
    });
  });

  it("DELETEs the Google event and drops the ledger claim", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(GOOGLE_CONN);
    vi.mocked(findUpcomingBookingClaim).mockResolvedValue(CLAIM);
    vi.mocked(nangoProxyForBusiness).mockResolvedValue({ data: {} } as never);

    const result = await cancelCalendarAppointment(BIZ, CANCEL_ARGS);
    expect(result).toEqual({
      ok: true,
      data: { eventId: "evt-1", provider: "google", canceled: true }
    });
    const [, , config] = vi.mocked(nangoProxyForBusiness).mock.calls[0];
    expect(config).toMatchObject({
      endpoint: "/calendar/v3/calendars/primary/events/evt-1",
      method: "DELETE"
    });
    expect(vi.mocked(deleteBookingClaim)).toHaveBeenCalledWith("claim-1");
  });

  it("calendar_cancel_failed when every Google delete attempt fails (claim kept)", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(GOOGLE_CONN);
    vi.mocked(findUpcomingBookingClaim).mockResolvedValue(CLAIM);
    vi.mocked(nangoProxyForBusiness).mockRejectedValue(new Error("boom"));
    expect(await cancelCalendarAppointment(BIZ, CANCEL_ARGS)).toEqual({
      ok: false,
      detail: "calendar_cancel_failed"
    });
    expect(vi.mocked(deleteBookingClaim)).not.toHaveBeenCalled();
  });

  it("DELETEs the Microsoft event; a searched (ledger-less) event cleans the ledger BY EVENT ID", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(MS_CONN);
    vi.mocked(nangoProxyForBusiness)
      .mockResolvedValueOnce({
        data: { value: [{ id: "evt-search", bodyPreview: `Phone: ${PHONE}` }] }
      } as never)
      .mockResolvedValueOnce({ data: {} } as never);

    const result = await cancelCalendarAppointment(BIZ, CANCEL_ARGS);
    expect(result).toEqual({
      ok: true,
      data: { eventId: "evt-search", provider: "microsoft", canceled: true }
    });
    const deleteCall = vi.mocked(nangoProxyForBusiness).mock.calls[1][2] as {
      endpoint: string;
      method: string;
    };
    expect(deleteCall).toMatchObject({ endpoint: "/v1.0/me/events/evt-search", method: "DELETE" });
    // No claim under OUR key, but the event may hold rows under other keys —
    // a canceled slot must not survive as "booked" in the ledger.
    expect(vi.mocked(deleteBookingClaim)).not.toHaveBeenCalled();
    expect(vi.mocked(deleteBookingClaimsByEvent)).toHaveBeenCalledWith(BIZ, "evt-search");
  });

  it("a null Microsoft DELETE response is a FAILED MUTATION, never calendar_not_connected", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(MS_CONN);
    vi.mocked(findUpcomingBookingClaim).mockResolvedValue(CLAIM);
    vi.mocked(nangoProxyForBusiness).mockResolvedValue(null as never);
    expect(await cancelCalendarAppointment(BIZ, CANCEL_ARGS)).toEqual({
      ok: false,
      detail: "calendar_cancel_failed"
    });
  });

  it("maps unexpected throws (Error and non-Error) to calendar_cancel_failed", async () => {
    vi.mocked(resolveCalendarConnection).mockRejectedValue(new Error("resolver down"));
    expect((await cancelCalendarAppointment(BIZ, CANCEL_ARGS)).detail).toBe(
      "calendar_cancel_failed"
    );
    vi.mocked(resolveCalendarConnection).mockRejectedValue("string failure");
    expect((await cancelCalendarAppointment(BIZ, CANCEL_ARGS)).detail).toBe(
      "calendar_cancel_failed"
    );
  });
});
