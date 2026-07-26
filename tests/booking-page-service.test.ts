import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/booking-page/db", () => ({
  getEnabledBookingPageByToken: vi.fn(),
  getEnabledBookingPageBySlug: vi.fn(),
  getBookingPageForBusiness: vi.fn(),
  countBookingsBetween: vi.fn(),
  listBookingStartsBetween: vi.fn(),
  recordPlatformBooking: vi.fn(),
  stampManageToken: vi.fn()
}));
vi.mock("@/lib/voice-tools/connections", () => ({ resolveCalendarConnection: vi.fn() }));
vi.mock("@/lib/calendar-tools/handlers", () => ({
  bookCalendarAppointment: vi.fn(),
  getWorkspaceBusyBlocks: vi.fn(),
  formatBookingStartLocal: vi.fn(() => "Monday, January 5, 2026 at 9:00 AM MST")
}));
vi.mock("@/lib/calendar-tools/attendee-bookings", () => ({
  findUpcomingBookingsForAttendee: vi.fn()
}));
vi.mock("@/lib/calendar-tools/unassigned-booking-alert", () => ({
  maybeAlertUnassignedBooking: vi.fn()
}));
vi.mock("@/lib/zoom/meetings", () => ({
  createZoomMeetingForBooking: vi.fn(),
  deleteZoomMeetingForBooking: vi.fn()
}));
vi.mock("@/lib/ai-flows/goal-hooks", () => ({ fireGoalEvent: vi.fn() }));
vi.mock("@/lib/sms/opt-outs", () => ({ getSmsOptOutKind: vi.fn() }));
vi.mock("@/lib/booking-page/busy-cache", () => ({
  readBusyCache: vi.fn(),
  saveBusyCache: vi.fn()
}));
vi.mock("@/lib/calendar-tools/caldav", () => ({ getCaldavBusyBlocks: vi.fn() }));
vi.mock("@/lib/db/businesses", () => ({ getBusiness: vi.fn() }));
vi.mock("@/lib/db/employees", () => ({ listTeamMembers: vi.fn(), listTimeOff: vi.fn() }));
vi.mock("@/lib/db/zoom-connections", () => ({ getActiveZoomConnectionId: vi.fn() }));
vi.mock("@/lib/customer-memory/capture-contact", () => ({ ensureCapturedContact: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServiceClient: vi.fn() }));
vi.mock("@/lib/calendar-tools/booking-dedupe", () => ({
  claimBookingDedupe: vi.fn(),
  releaseBookingDedupe: vi.fn(),
  bookingAttendeeKey: vi.fn(() => "phone:+14805550100")
}));
vi.mock("@/lib/db/booking-waitlist", () => ({
  getWaitlistSettings: vi.fn(),
  upsertLiveWaitlistEntry: vi.fn()
}));
vi.mock("@/lib/calendar-tools/waitlist-resolve", () => ({
  resolveWaitlistAfterBooking: vi.fn()
}));
vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() }
}));

