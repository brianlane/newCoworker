import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/booking-page/db", () => ({
  getEnabledBookingPageByToken: vi.fn(),
  countBookingsBetween: vi.fn()
}));
vi.mock("@/lib/voice-tools/connections", () => ({ resolveCalendarConnection: vi.fn() }));
vi.mock("@/lib/calendar-tools/handlers", () => ({
  bookCalendarAppointment: vi.fn(),
  getWorkspaceBusyBlocks: vi.fn()
}));
vi.mock("@/lib/calendar-tools/caldav", () => ({ getCaldavBusyBlocks: vi.fn() }));
vi.mock("@/lib/db/businesses", () => ({ getBusiness: vi.fn() }));
vi.mock("@/lib/db/employees", () => ({ listTeamMembers: vi.fn(), listTimeOff: vi.fn() }));
vi.mock("@/lib/db/zoom-connections", () => ({ getActiveZoomConnectionId: vi.fn() }));
vi.mock("@/lib/customer-memory/capture-contact", () => ({ ensureCapturedContact: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServiceClient: vi.fn() }));
vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() }
}));

import {
  BOOKING_PAGE_SOURCE_TAG,
  getBookingPageContext,
  listPublicSlots,
  submitPublicBooking
} from "@/lib/booking-page/service";
import { getEnabledBookingPageByToken } from "@/lib/booking-page/db";
import { resolveCalendarConnection } from "@/lib/voice-tools/connections";
import {
  bookCalendarAppointment,
  getWorkspaceBusyBlocks
} from "@/lib/calendar-tools/handlers";
import { getCaldavBusyBlocks } from "@/lib/calendar-tools/caldav";
import { getBusiness } from "@/lib/db/businesses";
import { listTeamMembers, listTimeOff } from "@/lib/db/employees";
import { getActiveZoomConnectionId } from "@/lib/db/zoom-connections";
import { ensureCapturedContact } from "@/lib/customer-memory/capture-contact";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { logger } from "@/lib/logger";

const BIZ = "11111111-1111-4111-8111-111111111111";
const TOKEN = "ncb_" + "a".repeat(64);
// Monday 09:00 in America/Phoenix (UTC-7, no DST).
const NOW = new Date("2026-01-05T16:00:00Z");

const PAGE = {
  id: "page-1",
  business_id: BIZ,
  token: TOKEN,
  enabled: true,
  allowed_durations: [15, 30],
  min_notice_minutes: 0,
  max_advance_days: 0,
  buffer_minutes: 0,
  max_daily_bookings: null as number | null,
  require_staff_on_shift: false,
  description: "Strategy call",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z"
};

const BUSINESS = {
  id: BIZ,
  name: "Acme Plumbing",
  timezone: "America/Phoenix",
  business_hours: { mon: { open: "09:00", close: "17:00" } }
} as never;

const GOOGLE = { provider: "google", connectionId: "c1", providerConfigKey: "google" } as never;

const mockPage = vi.mocked(getEnabledBookingPageByToken);
const mockConn = vi.mocked(resolveCalendarConnection);
const mockBusy = vi.mocked(getWorkspaceBusyBlocks);
const mockCaldav = vi.mocked(getCaldavBusyBlocks);
const mockBusiness = vi.mocked(getBusiness);
const mockZoom = vi.mocked(getActiveZoomConnectionId);
const mockBook = vi.mocked(bookCalendarAppointment);
const mockCapture = vi.mocked(ensureCapturedContact);
const mockMembers = vi.mocked(listTeamMembers);
const mockTimeOff = vi.mocked(listTimeOff);
const mockClientFactory = vi.mocked(createSupabaseServiceClient);

