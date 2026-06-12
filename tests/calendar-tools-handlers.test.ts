/**
 * Direct tests for the shared calendar cores
 * (src/lib/calendar-tools/handlers.ts) used by the voice adapters and the
 * Rowboat tool webhook.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/voice-tools/connections", () => ({ resolveCalendarConnection: vi.fn() }));
vi.mock("@/lib/nango/workspace", () => ({ nangoProxyForBusiness: vi.fn() }));
vi.mock("@/lib/db/businesses", () => ({ getBusinessTimezone: vi.fn() }));

import {
  bookCalendarAppointment,
  computeFreeSlots,
  findCalendarSlots
} from "@/lib/calendar-tools/handlers";
import { resolveCalendarConnection } from "@/lib/voice-tools/connections";
import { nangoProxyForBusiness } from "@/lib/nango/workspace";
import { getBusinessTimezone } from "@/lib/db/businesses";

const BIZ = "11111111-1111-4111-8111-111111111111";

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

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getBusinessTimezone).mockResolvedValue(null);
});

describe("computeFreeSlots", () => {
  const t = (h: number) => new Date(Date.UTC(2026, 5, 12, h, 0, 0));
  const HOUR = 60 * 60 * 1000;

  it("finds gaps between busy blocks and caps at maxSlots", () => {
    const busy = [
      { start: t(10), end: t(11) },
      { start: t(12), end: t(13) },
      { start: t(14), end: t(15) },
      { start: t(16), end: t(17) }
    ];
    const slots = computeFreeSlots(t(9), t(20), busy, HOUR, 3);
    expect(slots).toEqual([
      { startIso: t(9).toISOString(), endIso: t(10).toISOString() },
      { startIso: t(11).toISOString(), endIso: t(12).toISOString() },
      { startIso: t(13).toISOString(), endIso: t(14).toISOString() }
    ]);
  });

  it("skips blocks outside the window and already-passed blocks", () => {
    const busy = [
      { start: t(1), end: t(2) }, // ends before windowStart cursor
      { start: t(21), end: t(22) } // starts after windowEnd
    ];
    const slots = computeFreeSlots(t(9), t(20), busy, HOUR);
    // Whole window is free → one leading slot from the cursor.
    expect(slots[0]).toEqual({ startIso: t(9).toISOString(), endIso: t(10).toISOString() });
  });

  it("appends the tail slot only when enough room remains", () => {
    const busy = [{ start: t(9), end: t(19) }];
    expect(computeFreeSlots(t(9), t(20), busy, HOUR)).toEqual([
      { startIso: t(19).toISOString(), endIso: t(20).toISOString() }
    ]);
    expect(computeFreeSlots(t(9), t(20), busy, 2 * HOUR)).toEqual([]);
  });

  it("does not move the cursor backwards across overlapping blocks", () => {
    const busy = [
      { start: t(9), end: t(12) },
      { start: t(10), end: t(11) } // nested inside the first block
    ];
    const slots = computeFreeSlots(t(9), t(20), busy, HOUR, 1);
    expect(slots).toEqual([{ startIso: t(12).toISOString(), endIso: t(13).toISOString() }]);
  });
});

describe("findCalendarSlots", () => {
  it("rejects an inverted window", async () => {
    const result = await findCalendarSlots(BIZ, {
      earliest: "2026-06-12T10:00:00.000Z",
      latest: "2026-06-12T09:00:00.000Z",
      durationMinutes: 30
    });
    expect(result).toEqual({ ok: false, detail: "invalid_window" });
    expect(vi.mocked(resolveCalendarConnection)).not.toHaveBeenCalled();
  });

  it("returns calendar_not_connected when no calendar is linked", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(null as never);
    const result = await findCalendarSlots(BIZ, { durationMinutes: 30 });
    expect(result).toEqual({ ok: false, detail: "calendar_not_connected" });
  });

  it("computes slots from Google FreeBusy", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(GOOGLE_CONN);
    vi.mocked(nangoProxyForBusiness).mockResolvedValue({
      data: {
        calendars: {
          primary: {
            busy: [{ start: "2026-06-12T10:00:00.000Z", end: "2026-06-12T11:00:00.000Z" }]
          }
        }
      }
    } as never);
    const result = await findCalendarSlots(BIZ, {
      earliest: "2026-06-12T09:00:00.000Z",
      latest: "2026-06-12T12:00:00.000Z",
      durationMinutes: 60,
      timezone: "America/Phoenix",
      purpose: "estimate"
    });
    expect(result.ok).toBe(true);
    const data = result.data as { slots: unknown[]; timezone: string; purpose: string };
    expect(data.slots).toHaveLength(2);
    expect(data.timezone).toBe("America/Phoenix");
    expect(data.purpose).toBe("estimate");
    expect(vi.mocked(nangoProxyForBusiness)).toHaveBeenCalledWith(
      BIZ,
      { connectionId: "conn-1", providerConfigKey: "google-calendar" },
      expect.objectContaining({ endpoint: "/calendar/v3/freeBusy" })
    );
  });

  it("tolerates a FreeBusy body without the primary calendar", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(GOOGLE_CONN);
    vi.mocked(nangoProxyForBusiness).mockResolvedValue({ data: {} } as never);
    const result = await findCalendarSlots(BIZ, {
      earliest: "2026-06-12T09:00:00.000Z",
      latest: "2026-06-12T12:00:00.000Z",
      durationMinutes: 30
    });
    expect(result.ok).toBe(true);
    expect((result.data as { slots: unknown[] }).slots.length).toBeGreaterThan(0);
  });

  it("treats a null Google proxy response as not connected", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(GOOGLE_CONN);
    vi.mocked(nangoProxyForBusiness).mockResolvedValue(null as never);
    const result = await findCalendarSlots(BIZ, { durationMinutes: 30 });
    expect(result).toEqual({ ok: false, detail: "calendar_not_connected" });
  });

  it("computes slots from Microsoft getSchedule, filtering malformed items", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(MS_CONN);
    vi.mocked(nangoProxyForBusiness).mockResolvedValue({
      data: {
        value: [
          {
            scheduleItems: [
              {
                start: { dateTime: "2026-06-12T10:00:00.000Z" },
                end: { dateTime: "2026-06-12T11:00:00.000Z" }
              },
              { start: { dateTime: "2026-06-12T13:00:00.000Z" } } // missing end → dropped
            ]
          }
        ]
      }
    } as never);
    const result = await findCalendarSlots(BIZ, {
      earliest: "2026-06-12T09:00:00.000Z",
      latest: "2026-06-12T12:00:00.000Z",
      durationMinutes: 60
    });
    expect(result.ok).toBe(true);
    expect((result.data as { slots: unknown[] }).slots).toHaveLength(2);
    expect(vi.mocked(nangoProxyForBusiness)).toHaveBeenCalledWith(
      BIZ,
      { connectionId: "conn-2", providerConfigKey: "microsoft-calendar" },
      expect.objectContaining({ endpoint: "/v1.0/me/calendar/getSchedule" })
    );
  });

  it("tolerates an empty Graph schedule body", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(MS_CONN);
    vi.mocked(nangoProxyForBusiness).mockResolvedValue({ data: {} } as never);
    const result = await findCalendarSlots(BIZ, { durationMinutes: 30 });
    expect(result.ok).toBe(true);
  });

  it("treats a null Microsoft proxy response as not connected", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(MS_CONN);
    vi.mocked(nangoProxyForBusiness).mockResolvedValue(null as never);
    const result = await findCalendarSlots(BIZ, { durationMinutes: 30 });
    expect(result).toEqual({ ok: false, detail: "calendar_not_connected" });
  });

  it("falls back to the default window for malformed earliest/latest strings", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(GOOGLE_CONN);
    vi.mocked(nangoProxyForBusiness).mockResolvedValue({ data: {} } as never);
    const result = await findCalendarSlots(BIZ, {
      earliest: "not a date",
      latest: "also not a date",
      durationMinutes: 30
    });
    expect(result.ok).toBe(true);
  });

  it("maps proxy failures to calendar_lookup_failed", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(GOOGLE_CONN);
    vi.mocked(nangoProxyForBusiness).mockRejectedValue(new Error("nango 502"));
    const result = await findCalendarSlots(BIZ, { durationMinutes: 30 });
    expect(result).toEqual({ ok: false, detail: "calendar_lookup_failed" });
  });

  it("defaults the echoed timezone to the business timezone when the model omits one", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(GOOGLE_CONN);
    vi.mocked(nangoProxyForBusiness).mockResolvedValue({ data: {} } as never);
    vi.mocked(getBusinessTimezone).mockResolvedValue("America/Denver");
    const result = await findCalendarSlots(BIZ, { durationMinutes: 30 });
    expect(result.ok).toBe(true);
    expect((result.data as { timezone: string }).timezone).toBe("America/Denver");
  });

  it("degrades the timezone default to UTC when the business lookup throws", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(GOOGLE_CONN);
    vi.mocked(nangoProxyForBusiness).mockResolvedValue({ data: {} } as never);
    vi.mocked(getBusinessTimezone).mockRejectedValue(new Error("db down"));
    const result = await findCalendarSlots(BIZ, { durationMinutes: 30 });
    expect(result.ok).toBe(true);
    expect((result.data as { timezone: string }).timezone).toBe("UTC");
  });

  it("echoes UTC when neither the model nor the business provides a timezone", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(GOOGLE_CONN);
    vi.mocked(nangoProxyForBusiness).mockResolvedValue({ data: {} } as never);
    const result = await findCalendarSlots(BIZ, { durationMinutes: 30 });
    expect(result.ok).toBe(true);
    expect((result.data as { timezone: string }).timezone).toBe("UTC");
  });

  it("tolerates non-Error throw values in the failure log", async () => {
    vi.mocked(resolveCalendarConnection).mockRejectedValue("string failure");
    const result = await findCalendarSlots(BIZ, { durationMinutes: 30 });
    expect(result).toEqual({ ok: false, detail: "calendar_lookup_failed" });
  });
});

describe("bookCalendarAppointment", () => {
  const ARGS = {
    startIso: "2026-06-12T17:00:00.000Z",
    endIso: "2026-06-12T17:30:00.000Z",
    summary: "Estimate",
    attendeeName: "Joe Plumber"
  };

  it("rejects an inverted window", async () => {
    const result = await bookCalendarAppointment(BIZ, {
      ...ARGS,
      endIso: ARGS.startIso
    });
    expect(result).toEqual({ ok: false, detail: "invalid_window" });
    expect(vi.mocked(resolveCalendarConnection)).not.toHaveBeenCalled();
  });

  it("returns calendar_not_connected when no calendar is linked", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(null as never);
    const result = await bookCalendarAppointment(BIZ, ARGS);
    expect(result).toEqual({ ok: false, detail: "calendar_not_connected" });
  });

  it("books a Google event with attendee email + caller-phone fallback", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(GOOGLE_CONN);
    vi.mocked(nangoProxyForBusiness).mockResolvedValue({
      data: { id: "ev-1", htmlLink: "https://cal/ev-1" }
    } as never);
    const result = await bookCalendarAppointment(
      BIZ,
      { ...ARGS, attendeeEmail: "joe@example.com", notes: "gate code 1234", timezone: "America/Phoenix" },
      "+15551230000"
    );
    expect(result).toEqual({
      ok: true,
      data: { eventId: "ev-1", htmlLink: "https://cal/ev-1", provider: "google" }
    });
    const payload = vi.mocked(nangoProxyForBusiness).mock.calls[0][2] as {
      endpoint: string;
      data: { description: string; attendees: unknown[]; start: { timeZone: string } };
    };
    expect(payload.endpoint).toBe("/calendar/v3/calendars/primary/events");
    expect(payload.data.description).toContain("gate code 1234");
    expect(payload.data.description).toContain("Phone: +15551230000");
    expect(payload.data.description).toContain("Email: joe@example.com");
    expect(payload.data.attendees).toEqual([
      { email: "joe@example.com", displayName: "Joe Plumber" }
    ]);
    expect(payload.data.start.timeZone).toBe("America/Phoenix");
  });

  it("prefers the explicit attendeePhone over the fallback", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(GOOGLE_CONN);
    vi.mocked(nangoProxyForBusiness).mockResolvedValue({ data: { id: "ev-2" } } as never);
    await bookCalendarAppointment(BIZ, { ...ARGS, attendeePhone: "+15559998888" }, "+15551230000");
    const payload = vi.mocked(nangoProxyForBusiness).mock.calls[0][2] as {
      data: { description: string };
    };
    expect(payload.data.description).toContain("Phone: +15559998888");
    expect(payload.data.description).not.toContain("+15551230000");
  });

  it("books without any phone when neither args nor fallback provide one", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(GOOGLE_CONN);
    vi.mocked(nangoProxyForBusiness).mockResolvedValue({ data: {} } as never);
    const result = await bookCalendarAppointment(BIZ, ARGS);
    expect(result).toEqual({
      ok: true,
      data: { eventId: null, htmlLink: null, provider: "google" }
    });
    const payload = vi.mocked(nangoProxyForBusiness).mock.calls[0][2] as {
      data: { description: string; attendees?: unknown };
    };
    expect(payload.data.description).toBe("Attendee: Joe Plumber");
    expect(payload.data.attendees).toBeUndefined();
  });

  it("treats a null Google proxy response as not connected", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(GOOGLE_CONN);
    vi.mocked(nangoProxyForBusiness).mockResolvedValue(null as never);
    const result = await bookCalendarAppointment(BIZ, ARGS);
    expect(result).toEqual({ ok: false, detail: "calendar_not_connected" });
  });

  it("books in the business timezone when the model omits one", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(GOOGLE_CONN);
    vi.mocked(nangoProxyForBusiness).mockResolvedValue({ data: { id: "ev-tz" } } as never);
    vi.mocked(getBusinessTimezone).mockResolvedValue("America/Chicago");
    await bookCalendarAppointment(BIZ, ARGS);
    const payload = vi.mocked(nangoProxyForBusiness).mock.calls[0][2] as {
      data: { start: { timeZone: string }; end: { timeZone: string } };
    };
    expect(payload.data.start.timeZone).toBe("America/Chicago");
    expect(payload.data.end.timeZone).toBe("America/Chicago");
  });

  it("books a Microsoft event, falling back to the summary for an empty body", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(MS_CONN);
    vi.mocked(nangoProxyForBusiness).mockResolvedValue({
      data: { id: "ms-1", webLink: "https://outlook/ms-1" }
    } as never);
    const result = await bookCalendarAppointment(BIZ, {
      ...ARGS,
      attendeeEmail: "joe@example.com"
    });
    expect(result).toEqual({
      ok: true,
      data: { eventId: "ms-1", htmlLink: "https://outlook/ms-1", provider: "microsoft" }
    });
    const payload = vi.mocked(nangoProxyForBusiness).mock.calls[0][2] as {
      endpoint: string;
      data: { attendees: unknown[] };
    };
    expect(payload.endpoint).toBe("/v1.0/me/events");
    expect(payload.data.attendees).toEqual([
      {
        emailAddress: { address: "joe@example.com", name: "Joe Plumber" },
        type: "required"
      }
    ]);
  });

  it("handles a Microsoft response missing id/webLink and omitted attendees", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(MS_CONN);
    vi.mocked(nangoProxyForBusiness).mockResolvedValue({ data: {} } as never);
    const result = await bookCalendarAppointment(BIZ, ARGS);
    expect(result).toEqual({
      ok: true,
      data: { eventId: null, htmlLink: null, provider: "microsoft" }
    });
    const payload = vi.mocked(nangoProxyForBusiness).mock.calls[0][2] as {
      data: { attendees?: unknown };
    };
    expect(payload.data.attendees).toBeUndefined();
  });

  it("treats a null Microsoft proxy response as not connected", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(MS_CONN);
    vi.mocked(nangoProxyForBusiness).mockResolvedValue(null as never);
    const result = await bookCalendarAppointment(BIZ, ARGS);
    expect(result).toEqual({ ok: false, detail: "calendar_not_connected" });
  });

  it("maps proxy failures to calendar_book_failed", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(GOOGLE_CONN);
    vi.mocked(nangoProxyForBusiness).mockRejectedValue(new Error("nango 502"));
    const result = await bookCalendarAppointment(BIZ, ARGS);
    expect(result).toEqual({ ok: false, detail: "calendar_book_failed" });
  });

  it("tolerates non-Error throw values in the failure log", async () => {
    vi.mocked(resolveCalendarConnection).mockRejectedValue("string failure");
    const result = await bookCalendarAppointment(BIZ, ARGS);
    expect(result).toEqual({ ok: false, detail: "calendar_book_failed" });
  });
});