import {
  BOOKING_PAGE_SOURCE_TAG,
  PUBLIC_SLOT_CLAIM_KEY,
  getBookingPageContext,
  listPublicSlots,
  listSlotsForBusiness,
  probeCalendarAvailability,
  submitPublicBooking
} from "@/lib/booking-page/service";
import {
  getBookingPageForBusiness,
  getEnabledBookingPageBySlug,
  getEnabledBookingPageByToken,
  listBookingStartsBetween,
  recordPlatformBooking,
  stampManageToken
} from "@/lib/booking-page/db";
import { findUpcomingBookingsForAttendee } from "@/lib/calendar-tools/attendee-bookings";
import { maybeAlertUnassignedBooking } from "@/lib/calendar-tools/unassigned-booking-alert";
import {
  createZoomMeetingForBooking,
  deleteZoomMeetingForBooking
} from "@/lib/zoom/meetings";
import { fireGoalEvent } from "@/lib/ai-flows/goal-hooks";
import { getSmsOptOutKind } from "@/lib/sms/opt-outs";
import { readBusyCache, saveBusyCache } from "@/lib/booking-page/busy-cache";
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
import {
  claimBookingDedupe,
  releaseBookingDedupe
} from "@/lib/calendar-tools/booking-dedupe";
import {
  getWaitlistSettings,
  upsertLiveWaitlistEntry
} from "@/lib/db/booking-waitlist";
import { resolveWaitlistAfterBooking } from "@/lib/calendar-tools/waitlist-resolve";
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
  waitlist_enabled: true,
  waitlist_offer_ttl_minutes: 60,
  slug: null as string | null,
  title: null as string | null,
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
const mockSlotClaim = vi.mocked(claimBookingDedupe);
const mockSlotRelease = vi.mocked(releaseBookingDedupe);
const mockListStarts = vi.mocked(listBookingStartsBetween);
const mockRecordPlatform = vi.mocked(recordPlatformBooking);
const mockStampManage = vi.mocked(stampManageToken);
const mockPageByBusiness = vi.mocked(getBookingPageForBusiness);
const mockUpcomingForAttendee = vi.mocked(findUpcomingBookingsForAttendee);
const mockUnassignedAlert = vi.mocked(maybeAlertUnassignedBooking);
const mockZoomCreate = vi.mocked(createZoomMeetingForBooking);
const mockZoomDelete = vi.mocked(deleteZoomMeetingForBooking);
const mockGoal = vi.mocked(fireGoalEvent);
const mockOptOutKind = vi.mocked(getSmsOptOutKind);
const mockCacheRead = vi.mocked(readBusyCache);
const mockCacheSave = vi.mocked(saveBusyCache);

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
  mockSlotClaim.mockResolvedValue({ kind: "claimed", id: "claim-1" });
  mockSlotRelease.mockResolvedValue(undefined);
  mockListStarts.mockResolvedValue([]);
  mockRecordPlatform.mockResolvedValue({ ok: true });
  mockStampManage.mockResolvedValue(true);
  mockUpcomingForAttendee.mockResolvedValue([]);
  mockUnassignedAlert.mockResolvedValue("sent" as never);
  mockZoomCreate.mockResolvedValue({
    meetingId: "zm-1",
    joinUrl: "https://zoom.example/j/9"
  } as never);
  mockZoomDelete.mockResolvedValue(undefined as never);
  mockGoal.mockResolvedValue(undefined as never);
  mockOptOutKind.mockResolvedValue(null);
  mockCacheRead.mockResolvedValue(null);
  mockCacheSave.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("getBookingPageContext", () => {
  it("fails closed as not_found on malformed refs, unknown tokens, and orphan pages", async () => {
    // Neither a token nor a slug shape: refused before any DB read.
    expect(await getBookingPageContext("Not A Ref!")).toEqual({
      ok: false,
      detail: "not_found"
    });
    // Valid slug shape with no matching page.
    expect(await getBookingPageContext("nope")).toEqual({ ok: false, detail: "not_found" });

    mockPage.mockResolvedValueOnce(null);
    expect(await getBookingPageContext(TOKEN)).toEqual({ ok: false, detail: "not_found" });

    mockBusiness.mockResolvedValueOnce(null);
    expect(await getBookingPageContext(TOKEN)).toEqual({ ok: false, detail: "not_found" });
  });

  it("refuses Vagaro/Calendly (their book lives elsewhere), allows NO connection as platform mode", async () => {
    for (const provider of ["vagaro", "calendly"]) {
      mockConn.mockResolvedValueOnce({ provider } as never);
      expect(await getBookingPageContext(TOKEN)).toEqual({
        ok: false,
        detail: "calendar_not_connected"
      });
    }
    mockConn.mockResolvedValueOnce(null);
    expect(await getBookingPageContext(TOKEN)).toMatchObject({
      ok: true,
      context: { mode: "platform" }
    });
    // A workspace connection resolves provider mode.
    expect(await getBookingPageContext(TOKEN)).toMatchObject({
      ok: true,
      context: { mode: "provider" }
    });
  });

  it("resolves by vanity slug and surfaces the custom title", async () => {
    const bySlug = vi.mocked(getEnabledBookingPageBySlug);
    bySlug.mockResolvedValueOnce({ ...PAGE, slug: "new-coworker", title: "  Free strategy call  " });
    const out = await getBookingPageContext("new-coworker");
    expect(bySlug).toHaveBeenCalledWith("new-coworker");
    expect(mockPage).not.toHaveBeenCalled();
    expect(out).toMatchObject({
      ok: true,
      context: { title: "Free strategy call" }
    });

    // Blank stored title falls back to null (the localized default).
    mockPage.mockResolvedValueOnce({ ...PAGE, title: "   " });
    const fallback = await getBookingPageContext(TOKEN);
    expect(fallback).toMatchObject({ ok: true, context: { title: null } });
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

describe("probeCalendarAvailability", () => {
  it("classifies every connection state", async () => {
    mockConn.mockResolvedValueOnce(null);
    expect(await probeCalendarAvailability(BIZ)).toBe("platform");

    for (const provider of ["vagaro", "calendly"]) {
      mockConn.mockResolvedValueOnce({ provider } as never);
      expect(await probeCalendarAvailability(BIZ)).toBe("unsupported");
    }

    // Healthy workspace read.
    expect(await probeCalendarAvailability(BIZ)).toBe("ok");

    // Proxy null = the scope-starved consent (the Jul 2026 HQ case).
    mockBusy.mockResolvedValueOnce(null);
    expect(await probeCalendarAvailability(BIZ)).toBe("unreadable");

    // A thrown proxy error (Google 403) also reads as unreadable.
    mockBusy.mockRejectedValueOnce(new Error("Request failed with status code 403"));
    expect(await probeCalendarAvailability(BIZ)).toBe("unreadable");

    // CalDAV rides the same probe.
    mockConn.mockResolvedValueOnce({
      provider: "caldav",
      connectionId: "cd",
      providerConfigKey: "caldav-direct"
    } as never);
    mockCaldav.mockResolvedValueOnce({ ok: true, busy: [] } as never);
    expect(await probeCalendarAvailability(BIZ)).toBe("ok");
  });
});

describe("listSlotsForBusiness", () => {
  // The invitee manage page holds a booking, not a page link, but must be
  // offered exactly what the public page offers.
  it("lists the page's own availability when addressed by business", async () => {
    mockPageByBusiness.mockResolvedValue({ ...PAGE });
    const out = await listSlotsForBusiness(BIZ, 30);
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("unreachable");
    expect(out.slots[0].startIso).toBe("2026-01-05T16:00:00.000Z");
  });

  it("refuses when the business has no page, or its page is switched off", async () => {
    mockPageByBusiness.mockResolvedValue(null);
    expect(await listSlotsForBusiness(BIZ, 30)).toEqual({ ok: false, detail: "not_found" });

    mockPageByBusiness.mockResolvedValue({ ...PAGE, enabled: false });
    expect(await listSlotsForBusiness(BIZ, 30)).toEqual({ ok: false, detail: "not_found" });
  });

  it("passes a context failure through (a page that no longer resolves)", async () => {
    mockPageByBusiness.mockResolvedValue({ ...PAGE });
    mockPage.mockResolvedValue(null);
    expect(await listSlotsForBusiness(BIZ, 30)).toEqual({ ok: false, detail: "not_found" });
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

  it("degrades to the ledger baseline when provider busy data is unreadable", async () => {
    // Scope-starved consent (the HQ case): busy read refused, but a ledger
    // booking still blocks its hour; everything else stays offerable.
    mockBusy.mockResolvedValueOnce(null);
    mockListStarts.mockResolvedValueOnce([new Date("2026-01-05T16:00:00Z")]);
    const out = await listPublicSlots(TOKEN, 30);
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("unreachable");
    const starts = out.slots.map((s) => s.startIso);
    expect(starts).not.toContain("2026-01-05T16:00:00.000Z");
    expect(starts).toContain("2026-01-05T17:00:00.000Z");
    expect(logger.warn).toHaveBeenCalledWith(
      "booking-page: provider busy unreadable; degrading",
      expect.objectContaining({ businessId: BIZ, cachedSnapshot: false })
    );
    // Nothing good to write through on a failed fetch.
    expect(mockCacheSave).not.toHaveBeenCalled();
  });

  it("serves the last-known-good busy snapshot when the live fetch fails", async () => {
    // The outage case the cache exists for: yesterday's fetch saw a
    // provider event at 17:00; today's fetch fails. The cached span keeps
    // that hour blocked (unioned with the ledger) instead of reopening it.
    mockBusy.mockResolvedValueOnce(null);
    mockCacheRead.mockResolvedValueOnce([
      { start: new Date("2026-01-05T17:00:00Z"), end: new Date("2026-01-05T18:00:00Z") }
    ]);
    mockListStarts.mockResolvedValueOnce([new Date("2026-01-05T16:00:00Z")]);
    const out = await listPublicSlots(TOKEN, 30);
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("unreachable");
    const starts = out.slots.map((s) => s.startIso);
    expect(starts).not.toContain("2026-01-05T16:00:00.000Z"); // ledger
    expect(starts).not.toContain("2026-01-05T17:00:00.000Z"); // cached provider span
    expect(starts).toContain("2026-01-05T18:00:00.000Z");
    expect(logger.warn).toHaveBeenCalledWith(
      "booking-page: provider busy unreadable; degrading",
      expect.objectContaining({ cachedSnapshot: true })
    );
  });

  it("writes the snapshot through on every successful provider fetch", async () => {
    const span = { start: new Date("2026-01-05T17:00:00Z"), end: new Date("2026-01-05T18:00:00Z") };
    mockBusy.mockResolvedValueOnce([span]);
    const out = await listPublicSlots(TOKEN, 30);
    expect(out.ok).toBe(true);
    expect(mockCacheSave).toHaveBeenCalledTimes(1);
    const [bizArg, winStart, winEnd, spans] = mockCacheSave.mock.calls[0];
    expect(bizArg).toBe(BIZ);
    expect(winStart.getTime()).toBeLessThan(winEnd.getTime());
    expect(spans).toEqual([span]);
    expect(mockCacheRead).not.toHaveBeenCalled();
  });

  it("degrades on a thrown provider busy fetch too (non-Error shapes included)", async () => {
    mockBusy.mockRejectedValueOnce(new Error("Request failed with status code 403"));
    const out = await listPublicSlots(TOKEN, 30);
    expect(out.ok).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(
      "booking-page: provider busy fetch threw; degrading",
      expect.objectContaining({ error: "Request failed with status code 403" })
    );

    mockBusy.mockRejectedValueOnce("proxy string boom");
    const out2 = await listPublicSlots(TOKEN, 30);
    expect(out2.ok).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(
      "booking-page: provider busy fetch threw; degrading",
      expect.objectContaining({ error: "proxy string boom" })
    );
  });

  it("supports CalDAV connections (both busy outcomes)", async () => {
    const caldav = { provider: "caldav", connectionId: "cd", providerConfigKey: "caldav-direct" };
    mockConn.mockResolvedValue(caldav as never);
    mockCaldav.mockResolvedValueOnce({ ok: true, busy: [] } as never);
    const ok = await listPublicSlots(TOKEN, 30);
    expect(ok.ok).toBe(true);
    expect(mockBusy).not.toHaveBeenCalled();

    // An unreadable CalDAV calendar degrades to the ledger baseline too.
    mockCaldav.mockResolvedValueOnce({
      ok: false,
      result: { ok: false, detail: "calendar_not_connected" }
    } as never);
    const degraded = await listPublicSlots(TOKEN, 30);
    expect(degraded.ok).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(
      "booking-page: provider busy unreadable; degrading",
      expect.objectContaining({ businessId: BIZ })
    );
  });

  it("feeds the daily cap from the booking ledger and fails soft on ledger errors", async () => {
    mockPage.mockResolvedValue({ ...PAGE, max_daily_bookings: 1 });
    mockListStarts.mockResolvedValueOnce([new Date("2026-01-05T18:00:00Z")]);
    const capped = await listPublicSlots(TOKEN, 30);
    expect(capped.ok).toBe(true);
    if (!capped.ok) throw new Error("unreachable");
    // One existing booking on the only bookable day at cap 1: nothing offered.
    expect(capped.slots).toHaveLength(0);

    mockListStarts.mockRejectedValueOnce(new Error("listBookingStartsBetween: boom"));
    expect(await listPublicSlots(TOKEN, 30)).toEqual({ ok: false, detail: "booking_failed" });
    expect(logger.warn).toHaveBeenCalledWith(
      "booking-page: slot listing failed",
      expect.objectContaining({ error: "listBookingStartsBetween: boom" })
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

  it("always reads the ledger (cap input and the degraded-availability baseline)", async () => {
    const out = await listPublicSlots(TOKEN, 30);
    expect(out.ok).toBe(true);
    expect(mockListStarts).toHaveBeenCalledTimes(1);
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

  it("platform mode: the booking ledger is the busy source, no provider fetch", async () => {
    mockConn.mockResolvedValue(null);
    // One existing booking at 9:00 Phoenix blocks a conservative hour.
    mockListStarts.mockResolvedValue([new Date("2026-01-05T16:00:00Z")]);
    const out = await listPublicSlots(TOKEN, 30);
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("unreachable");
    expect(mockBusy).not.toHaveBeenCalled();
    expect(mockCaldav).not.toHaveBeenCalled();
    const starts = out.slots.map((s) => s.startIso);
    expect(starts).not.toContain("2026-01-05T16:00:00.000Z");
    expect(starts).not.toContain("2026-01-05T16:30:00.000Z");
    expect(starts).toContain("2026-01-05T17:00:00.000Z");
  });

  it("reports booking_failed on unexpected errors (non-Error shapes included)", async () => {
    // Provider busy failures degrade (tested above); a LEDGER read failure
    // is still an unexpected error the listing cannot recover from.
    mockListStarts.mockRejectedValueOnce("ledger exploded");
    expect(await listPublicSlots(TOKEN, 30)).toEqual({ ok: false, detail: "booking_failed" });
    expect(logger.warn).toHaveBeenCalledWith(
      "booking-page: slot listing failed",
      expect.objectContaining({ error: "ledger exploded" })
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

  it("refuses owner-declared spam numbers with the generic failure (never revealing the block)", async () => {
    mockOptOutKind.mockResolvedValueOnce("owner_spam");
    expect(await submitPublicBooking(TOKEN, VALID)).toEqual({
      ok: false,
      detail: "booking_failed"
    });
    expect(mockBook).not.toHaveBeenCalled();
    expect(mockSlotClaim).not.toHaveBeenCalled();
    expect(mockCapture).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      "booking-page: refused owner_spam number",
      expect.objectContaining({ businessId: BIZ })
    );
  });

  it("still books a customer who texted STOP (they refused texts, not appointments)", async () => {
    mockOptOutKind.mockResolvedValueOnce("stop");
    const out = await submitPublicBooking(TOKEN, VALID);
    expect(out.ok).toBe(true);
    expect(mockBook).toHaveBeenCalledTimes(1);
  });

  it("answers a double submit for the attendee's existing start idempotently (both modes)", async () => {
    mockUpcomingForAttendee.mockResolvedValueOnce([
      { startIso: "2026-01-05T16:00:00.000Z", eventId: "evt-1" }
    ] as never);
    const out = await submitPublicBooking(TOKEN, VALID);
    expect(out).toEqual({
      ok: true,
      startIso: "2026-01-05T16:00:00.000Z",
      endIso: "2026-01-05T16:30:00.000Z",
      startLocal: "Monday, January 5, 2026 at 9:00 AM MST",
      zoomJoinUrl: null,
      // A retry must not mint a SECOND manage token: the first
      // confirmation already carried the link to this booking.
      manageLink: null
    });
    expect(mockBook).not.toHaveBeenCalled();
    expect(mockSlotClaim).not.toHaveBeenCalled();
  });

  it("refuses a different upcoming booking for the same person before any claim", async () => {
    mockUpcomingForAttendee.mockResolvedValueOnce([
      { startIso: "2026-01-06T17:00:00Z", eventId: "evt-2" }
    ] as never);
    expect(await submitPublicBooking(TOKEN, VALID)).toEqual({
      ok: false,
      detail: "already_booked"
    });
    expect(mockBook).not.toHaveBeenCalled();
  });

  it("passes slot-listing failures through the re-verify", async () => {
    mockListStarts.mockRejectedValueOnce(new Error("ledger down"));
    expect(await submitPublicBooking(TOKEN, VALID)).toEqual({
      ok: false,
      detail: "booking_failed"
    });
  });

  it("drops the manage link rather than the booking when the stamp does not land", async () => {
    // The appointment is real either way; a visitor who cannot self-serve
    // still has the business's number.
    mockStampManage.mockResolvedValue(false);
    const out = await submitPublicBooking(TOKEN, VALID);
    expect(out.ok && out.manageLink).toBeNull();

    mockStampManage.mockRejectedValue(new Error("update denied"));
    const thrown = await submitPublicBooking(TOKEN, VALID);
    expect(thrown.ok).toBe(true);
    expect(thrown.ok && thrown.manageLink).toBeNull();

    mockStampManage.mockRejectedValue("string boom");
    const nonError = await submitPublicBooking(TOKEN, VALID);
    expect(nonError.ok && nonError.manageLink).toBeNull();
  });

  it("books through an unreadable provider (degraded availability, writable calendar)", async () => {
    // The HQ shape: busy reads 403 but event creation works. The re-verify
    // degrades to the ledger baseline and the booking core still lands the
    // event on the provider calendar.
    mockBusy.mockResolvedValue(null);
    const out = await submitPublicBooking(TOKEN, VALID);
    expect(out.ok).toBe(true);
    expect(mockBook).toHaveBeenCalledTimes(1);
  });

  it("refuses a start that is no longer an offered slot", async () => {
    expect(
      await submitPublicBooking(TOKEN, { ...VALID, startIso: "2026-01-05T16:07:00.000Z" })
    ).toEqual({ ok: false, detail: "slot_taken" });
    expect(mockBook).not.toHaveBeenCalled();
  });

  it("recounts the daily cap after winning the slot claim, releasing it on refusal", async () => {
    mockPage.mockResolvedValue({ ...PAGE, max_daily_bookings: 1 });
    // Re-verify sees an open day; by the post-claim recount a concurrent
    // booking for ANOTHER slot on the same day has landed in the ledger.
    mockListStarts
      .mockResolvedValueOnce([]) // listPublicSlots (re-verify)
      .mockResolvedValueOnce([new Date("2026-01-05T20:00:00Z")]); // recount
    expect(await submitPublicBooking(TOKEN, VALID)).toEqual({
      ok: false,
      detail: "slot_taken"
    });
    expect(mockBook).not.toHaveBeenCalled();
    expect(mockSlotRelease).toHaveBeenCalledWith("claim-1");

    // Same shape with a quiet day passes.
    mockListStarts.mockResolvedValue([]);
    const out = await submitPublicBooking(TOKEN, VALID);
    expect(out.ok).toBe(true);
  });

  it("maps the attendee duplicate guard to already_booked and releases the claim", async () => {
    mockBook.mockResolvedValueOnce({ ok: false, detail: "attendee_already_booked" });
    expect(await submitPublicBooking(TOKEN, VALID)).toEqual({
      ok: false,
      detail: "already_booked"
    });
    expect(logger.warn).not.toHaveBeenCalled();
    expect(mockCapture).not.toHaveBeenCalled();
    expect(mockSlotRelease).toHaveBeenCalledWith("claim-1");
  });

  it("loses the slot claim to a racing visitor (in_flight and duplicate): slot_taken, no write", async () => {
    mockSlotClaim.mockResolvedValueOnce({ kind: "in_flight" });
    expect(await submitPublicBooking(TOKEN, VALID)).toEqual({
      ok: false,
      detail: "slot_taken"
    });
    expect(mockSlotClaim).toHaveBeenCalledWith(
      BIZ,
      PUBLIC_SLOT_CLAIM_KEY,
      "2026-01-05T16:00:00.000Z"
    );
    expect(mockBook).not.toHaveBeenCalled();

    mockSlotClaim.mockResolvedValueOnce({ kind: "duplicate", eventId: "evt-x" });
    expect(await submitPublicBooking(TOKEN, VALID)).toEqual({
      ok: false,
      detail: "slot_taken"
    });
    expect(mockBook).not.toHaveBeenCalled();
  });

  it("a fail-open (null) claim releases nothing on a later refusal", async () => {
    mockSlotClaim.mockResolvedValueOnce(null);
    mockBook.mockResolvedValueOnce({ ok: false, detail: "provider_error" });
    expect(await submitPublicBooking(TOKEN, VALID)).toEqual({
      ok: false,
      detail: "booking_failed"
    });
    expect(mockSlotRelease).not.toHaveBeenCalled();
  });

  it("fails open when the claim ledger is unavailable, and never releases on success", async () => {
    mockSlotClaim.mockResolvedValueOnce(null);
    const out = await submitPublicBooking(TOKEN, VALID);
    expect(out.ok).toBe(true);
    expect(mockSlotRelease).not.toHaveBeenCalled();

    // Claimed + successful booking: the claim lapses with its lease.
    const out2 = await submitPublicBooking(TOKEN, VALID);
    expect(out2.ok).toBe(true);
    expect(mockSlotRelease).not.toHaveBeenCalled();
  });

  it("books through the shared calendar core and files the contact", async () => {
    const out = await submitPublicBooking(TOKEN, VALID);
    expect(out).toEqual({
      ok: true,
      startIso: "2026-01-05T16:00:00.000Z",
      endIso: "2026-01-05T16:30:00.000Z",
      startLocal: "Monday, January 5, 2026 at 9:00 AM MST",
      zoomJoinUrl: "https://zoom.example/j/1",
      // Self-serve reschedule/cancel for this booking, stamped onto the
      // ledger row the core wrote.
      manageLink: expect.stringMatching(/^\/book\/manage\/ncbm_[0-9a-f]{64}$/)
    });
    expect(mockStampManage).toHaveBeenCalledWith(
      BIZ,
      "phone:+14805550100",
      "2026-01-05T16:00:00.000Z",
      expect.stringMatching(/^ncbm_[0-9a-f]{64}$/),
      30
    );
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
      { alertSurface: "webchat", trustProvidedName: true }
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

  it("notifyEarlier joins the cancellation waitlist linked to the fresh booking", async () => {
    vi.mocked(getWaitlistSettings).mockResolvedValue({ enabled: true, offerTtlMinutes: 60 });
    vi.mocked(upsertLiveWaitlistEntry).mockResolvedValue({ row: {} as never, created: true });
    const out = await submitPublicBooking(TOKEN, { ...VALID, notifyEarlier: true });
    expect(out.ok).toBe(true);
    expect(vi.mocked(upsertLiveWaitlistEntry)).toHaveBeenCalledWith(BIZ, {
      phone: "+14805550100",
      email: "liz@example.com",
      name: "Liz Developer",
      durationMinutes: 30,
      latestAtIso: "2026-01-05T16:00:00.000Z",
      currentBookingStartAtIso: "2026-01-05T16:00:00.000Z"
    });
  });

  it("notifyEarlier respects the owner's waitlist toggle and is off by default", async () => {
    vi.mocked(getWaitlistSettings).mockResolvedValue({ enabled: false, offerTtlMinutes: 60 });
    expect((await submitPublicBooking(TOKEN, { ...VALID, notifyEarlier: true })).ok).toBe(true);
    expect(vi.mocked(upsertLiveWaitlistEntry)).not.toHaveBeenCalled();

    // No opt-in: the settings read is skipped entirely.
    vi.mocked(getWaitlistSettings).mockClear();
    expect((await submitPublicBooking(TOKEN, VALID)).ok).toBe(true);
    expect(vi.mocked(getWaitlistSettings)).not.toHaveBeenCalled();
    expect(vi.mocked(upsertLiveWaitlistEntry)).not.toHaveBeenCalled();
  });

  describe("platform mode (no calendar integration)", () => {
    beforeEach(() => {
      mockConn.mockResolvedValue(null);
    });

    it("books onto the ledger with Zoom, goal fan-out, owner alert, and contact filing", async () => {
      const out = await submitPublicBooking(TOKEN, VALID);
      expect(out).toEqual({
        ok: true,
        startIso: "2026-01-05T16:00:00.000Z",
        endIso: "2026-01-05T16:30:00.000Z",
        startLocal: "Monday, January 5, 2026 at 9:00 AM MST",
        zoomJoinUrl: "https://zoom.example/j/9",
        manageLink: expect.stringMatching(/^\/book\/manage\/ncbm_[0-9a-f]{64}$/)
      });
      expect(mockBook).not.toHaveBeenCalled();
      expect(mockRecordPlatform).toHaveBeenCalledWith(
        BIZ,
        "phone:+14805550100",
        "2026-01-05T16:00:00.000Z",
        expect.stringMatching(/^platform:/),
        "zm-1",
        undefined,
        // The manage token rides the INSERT here (no separate stamp): the
        // ledger row is the booking in platform mode.
        {
          token: expect.stringMatching(/^ncbm_[0-9a-f]{64}$/),
          durationMinutes: 30
        }
      );
      expect(mockStampManage).not.toHaveBeenCalled();
      expect(mockGoal).toHaveBeenCalledWith(BIZ, "+14805550100", {
        kind: "appointment_booked"
      });
      // Provider mode gets this inside bookCalendarAppointment; platform
      // mode must run the same waitlist resolution itself.
      expect(vi.mocked(resolveWaitlistAfterBooking)).toHaveBeenCalledWith(
        BIZ,
        { phones: ["+14805550100"], email: "liz@example.com" },
        "2026-01-05T16:00:00.000Z"
      );
      expect(mockUnassignedAlert).toHaveBeenCalledWith(
        BIZ,
        expect.objectContaining({
          attendeePhone: "+14805550100",
          surface: "webchat",
          eventId: "platform"
        })
      );
      expect(mockCapture).toHaveBeenCalledTimes(1);
      expect(mockSlotRelease).not.toHaveBeenCalled();
    });

    it("books without Zoom when none is connected (note omitted too)", async () => {
      mockZoomCreate.mockResolvedValueOnce(null);
      const { note: _unused, ...noNote } = VALID;
      void _unused;
      const out = await submitPublicBooking(TOKEN, noNote);
      expect(out).toMatchObject({ ok: true, zoomJoinUrl: null });
      expect(mockZoomCreate).toHaveBeenCalledWith(
        BIZ,
        expect.objectContaining({ agenda: undefined })
      );
      expect(mockRecordPlatform).toHaveBeenCalledWith(
        BIZ,
        "phone:+14805550100",
        "2026-01-05T16:00:00.000Z",
        expect.stringMatching(/^platform:/),
        null,
        undefined,
        expect.objectContaining({ durationMinutes: 30 })
      );
    });

    it("a ledger failure without a Zoom meeting cleans up nothing extra", async () => {
      mockZoomCreate.mockResolvedValueOnce(null);
      mockRecordPlatform.mockResolvedValueOnce({ ok: false, reason: "duplicate" });
      expect(await submitPublicBooking(TOKEN, VALID)).toEqual({
        ok: false,
        detail: "already_booked"
      });
      expect(mockZoomDelete).not.toHaveBeenCalled();
    });

    it("keeps the one-upcoming-appointment-per-person policy (before any claim)", async () => {
      mockUpcomingForAttendee.mockResolvedValueOnce([
        { startIso: "2026-01-06T17:00:00Z", eventId: "evt-9" }
      ] as never);
      expect(await submitPublicBooking(TOKEN, VALID)).toEqual({
        ok: false,
        detail: "already_booked"
      });
      expect(mockRecordPlatform).not.toHaveBeenCalled();
      expect(mockSlotClaim).not.toHaveBeenCalled();
    });

    it("re-runs the per-person guard post-claim: an overlapping different-slot submit is refused", async () => {
      mockUpcomingForAttendee
        .mockResolvedValueOnce([]) // early check: clean
        .mockResolvedValueOnce([
          { startIso: "2026-01-05T20:00:00Z", eventId: "evt-race" }
        ] as never); // post-claim recheck: a racing submit landed
      expect(await submitPublicBooking(TOKEN, VALID)).toEqual({
        ok: false,
        detail: "already_booked"
      });
      expect(mockRecordPlatform).not.toHaveBeenCalled();
      expect(mockZoomDelete).toHaveBeenCalledWith(BIZ, "zm-1");
      expect(mockSlotRelease).toHaveBeenCalledWith("claim-1");
    });

    it("the post-claim recheck without a Zoom meeting cleans up nothing extra", async () => {
      mockZoomCreate.mockResolvedValueOnce(null);
      mockUpcomingForAttendee
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          { startIso: "2026-01-05T20:00:00Z", eventId: "evt-race" }
        ] as never);
      expect(await submitPublicBooking(TOKEN, VALID)).toEqual({
        ok: false,
        detail: "already_booked"
      });
      expect(mockZoomDelete).not.toHaveBeenCalled();
    });

    it("a duplicate ledger row reads as already_booked and cleans up the Zoom meeting", async () => {
      mockRecordPlatform.mockResolvedValueOnce({ ok: false, reason: "duplicate" });
      expect(await submitPublicBooking(TOKEN, VALID)).toEqual({
        ok: false,
        detail: "already_booked"
      });
      expect(mockZoomDelete).toHaveBeenCalledWith(BIZ, "zm-1");
      expect(mockSlotRelease).toHaveBeenCalledWith("claim-1");
      expect(mockGoal).not.toHaveBeenCalled();
    });

    it("a ledger write error is booking_failed with full cleanup", async () => {
      mockRecordPlatform.mockResolvedValueOnce({ ok: false, reason: "error" });
      expect(await submitPublicBooking(TOKEN, VALID)).toEqual({
        ok: false,
        detail: "booking_failed"
      });
      expect(mockZoomDelete).toHaveBeenCalledWith(BIZ, "zm-1");
      expect(mockSlotRelease).toHaveBeenCalledWith("claim-1");
      expect(logger.warn).toHaveBeenCalledWith(
        "booking-page: platform booking write failed",
        expect.objectContaining({ businessId: BIZ })
      );
    });
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
    expect(mockSlotRelease).toHaveBeenCalledWith("claim-1");
  });
});