function ledgerDb(result: { data?: unknown; error?: { message: string } | null }) {
  const b: Record<string, unknown> = {};
  for (const method of ["select", "eq", "gte", "lt"]) {
    b[method] = vi.fn(() => b);
  }
  b.then = (resolve: (v: unknown) => void) => resolve(result);
  return { from: vi.fn(() => b) } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  mockPage.mockResolvedValue({ ...PAGE });
  mockConn.mockResolvedValue(GOOGLE);
  mockBusiness.mockResolvedValue(BUSINESS);
  mockZoom.mockResolvedValue("zoom-1");
  mockBusy.mockResolvedValue([]);
  mockClientFactory.mockResolvedValue(ledgerDb({ data: [], error: null }));
  mockCapture.mockResolvedValue({ created: true });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("getBookingPageContext", () => {
  it("fails closed as not_found on malformed tokens, unknown tokens, and orphan pages", async () => {
    expect(await getBookingPageContext("nope")).toEqual({ ok: false, detail: "not_found" });

    mockPage.mockResolvedValueOnce(null);
    expect(await getBookingPageContext(TOKEN)).toEqual({ ok: false, detail: "not_found" });

    mockBusiness.mockResolvedValueOnce(null);
    expect(await getBookingPageContext(TOKEN)).toEqual({ ok: false, detail: "not_found" });
  });

  it("requires a direct-booking calendar provider", async () => {
    mockConn.mockResolvedValueOnce(null);
    expect(await getBookingPageContext(TOKEN)).toEqual({
      ok: false,
      detail: "calendar_not_connected"
    });
    for (const provider of ["vagaro", "calendly"]) {
      mockConn.mockResolvedValueOnce({ provider } as never);
      expect(await getBookingPageContext(TOKEN)).toEqual({
        ok: false,
        detail: "calendar_not_connected"
      });
    }
  });

  it("resolves the render context (zoom flag, timezone fallback)", async () => {
    const ok = await getBookingPageContext(TOKEN);
    expect(ok).toMatchObject({
      ok: true,
      context: {
        businessId: BIZ,
        businessName: "Acme Plumbing",
        timezone: "America/Phoenix",
        description: "Strategy call",
        allowedDurations: [15, 30],
        videoCall: true
      }
    });

    mockZoom.mockResolvedValueOnce(null);
    mockBusiness.mockResolvedValueOnce({ ...(BUSINESS as object), timezone: "  " } as never);
    const fallback = await getBookingPageContext(TOKEN);
    expect(fallback).toMatchObject({
      ok: true,
      context: { videoCall: false, timezone: "UTC" }
    });
  });
});

describe("listPublicSlots", () => {
  it("passes context failures through and rejects unoffered durations", async () => {
    expect(await listPublicSlots("nope", 30)).toEqual({ ok: false, detail: "not_found" });
    expect(await listPublicSlots(TOKEN, 45)).toEqual({ ok: false, detail: "invalid_duration" });
  });

  it("lists workspace slots on the business-hours grid", async () => {
    const out = await listPublicSlots(TOKEN, 30);
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("unreachable");
    expect(out.timezone).toBe("America/Phoenix");
    expect(out.durationMinutes).toBe(30);
    expect(out.slots[0].startIso).toBe("2026-01-05T16:00:00.000Z");
    expect(mockBusy).toHaveBeenCalledTimes(1);
  });

  it("treats a null workspace busy read as calendar_not_connected", async () => {
    mockBusy.mockResolvedValueOnce(null);
    expect(await listPublicSlots(TOKEN, 30)).toEqual({
      ok: false,
      detail: "calendar_not_connected"
    });
  });

  it("supports CalDAV connections (both busy outcomes)", async () => {
    const caldav = { provider: "caldav", connectionId: "cd", providerConfigKey: "caldav-direct" };
    mockConn.mockResolvedValue(caldav as never);
    mockCaldav.mockResolvedValueOnce({ ok: true, busy: [] } as never);
    const ok = await listPublicSlots(TOKEN, 30);
    expect(ok.ok).toBe(true);
    expect(mockBusy).not.toHaveBeenCalled();

    mockCaldav.mockResolvedValueOnce({
      ok: false,
      result: { ok: false, detail: "calendar_not_connected" }
    } as never);
    expect(await listPublicSlots(TOKEN, 30)).toEqual({
      ok: false,
      detail: "calendar_not_connected"
    });
  });

  it("feeds the daily cap from the booking ledger and fails soft on ledger errors", async () => {
    mockPage.mockResolvedValue({ ...PAGE, max_daily_bookings: 1 });
    mockClientFactory.mockResolvedValue(
      ledgerDb({ data: [{ start_at: "2026-01-05T18:00:00Z" }], error: null })
    );
    const capped = await listPublicSlots(TOKEN, 30);
    expect(capped.ok).toBe(true);
    if (!capped.ok) throw new Error("unreachable");
    // One existing booking on the only bookable day at cap 1: nothing offered.
    expect(capped.slots).toHaveLength(0);

    mockClientFactory.mockResolvedValue(ledgerDb({ data: null, error: { message: "boom" } }));
    expect(await listPublicSlots(TOKEN, 30)).toEqual({ ok: false, detail: "booking_failed" });
    expect(logger.warn).toHaveBeenCalledWith(
      "booking-page: slot listing failed",
      expect.objectContaining({ error: "booking starts read: boom" })
    );
  });

  it("falls back to default hours when the business row vanishes mid-listing", async () => {
    // Context resolution reads the business once; the hours read gets null.
    mockBusiness.mockResolvedValueOnce(BUSINESS).mockResolvedValueOnce(null);
    const out = await listPublicSlots(TOKEN, 30);
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("unreachable");
    // Default Mon-Fri 09:00-17:00 still applies on a Monday.
    expect(out.slots.length).toBeGreaterThan(0);
  });

  it("tolerates a null ledger payload when the daily cap is set", async () => {
    mockPage.mockResolvedValue({ ...PAGE, max_daily_bookings: 3 });
    mockClientFactory.mockResolvedValue(ledgerDb({ data: null, error: null }));
    const out = await listPublicSlots(TOKEN, 30);
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("unreachable");
    expect(out.slots.length).toBeGreaterThan(0);
  });

  it("consults the roster only when the staff gate is on (active members only)", async () => {
    const noGate = await listPublicSlots(TOKEN, 30);
    expect(noGate.ok).toBe(true);
    expect(mockMembers).not.toHaveBeenCalled();

    mockPage.mockResolvedValue({ ...PAGE, require_staff_on_shift: true });
    mockMembers.mockResolvedValue([
      { id: "m1", active: true, weekly_schedule: null },
      { id: "m2", active: false, weekly_schedule: null }
    ] as never);
    mockTimeOff.mockResolvedValue([]);
    const gated = await listPublicSlots(TOKEN, 30);
    expect(gated.ok).toBe(true);
    if (!gated.ok) throw new Error("unreachable");
    expect(gated.slots.length).toBeGreaterThan(0);
    expect(mockMembers).toHaveBeenCalledTimes(1);
    expect(mockTimeOff).toHaveBeenCalledTimes(1);
  });

  it("reports booking_failed on unexpected errors (non-Error shapes included)", async () => {
    mockBusy.mockRejectedValueOnce("proxy exploded");
    expect(await listPublicSlots(TOKEN, 30)).toEqual({ ok: false, detail: "booking_failed" });
    expect(logger.warn).toHaveBeenCalledWith(
      "booking-page: slot listing failed",
      expect.objectContaining({ error: "proxy exploded" })
    );
  });
});

describe("submitPublicBooking", () => {
  const VALID = {
    startIso: "2026-01-05T16:00:00.000Z",
    durationMinutes: 30,
    name: "Liz Developer",
    phone: "(480) 555-0100",
    email: "liz@example.com",
    note: "Referred by James"
  };

  beforeEach(() => {
    mockBook.mockResolvedValue({
      ok: true,
      data: {
        eventId: "evt-1",
        startLocal: "Monday, January 5, 2026 at 9:00 AM MST",
        zoomJoinUrl: "https://zoom.example/j/1"
      }
    });
  });

  it("passes context failures through", async () => {
    expect(await submitPublicBooking("nope", VALID)).toEqual({
      ok: false,
      detail: "not_found"
    });
  });

  it("rejects every invalid field shape", async () => {
    const cases: Array<Partial<typeof VALID>> = [
      { name: "   " },
      { name: "x".repeat(201) },
      { email: "not-an-email" },
      { email: `${"a".repeat(315)}@example.com` },
      { note: "x".repeat(1001) },
      { phone: "not a phone" },
      // Short codes normalize fine but are not reachable customer numbers.
      { phone: "911" },
      { startIso: "yesterday-ish" }
    ];
    for (const patch of cases) {
      expect(await submitPublicBooking(TOKEN, { ...VALID, ...patch })).toEqual({
        ok: false,
        detail: "invalid_request"
      });
    }
    expect(mockBook).not.toHaveBeenCalled();
  });

  it("passes slot-listing failures through the re-verify", async () => {
    mockBusy.mockResolvedValue(null);
    expect(await submitPublicBooking(TOKEN, VALID)).toEqual({
      ok: false,
      detail: "calendar_not_connected"
    });
  });

  it("refuses a start that is no longer an offered slot", async () => {
    expect(
      await submitPublicBooking(TOKEN, { ...VALID, startIso: "2026-01-05T16:07:00.000Z" })
    ).toEqual({ ok: false, detail: "slot_taken" });
    expect(mockBook).not.toHaveBeenCalled();
  });

  it("books through the shared calendar core and files the contact", async () => {
    const out = await submitPublicBooking(TOKEN, VALID);
    expect(out).toEqual({
      ok: true,
      startIso: "2026-01-05T16:00:00.000Z",
      endIso: "2026-01-05T16:30:00.000Z",
      startLocal: "Monday, January 5, 2026 at 9:00 AM MST",
      zoomJoinUrl: "https://zoom.example/j/1"
    });
    expect(mockBook).toHaveBeenCalledWith(
      BIZ,
      expect.objectContaining({
        startIso: "2026-01-05T16:00:00.000Z",
        endIso: "2026-01-05T16:30:00.000Z",
        summary: "Liz Developer + Acme Plumbing (30 min)",
        attendeeName: "Liz Developer",
        attendeeEmail: "liz@example.com",
        attendeePhone: "+14805550100",
        notes: expect.stringContaining("Note: Referred by James")
      }),
      "+14805550100",
      { alertSurface: "webchat" }
    );
    expect(mockCapture).toHaveBeenCalledWith(BIZ, {
      e164: "+14805550100",
      name: "Liz Developer",
      email: "liz@example.com",
      channel: "webchat",
      sourceTag: BOOKING_PAGE_SOURCE_TAG
    });
  });

  it("omits the note line when empty and nulls missing booking-core extras", async () => {
    mockBook.mockResolvedValueOnce({ ok: true, data: { eventId: "evt-2" } });
    const out = await submitPublicBooking(TOKEN, { ...VALID, note: "  " });
    expect(out).toMatchObject({ ok: true, startLocal: null, zoomJoinUrl: null });
    const args = mockBook.mock.calls[0][1];
    expect(args.notes).not.toContain("Note:");
  });

  it("handles an omitted note and a data-less booking result", async () => {
    mockBook.mockResolvedValueOnce({ ok: true, detail: "already_booked" });
    const { note: _unused, ...noNote } = VALID;
    void _unused;
    const out = await submitPublicBooking(TOKEN, noNote);
    expect(out).toMatchObject({ ok: true, startLocal: null, zoomJoinUrl: null });
    const args = mockBook.mock.calls[0][1];
    expect(args.notes).not.toContain("Note:");
  });

  it("surfaces booking-core refusals as booking_failed (detail null branch too)", async () => {
    mockBook.mockResolvedValueOnce({ ok: false });
    expect(await submitPublicBooking(TOKEN, VALID)).toEqual({
      ok: false,
      detail: "booking_failed"
    });
    expect(logger.warn).toHaveBeenCalledWith(
      "booking-page: booking failed",
      expect.objectContaining({ businessId: BIZ, detail: null })
    );
    expect(mockCapture).not.toHaveBeenCalled();
  });
});
