import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/booking-page/db", () => ({
  getEnabledBookingPageByToken: vi.fn(),
  getEnabledBookingPageBySlug: vi.fn(),
  getBookingPageForBusiness: vi.fn(),
  countBookingsBetween: vi.fn(),
  listBookingStartsBetween: vi.fn(),
  recordPlatformBooking: vi.fn(),
  stampManageToken: vi.fn(),
  stampAttendeeContact: vi.fn(),
  countUpcomingByAssignee: vi.fn(),
  stampAssigneeIfUnset: vi.fn(),
  claimOwnerBookingAlert: vi.fn()
}));
vi.mock("@/lib/booking-page/confirmation-email", () => ({
  sendBookingConfirmationEmail: vi.fn()
}));
vi.mock("@/lib/booking-page/assignee-notify", () => ({ notifyAssigneeOfBooking: vi.fn() }));
vi.mock("@/lib/booking-page/claim-offers", () => ({
  broadcastBookingClaim: vi.fn(),
  findDedupeRowId: vi.fn(),
  findInvitedPhonesForBooking: vi.fn(async () => [])
}));
vi.mock("@/lib/db/contact-names", () => ({ businessOwnerNumbers: vi.fn() }));
vi.mock("@/lib/booking-page/meeting-types", async (importOriginal) => ({
  // The resolver is pure and its rules are pinned in its own suite; only
  // the database read is faked here.
  ...(await importOriginal<typeof import("@/lib/booking-page/meeting-types")>()),
  listMeetingTypes: vi.fn()
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
vi.mock("@/lib/db/businesses", () => ({
  getBusiness: vi.fn(),
  // Off by default, matching the column default: the videoCall cases below
  // opt in explicitly.
  isGoogleMeetEnabled: vi.fn(async () => false)
}));
vi.mock("@/lib/db/employees", () => ({
  listTeamMembers: vi.fn(),
  listTimeOff: vi.fn(),
  markMemberOffered: vi.fn()
}));
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
  dailyCapReached,
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
  countUpcomingByAssignee,
  stampAssigneeIfUnset,
  claimOwnerBookingAlert,
  stampAttendeeContact,
  stampManageToken
} from "@/lib/booking-page/db";
import { sendBookingConfirmationEmail } from "@/lib/booking-page/confirmation-email";
import { notifyAssigneeOfBooking } from "@/lib/booking-page/assignee-notify";
import {
  broadcastBookingClaim,
  findDedupeRowId,
  findInvitedPhonesForBooking
} from "@/lib/booking-page/claim-offers";
import { businessOwnerNumbers } from "@/lib/db/contact-names";
import { listMeetingTypes } from "@/lib/booking-page/meeting-types";
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
import { getBusiness, isGoogleMeetEnabled } from "@/lib/db/businesses";
import { listTeamMembers, listTimeOff, markMemberOffered } from "@/lib/db/employees";
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

/** A meeting type row; overrides express what this meeting owns. */
function meetingType(over: Record<string, unknown> = {}) {
  return {
    id: "mt-discovery",
    business_id: BIZ,
    name: "Discovery call",
    slug: "discovery-call",
    description: null,
    duration_minutes: 60,
    intake_questions: null,
    assignment_mode: null,
    employee_id: null,
    payment_required: false,
    payment_amount_cents: null,
    payment_currency: "usd",
    enabled: true,
    hidden: false,
    sort_order: 0,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...over
  } as never;
}
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
  send_confirmation_email: true,
  reminders_enabled: true,
  reminder_email_hours: 24,
  reminder_sms_hours: 2,
  assignment_mode: "any",
  employee_id: null,
  notify_assignee: true,
  intake_questions: [],
  payment_required: false,
  payment_amount_cents: null,
  payment_currency: "usd",
  slug: null as string | null,
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
const mockMeetEnabled = vi.mocked(isGoogleMeetEnabled);
const mockBook = vi.mocked(bookCalendarAppointment);
const mockCapture = vi.mocked(ensureCapturedContact);
const mockMembers = vi.mocked(listTeamMembers);
const mockTimeOff = vi.mocked(listTimeOff);
const mockMarkOffered = vi.mocked(markMemberOffered);
const mockClientFactory = vi.mocked(createSupabaseServiceClient);
const mockSlotClaim = vi.mocked(claimBookingDedupe);
const mockSlotRelease = vi.mocked(releaseBookingDedupe);
const mockListStarts = vi.mocked(listBookingStartsBetween);
const mockRecordPlatform = vi.mocked(recordPlatformBooking);
const mockStampManage = vi.mocked(stampManageToken);
const mockStampContact = vi.mocked(stampAttendeeContact);
const mockAssigneeCounts = vi.mocked(countUpcomingByAssignee);
const mockStampAssignee = vi.mocked(stampAssigneeIfUnset);
const mockClaimAlert = vi.mocked(claimOwnerBookingAlert);
const mockConfirmationEmail = vi.mocked(sendBookingConfirmationEmail);
const mockNotifyAssignee = vi.mocked(notifyAssigneeOfBooking);
const mockMeetingTypes = vi.mocked(listMeetingTypes);
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
  mockBusy.mockResolvedValue({ busy: [], complete: true });
  mockClientFactory.mockResolvedValue(ledgerDb({ data: [], error: null }));
  mockCapture.mockResolvedValue({ created: true });
  mockSlotClaim.mockResolvedValue({ kind: "claimed", id: "claim-1" });
  mockSlotRelease.mockResolvedValue(undefined);
  mockListStarts.mockResolvedValue([]);
  mockRecordPlatform.mockResolvedValue({ ok: true });
  mockStampManage.mockResolvedValue(true);
  mockStampContact.mockResolvedValue(true);
  mockAssigneeCounts.mockResolvedValue(new Map());
  mockStampAssignee.mockResolvedValue(true);
  // Default: this request is the first to reach the owner alert.
  mockClaimAlert.mockResolvedValue({ claimed: true, assigneeMemberId: null });
  mockMarkOffered.mockResolvedValue(undefined);
  mockConfirmationEmail.mockResolvedValue(true);
  mockNotifyAssignee.mockResolvedValue(true);
  mockMeetingTypes.mockResolvedValue([]);
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

  it("resolves by vanity slug without touching the token lookup", async () => {
    const bySlug = vi.mocked(getEnabledBookingPageBySlug);
    bySlug.mockResolvedValueOnce({ ...PAGE, slug: "new-coworker" });
    const out = await getBookingPageContext("new-coworker");
    expect(bySlug).toHaveBeenCalledWith("new-coworker");
    expect(mockPage).not.toHaveBeenCalled();
    expect(out).toMatchObject({ ok: true, context: { businessId: BIZ } });
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

  it("promises a video call on Google Meet alone, with no Zoom connected", async () => {
    mockZoom.mockResolvedValueOnce(null);
    mockMeetEnabled.mockResolvedValueOnce(true);
    mockConn.mockResolvedValueOnce({ provider: "google" } as never);
    expect(await getBookingPageContext(TOKEN)).toMatchObject({
      ok: true,
      context: { videoCall: true, mode: "provider" }
    });
  });

  it("promises nothing in platform mode, where no event can carry a Meet link", async () => {
    // Platform mode is precisely the no-calendar case: the ledger is the
    // calendar of record and the booking gets a synthetic `platform:<uuid>`
    // id, so there is no Google event a conference could live on. The flag
    // must not promise a video call the page cannot produce.
    mockZoom.mockResolvedValueOnce(null);
    mockMeetEnabled.mockResolvedValueOnce(true);
    mockConn.mockResolvedValueOnce(null);
    expect(await getBookingPageContext(TOKEN)).toMatchObject({
      ok: true,
      context: { videoCall: false, mode: "platform" }
    });
  });

  it("promises nothing on a Microsoft calendar, which cannot host a Meet conference", async () => {
    mockZoom.mockResolvedValueOnce(null);
    mockMeetEnabled.mockResolvedValueOnce(true);
    mockConn.mockResolvedValueOnce({ provider: "microsoft" } as never);
    expect(await getBookingPageContext(TOKEN)).toMatchObject({
      ok: true,
      context: { videoCall: false }
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

    // An INCOMPLETE read is unreadable for the owner even though the public
    // page still serves the partial list: this dashboard warning is the only
    // place they find out their availability is not being read in full.
    mockBusy.mockResolvedValueOnce({
      busy: [{ start: new Date("2026-01-05T17:00:00Z"), end: new Date("2026-01-05T18:00:00Z") }],
      complete: false
    });
    expect(await probeCalendarAvailability(BIZ)).toBe("unreadable");

    // ...and it must probe the window the PUBLIC PAGE reads, not a token one.
    // Paging only runs out over a long horizon, so a short probe window would
    // report healthy on exactly the calendars this signal exists to catch.
    mockPageByBusiness.mockResolvedValueOnce({ ...PAGE, max_advance_days: 60 } as never);
    mockBusy.mockClear();
    mockBusy.mockResolvedValueOnce({ busy: [], complete: true });
    await probeCalendarAvailability(BIZ);
    const [, , probeStart, probeEnd] = mockBusy.mock.calls[0];
    const probedDays = (probeEnd.getTime() - probeStart.getTime()) / (24 * 60 * 60 * 1000);
    expect(probedDays).toBe(62);

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

describe("dailyCapReached", () => {
  const DAY_START = new Date("2026-01-05T16:00:00Z");

  it("is never reached when the page is uncapped", async () => {
    expect(
      await dailyCapReached(BIZ, { max_daily_bookings: null }, "America/Phoenix", DAY_START)
    ).toBe(false);
    expect(mockListStarts).not.toHaveBeenCalled();
  });

  it("counts the target's business-local day only", async () => {
    mockListStarts.mockResolvedValue([
      new Date("2026-01-05T17:00:00Z"),
      // Next local day: outside the count even though it is inside the
      // 26 hour read window.
      new Date("2026-01-06T17:00:00Z")
    ]);
    expect(
      await dailyCapReached(BIZ, { max_daily_bookings: 2 }, "America/Phoenix", DAY_START)
    ).toBe(false);
    expect(
      await dailyCapReached(BIZ, { max_daily_bookings: 1 }, "America/Phoenix", DAY_START)
    ).toBe(true);
  });

  it("excludes a booking being moved, so a same-day move never counts itself", async () => {
    mockListStarts.mockResolvedValue([new Date("2026-01-05T17:00:00Z")]);
    expect(
      await dailyCapReached(
        BIZ,
        { max_daily_bookings: 1 },
        "America/Phoenix",
        DAY_START,
        "2026-01-05T17:00:00.000Z"
      )
    ).toBe(false);
    // A junk exclusion is ignored rather than dropping the whole count.
    expect(
      await dailyCapReached(BIZ, { max_daily_bookings: 1 }, "America/Phoenix", DAY_START, "nope")
    ).toBe(true);
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

  it("drops the invitee's own booking from availability when asked", async () => {
    // Their own slot must not block the move (nor count against the day's
    // cap), or a same-day reschedule finds no times at all.
    // Platform mode, where the ledger IS the availability source (in
    // provider mode the ledger is only the degraded baseline).
    mockConn.mockResolvedValue(null);
    mockPageByBusiness.mockResolvedValue({ ...PAGE });
    mockListStarts.mockResolvedValue([new Date("2026-01-05T16:00:00Z")]);

    const blocked = await listSlotsForBusiness(BIZ, 30);
    expect(blocked.ok && blocked.slots.map((s) => s.startIso)).not.toContain(
      "2026-01-05T16:00:00.000Z"
    );

    const freed = await listSlotsForBusiness(BIZ, 30, {
      excludeStartIso: "2026-01-05T16:00:00.000Z"
    });
    expect(freed.ok && freed.slots.map((s) => s.startIso)).toContain("2026-01-05T16:00:00.000Z");

    // A junk value is ignored rather than dropping every booking.
    const junk = await listSlotsForBusiness(BIZ, 30, { excludeStartIso: "not-a-date" });
    expect(junk.ok && junk.slots.map((s) => s.startIso)).not.toContain(
      "2026-01-05T16:00:00.000Z"
    );
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

  it("a meeting type sets the length, and its slug must resolve", async () => {
    mockMeetingTypes.mockResolvedValue([meetingType()]);

    // The type's 60 minutes REPLACES the requested 30, and the page's
    // allowed-duration list does not gate a type's own length.
    const out = await listPublicSlots(TOKEN, 30, undefined, "discovery-call");
    expect(out.ok && out.durationMinutes).toBe(60);

    // A slug that is unknown, disabled, or malformed fails closed rather
    // than quietly listing the page's own availability.
    expect(await listPublicSlots(TOKEN, 30, undefined, "nope-slug")).toEqual({
      ok: false,
      detail: "not_found"
    });
    mockMeetingTypes.mockResolvedValue([meetingType({ enabled: false })]);
    expect(await listPublicSlots(TOKEN, 30, undefined, "discovery-call")).toEqual({
      ok: false,
      detail: "not_found"
    });
    mockMeetingTypes.mockResolvedValue([meetingType()]);
    expect(await listPublicSlots(TOKEN, 30, undefined, "NOT A SLUG")).toEqual({
      ok: false,
      detail: "not_found"
    });
  });

  it("a hidden type still books by its direct link", async () => {
    // Hidden is off the picker, not off the calendar.
    mockMeetingTypes.mockResolvedValue([meetingType({ hidden: true })]);
    const out = await listPublicSlots(TOKEN, 30, undefined, "discovery-call");
    expect(out.ok && out.durationMinutes).toBe(60);
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
    mockBusy.mockResolvedValueOnce({ busy: [span], complete: true });
    const out = await listPublicSlots(TOKEN, 30);
    expect(out.ok).toBe(true);
    expect(mockCacheSave).toHaveBeenCalledTimes(1);
    const [bizArg, winStart, winEnd, spans] = mockCacheSave.mock.calls[0];
    expect(bizArg).toBe(BIZ);
    expect(winStart.getTime()).toBeLessThan(winEnd.getTime());
    expect(spans).toEqual([span]);
    expect(mockCacheRead).not.toHaveBeenCalled();
  });

  it("uses an incomplete provider read instead of degrading past it", async () => {
    // Graph paging cut short. Every block returned is really busy, so serving
    // them blocks strictly MORE than the degraded ledger-plus-cache baseline
    // would. Discarding a partial read to "fail safe" would offer more taken
    // slots, not fewer, which is the opposite of safe.
    const span = { start: new Date("2026-01-05T17:00:00Z"), end: new Date("2026-01-05T18:00:00Z") };
    mockBusy.mockResolvedValueOnce({ busy: [span], complete: false });
    mockListStarts.mockResolvedValueOnce([new Date("2026-01-05T16:00:00Z")]);

    const out = await listPublicSlots(TOKEN, 30);

    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("unreachable");
    const starts = out.slots.map((s) => s.startIso);
    expect(starts).not.toContain("2026-01-05T17:00:00.000Z"); // the partial read
    expect(starts).not.toContain("2026-01-05T16:00:00.000Z"); // ledger, still unioned
    expect(starts).toContain("2026-01-05T18:00:00.000Z");
    // It must not consult the cache: it has live data, just not all of it.
    expect(mockCacheRead).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      "booking-page: provider busy incomplete; using partial read uncached",
      expect.objectContaining({ businessId: BIZ, blocks: 1 })
    );
  });

  it("never persists an incomplete read as the last-known-good snapshot", async () => {
    // The cache serves FUTURE outages. Writing an under-report into it would
    // let one oversized window keep reopening booked time long after the read
    // that produced it, and a window that never fits the page budget would
    // never refresh the snapshot at all.
    mockBusy.mockResolvedValueOnce({
      busy: [{ start: new Date("2026-01-05T17:00:00Z"), end: new Date("2026-01-05T18:00:00Z") }],
      complete: false
    });

    const out = await listPublicSlots(TOKEN, 30);

    expect(out.ok).toBe(true);
    expect(mockCacheSave).not.toHaveBeenCalled();
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
        videoJoinUrl: "https://zoom.example/j/1"
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
      videoJoinUrl: null,
      // A retry must not mint a SECOND manage token: the first
      // confirmation already carried the link to this booking.
      manageLink: null
    });
    expect(mockBook).not.toHaveBeenCalled();
    expect(mockSlotClaim).not.toHaveBeenCalled();
    // Reminder addressing is re-stamped (idempotent) in case the first
    // submit landed the booking and died before stamping, intake answers
    // included (their last chance to land). The confirmation email is NOT
    // re-sent: a duplicate is worse than none.
    expect(mockStampContact).toHaveBeenCalledWith(
      BIZ,
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ intakeAnswers: null })
    );
    expect(mockConfirmationEmail).not.toHaveBeenCalled();

    // The retry also settles the assignment, or a shared page's booking
    // stays unassigned forever and skews the round-robin counts.
    mockPage.mockResolvedValue({ ...PAGE, assignment_mode: "round_robin" });
    mockMembers.mockResolvedValue([
      { id: "m-ana", active: true, weekly_schedule: null, last_offered_at: null }
    ] as never);
    mockTimeOff.mockResolvedValue([]);
    mockUpcomingForAttendee.mockResolvedValueOnce([
      { startIso: "2026-01-05T16:00:00.000Z", eventId: "evt-1" }
    ] as never);
    mockStampContact.mockClear();
    expect((await submitPublicBooking(TOKEN, VALID)).ok).toBe(true);
    // Conditional fill, so a retry repairs a gap without reassigning work
    // that is already on somebody's calendar.
    expect(mockStampAssignee).toHaveBeenCalledWith(
      BIZ,
      "phone:+14805550100",
      "2026-01-05T16:00:00.000Z",
      "m-ana"
    );

    // A failed fill is swallowed: the appointment is real either way. And
    // with nothing filled, the tiebreak must not move.
    mockUpcomingForAttendee.mockResolvedValueOnce([
      { startIso: "2026-01-05T16:00:00.000Z", eventId: "evt-1" }
    ] as never);
    mockStampAssignee.mockRejectedValueOnce(new Error("denied"));
    mockMarkOffered.mockClear();
    expect((await submitPublicBooking(TOKEN, VALID)).ok).toBe(true);
    expect(mockMarkOffered).not.toHaveBeenCalled();

    // A resubmit whose booking ALREADY has an assignee is a no-op repair:
    // no fill, no tiebreak movement (a harmless retry must not skew who
    // wins the next tie).
    mockUpcomingForAttendee.mockResolvedValueOnce([
      { startIso: "2026-01-05T16:00:00.000Z", eventId: "evt-1" }
    ] as never);
    mockStampAssignee.mockResolvedValueOnce(false);
    mockMarkOffered.mockClear();
    mockUnassignedAlert.mockClear();
    // The owner was already told when the booking landed, so the claim is
    // gone: a repair that repaired nothing is not news.
    mockClaimAlert.mockResolvedValueOnce({ claimed: false, assigneeMemberId: "m-ana" });
    expect((await submitPublicBooking(TOKEN, VALID)).ok).toBe(true);
    expect(mockMarkOffered).not.toHaveBeenCalled();
    expect(mockUnassignedAlert).not.toHaveBeenCalled();

    // A claim that throws on the RESUBMIT path fails silent instead: the
    // overwhelmingly likely case there is a booking already alerted, and a
    // duplicate page is worse than not repeating news the owner has.
    mockUpcomingForAttendee.mockResolvedValueOnce([
      { startIso: "2026-01-05T16:00:00.000Z", eventId: "evt-1" }
    ] as never);
    mockStampAssignee.mockResolvedValueOnce(false);
    mockUnassignedAlert.mockClear();
    mockClaimAlert.mockRejectedValueOnce(new Error("claim read failed"));
    expect((await submitPublicBooking(TOKEN, VALID)).ok).toBe(true);
    expect(mockUnassignedAlert).not.toHaveBeenCalled();

    // Non-Error rejection, same silence.
    mockUpcomingForAttendee.mockResolvedValueOnce([
      { startIso: "2026-01-05T16:00:00.000Z", eventId: "evt-1" }
    ] as never);
    mockStampAssignee.mockResolvedValueOnce(false);
    mockClaimAlert.mockRejectedValueOnce("resubmit claim string sad");
    expect((await submitPublicBooking(TOKEN, VALID)).ok).toBe(true);
    expect(mockUnassignedAlert).not.toHaveBeenCalled();

    // But if the FIRST request persisted the booking and died before
    // alerting, the claim is still open and this resubmit is the only thing
    // that will ever tell the owner the appointment exists.
    mockUpcomingForAttendee.mockResolvedValueOnce([
      { startIso: "2026-01-05T16:00:00.000Z", eventId: "evt-1" }
    ] as never);
    mockStampAssignee.mockResolvedValueOnce(false);
    mockUnassignedAlert.mockClear();
    mockClaimAlert.mockResolvedValueOnce({ claimed: true, assigneeMemberId: "m-ana" });
    expect((await submitPublicBooking(TOKEN, VALID)).ok).toBe(true);
    expect(mockUnassignedAlert).toHaveBeenCalledWith(
      BIZ,
      expect.objectContaining({
        surface: "booking_page",
        // Whoever the row says holds it, since this retry filled nothing.
        bookingAssigneeMemberId: "m-ana"
      })
    );

    // And when the retry genuinely fills the gap, the tiebreak advances
    // and the member finally hears about the booking (the gap-fill is the
    // first time it had an owner).
    mockUpcomingForAttendee.mockResolvedValueOnce([
      { startIso: "2026-01-05T16:00:00.000Z", eventId: "evt-1" }
    ] as never);
    mockStampAssignee.mockResolvedValueOnce(true);
    mockMarkOffered.mockClear();
    mockMarkOffered.mockRejectedValueOnce(new Error("update denied"));
    mockNotifyAssignee.mockClear();
    expect((await submitPublicBooking(TOKEN, VALID)).ok).toBe(true);
    expect(mockMarkOffered).toHaveBeenCalledWith("m-ana");
    expect(mockNotifyAssignee).toHaveBeenCalledWith(BIZ, "m-ana", expect.anything());
    // The OWNER hears about it too, and only here: this is the first moment
    // the booking has somebody to name. A resubmit that fills nothing stays
    // silent (asserted above by the absence of a call), so this cannot
    // become a second alert for the same booking.
    // A gap-fill is news even when the owner was already told about the
    // booking: WHO has it is what changed.
    expect(mockUnassignedAlert).toHaveBeenCalledWith(
      BIZ,
      expect.objectContaining({
        bookingAssigneeMemberId: "m-ana",
        surface: "booking_page"
      })
    );

    // A gap-fill on a note-less booking carries no note, rather than an
    // empty string that would render a dangling "Their note:" line.
    mockUpcomingForAttendee.mockResolvedValueOnce([
      { startIso: "2026-01-05T16:00:00.000Z", eventId: "evt-1" }
    ] as never);
    mockStampAssignee.mockResolvedValueOnce(true);
    mockUnassignedAlert.mockClear();
    const { note: _noteless, ...withoutNote } = VALID;
    void _noteless;
    expect((await submitPublicBooking(TOKEN, withoutNote)).ok).toBe(true);
    expect(mockUnassignedAlert).toHaveBeenCalledWith(
      BIZ,
      expect.objectContaining({ note: null })
    );

    // The toggle silences the retry path too.
    mockPage.mockResolvedValue({
      ...PAGE,
      assignment_mode: "round_robin",
      notify_assignee: false
    });
    mockUpcomingForAttendee.mockResolvedValueOnce([
      { startIso: "2026-01-05T16:00:00.000Z", eventId: "evt-1" }
    ] as never);
    mockStampAssignee.mockResolvedValueOnce(true);
    mockNotifyAssignee.mockClear();
    expect((await submitPublicBooking(TOKEN, VALID)).ok).toBe(true);
    expect(mockNotifyAssignee).not.toHaveBeenCalled();

    // A failed resolution on the retry is still a successful answer.
    mockUpcomingForAttendee.mockResolvedValueOnce([
      { startIso: "2026-01-05T16:00:00.000Z", eventId: "evt-1" }
    ] as never);
    mockAssigneeCounts.mockRejectedValueOnce(new Error("count failed"));
    expect((await submitPublicBooking(TOKEN, VALID)).ok).toBe(true);

    // A failed re-stamp still answers the resubmit successfully: the
    // appointment is real either way.
    for (const boom of [new Error("update denied"), "string boom"]) {
      mockUpcomingForAttendee.mockResolvedValueOnce([
        { startIso: "2026-01-05T16:00:00.000Z", eventId: "evt-1" }
      ] as never);
      mockStampContact.mockRejectedValueOnce(boom);
      expect((await submitPublicBooking(TOKEN, VALID)).ok).toBe(true);
    }
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

  it("sends the confirmation email, and never lets it fail the booking", async () => {
    const out = await submitPublicBooking(TOKEN, { ...VALID, visitorTimeZone: "America/New_York" });
    expect(out.ok).toBe(true);
    expect(mockConfirmationEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: BIZ,
        attendeeEmail: VALID.email,
        visitorTimeZone: "America/New_York"
      })
    );
    // Reminder addressing: the ledger is phone-keyed, so the email and name
    // are stamped onto the row.
    expect(mockStampContact).toHaveBeenCalledWith(
      BIZ,
      "phone:+14805550100",
      "2026-01-05T16:00:00.000Z",
      expect.objectContaining({ email: VALID.email, name: VALID.name })
    );

    // A stamp that matches no row is reported (reminders would silently
    // never reach them) but still never costs the booking.
    mockStampContact.mockResolvedValue(false);
    expect((await submitPublicBooking(TOKEN, VALID)).ok).toBe(true);

    // A dead mailbox (or a failed stamp) must not cost the visitor their
    // appointment.
    mockConfirmationEmail.mockRejectedValue(new Error("gmail 500"));
    mockStampContact.mockRejectedValue(new Error("update denied"));
    expect((await submitPublicBooking(TOKEN, VALID)).ok).toBe(true);

    mockConfirmationEmail.mockRejectedValue("string boom");
    mockStampContact.mockRejectedValue("string boom");
    expect((await submitPublicBooking(TOKEN, VALID)).ok).toBe(true);
  });

  it("skips the confirmation email when the owner turned it off", async () => {
    mockPage.mockResolvedValue({ ...PAGE, send_confirmation_email: false });
    expect((await submitPublicBooking(TOKEN, VALID)).ok).toBe(true);
    expect(mockConfirmationEmail).not.toHaveBeenCalled();
  });

  it("names who a shared page's booking belongs to", async () => {
    mockPage.mockResolvedValue({ ...PAGE, assignment_mode: "round_robin" });
    mockMembers.mockResolvedValue([
      { id: "m-ana", active: true, weekly_schedule: null, last_offered_at: null },
      { id: "m-ben", active: true, weekly_schedule: null, last_offered_at: null }
    ] as never);
    mockTimeOff.mockResolvedValue([]);
    mockAssigneeCounts.mockResolvedValue(new Map([["m-ana", 4]]));
    // The booking core answering WITHOUT a human-readable time exercises
    // the notifier's fallback formatting.
    mockBook.mockResolvedValueOnce({ ok: true, data: { eventId: "evt-1" } });

    expect((await submitPublicBooking(TOKEN, VALID)).ok).toBe(true);
    // The lighter load gets it, recorded on the booking row.
    expect(mockStampContact).toHaveBeenCalledWith(
      BIZ,
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ assigneeMemberId: "m-ben" })
    );
    // The tiebreak advances, or two members on equal load would forever
    // resolve to the same person.
    expect(mockMarkOffered).toHaveBeenCalledWith("m-ben");
    // And the person who must show up hears about it, with a readable time
    // even when the booking core answered without one (the fallback
    // formats it from the instant).
    expect(mockNotifyAssignee).toHaveBeenCalledWith(
      BIZ,
      "m-ben",
      expect.objectContaining({
        visitorName: VALID.name,
        visitorPhone: "+14805550100",
        durationMinutes: 30,
        startLocal: expect.stringContaining("9:00")
      })
    );

    // A stamp that does not land silences the text: the resubmit's
    // gap-fill is the one true ownership moment then, and texting both
    // times would double.
    mockNotifyAssignee.mockClear();
    mockStampContact.mockResolvedValueOnce(false);
    expect((await submitPublicBooking(TOKEN, VALID)).ok).toBe(true);
    expect(mockNotifyAssignee).not.toHaveBeenCalled();

    mockNotifyAssignee.mockClear();
    mockStampContact.mockRejectedValueOnce(new Error("update denied"));
    expect((await submitPublicBooking(TOKEN, VALID)).ok).toBe(true);
    expect(mockNotifyAssignee).not.toHaveBeenCalled();

    // The owner's toggle turns just the text off; assignment still happens.
    mockNotifyAssignee.mockClear();
    mockPage.mockResolvedValue({
      ...PAGE,
      assignment_mode: "round_robin",
      notify_assignee: false
    });
    expect((await submitPublicBooking(TOKEN, VALID)).ok).toBe(true);
    expect(mockNotifyAssignee).not.toHaveBeenCalled();

    // A failed advance still books and still assigns: it only costs
    // fairness on the next tie.
    mockMarkOffered.mockRejectedValueOnce(new Error("update denied"));
    expect((await submitPublicBooking(TOKEN, VALID)).ok).toBe(true);
    mockMarkOffered.mockRejectedValueOnce("string boom");
    expect((await submitPublicBooking(TOKEN, VALID)).ok).toBe(true);
  });

  it("still books when the assignee cannot be resolved (the time is already theirs)", async () => {
    mockPage.mockResolvedValue({ ...PAGE, assignment_mode: "round_robin" });
    mockMembers.mockResolvedValue([
      { id: "m-ana", active: true, weekly_schedule: null, last_offered_at: null }
    ] as never);
    mockTimeOff.mockResolvedValue([]);
    // Only the load read fails: availability itself is fine, so the visitor
    // holds the time and the assignment is what is lost.
    mockAssigneeCounts.mockRejectedValue(new Error("count failed"));
    expect((await submitPublicBooking(TOKEN, VALID)).ok).toBe(true);
    expect(mockStampContact).toHaveBeenCalledWith(
      BIZ,
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ assigneeMemberId: null })
    );

    mockAssigneeCounts.mockRejectedValue("string boom");
    expect((await submitPublicBooking(TOKEN, VALID)).ok).toBe(true);
  });

  it("leaves the booking unassigned, and says so, when nobody is on shift", async () => {
    mockPage.mockResolvedValue({ ...PAGE, assignment_mode: "round_robin" });
    // On shift when the slot was verified, then deactivated before the
    // assignment read. The booking still stands (the visitor holds the
    // time); only the assignment is lost.
    mockMembers
      .mockResolvedValueOnce([
        { id: "m-ana", active: true, weekly_schedule: null, last_offered_at: null }
      ] as never)
      .mockResolvedValue([
        { id: "m-ana", active: false, weekly_schedule: null, last_offered_at: null }
      ] as never);
    mockTimeOff.mockResolvedValue([]);
    expect((await submitPublicBooking(TOKEN, VALID)).ok).toBe(true);
    expect(mockStampContact).toHaveBeenCalledWith(
      BIZ,
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ assigneeMemberId: null })
    );
  });

  it("records nobody for an unassigned page", async () => {
    expect((await submitPublicBooking(TOKEN, VALID)).ok).toBe(true);
    expect(mockStampContact).toHaveBeenCalledWith(
      BIZ,
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ assigneeMemberId: null })
    );
    // No roster read, no tiebreak write, and no member text at all on the
    // unassigned path.
    expect(mockAssigneeCounts).not.toHaveBeenCalled();
    expect(mockMarkOffered).not.toHaveBeenCalled();
    expect(mockNotifyAssignee).not.toHaveBeenCalled();
  });

  it("a resubmit carries the intake answers too (their last chance to land)", async () => {
    mockPage.mockResolvedValue({
      ...PAGE,
      intake_questions: [
        { id: "project", label: "Project?", type: "choice", options: ["A", "B"], required: true }
      ]
    });
    mockUpcomingForAttendee.mockResolvedValueOnce([
      { startIso: "2026-01-05T16:00:00.000Z", eventId: "evt-1" }
    ] as never);
    expect(
      (await submitPublicBooking(TOKEN, { ...VALID, intakeAnswers: { project: "A" } })).ok
    ).toBe(true);
    expect(mockStampContact).toHaveBeenCalledWith(
      BIZ,
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ intakeAnswers: { project: "A" } })
    );
  });

  it("refuses to book a page that requires payment (collection has not shipped)", async () => {
    // The one invariant this phase must hold: a paid page never hands out
    // free appointments, and nothing is claimed or written in refusing.
    mockPage.mockResolvedValue({
      ...PAGE,
      payment_required: true,
      payment_amount_cents: 5000
    });
    expect(await submitPublicBooking(TOKEN, VALID)).toEqual({
      ok: false,
      detail: "payment_required"
    });
    expect(mockSlotClaim).not.toHaveBeenCalled();
    expect(mockBook).not.toHaveBeenCalled();
    expect(mockStampContact).not.toHaveBeenCalled();

    // A visitor who ALREADY holds this appointment gets their idempotent
    // success (with its repair stamps), same precedent as the intake gate:
    // only a fresh booking is refused.
    mockUpcomingForAttendee.mockResolvedValueOnce([
      { startIso: "2026-01-05T16:00:00.000Z", eventId: "evt-1" }
    ] as never);
    expect((await submitPublicBooking(TOKEN, VALID)).ok).toBe(true);
    expect(mockStampContact).toHaveBeenCalled();
  });

  it("a PAUSED required question neither blocks the booking nor lands in the notes", async () => {
    mockPage.mockResolvedValue({
      ...PAGE,
      intake_questions: [
        {
          id: "project",
          label: "Project?",
          type: "choice",
          options: ["A", "B"],
          required: true,
          enabled: false
        }
      ]
    });
    expect((await submitPublicBooking(TOKEN, VALID)).ok).toBe(true);
    expect(String(mockBook.mock.calls[0][1].notes)).not.toContain("Project?");
  });

  it("books a meeting type: its length, its name on the event, stamped on the row", async () => {
    mockMeetingTypes.mockResolvedValue([meetingType()]);
    const out = await submitPublicBooking(TOKEN, {
      ...VALID,
      meetingTypeSlug: "discovery-call"
    });
    expect(out.ok).toBe(true);
    // The type's 60 minutes wins over the 30 the client asked for.
    if (!out.ok) throw new Error("unreachable");
    expect(out.endIso).toBe("2026-01-05T17:00:00.000Z");
    expect(mockBook).toHaveBeenCalledWith(
      BIZ,
      expect.objectContaining({
        // The core takes the window, and it spans the type's 60 minutes.
        startIso: "2026-01-05T16:00:00.000Z",
        endIso: "2026-01-05T17:00:00.000Z",
        summary: expect.stringContaining(": Discovery call")
      }),
      expect.anything(),
      expect.anything()
    );
    // The dashboard and reminders need to know WHAT was booked.
    expect(mockStampContact).toHaveBeenCalledWith(
      BIZ,
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ meetingTypeId: "mt-discovery" })
    );
  });

  it("refuses a dead meeting link instead of booking the page's default", async () => {
    mockMeetingTypes.mockResolvedValue([meetingType({ enabled: false })]);
    expect(
      await submitPublicBooking(TOKEN, { ...VALID, meetingTypeSlug: "discovery-call" })
    ).toEqual({ ok: false, detail: "not_found" });
    expect(mockBook).not.toHaveBeenCalled();
  });

  it("asks the TYPE's questions, not the page's", async () => {
    mockPage.mockResolvedValue({
      ...PAGE,
      intake_questions: [
        { id: "page-q", label: "Page question?", type: "text", required: true }
      ]
    });
    mockMeetingTypes.mockResolvedValue([
      meetingType({
        intake_questions: [
          { id: "topic", label: "Topic?", type: "text", required: true }
        ]
      })
    ]);

    // The page's required question does not apply to this meeting...
    const out = await submitPublicBooking(TOKEN, {
      ...VALID,
      meetingTypeSlug: "discovery-call",
      intakeAnswers: { topic: "Pricing" }
    });
    expect(out.ok).toBe(true);
    expect(String(mockBook.mock.calls[0][1].notes)).toContain("Topic?: Pricing");
    expect(String(mockBook.mock.calls[0][1].notes)).not.toContain("Page question?");

    // ...and the type's own required question does.
    expect(
      await submitPublicBooking(TOKEN, { ...VALID, meetingTypeSlug: "discovery-call" })
    ).toEqual({ ok: false, detail: "missing_answers" });
  });

  it("honors the TYPE's assignment and price over the page's", async () => {
    mockPage.mockResolvedValue({ ...PAGE, assignment_mode: "any" });
    mockMembers.mockResolvedValue([
      { id: "m-ana", active: true, weekly_schedule: null, last_offered_at: null }
    ] as never);
    mockTimeOff.mockResolvedValue([]);
    mockMeetingTypes.mockResolvedValue([
      meetingType({ assignment_mode: "fixed", employee_id: "m-ana" })
    ]);
    expect(
      (await submitPublicBooking(TOKEN, { ...VALID, meetingTypeSlug: "discovery-call" })).ok
    ).toBe(true);
    expect(mockStampContact).toHaveBeenCalledWith(
      BIZ,
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ assigneeMemberId: "m-ana" })
    );

    // A paid meeting on a free page still refuses until collection ships.
    mockMeetingTypes.mockResolvedValue([
      meetingType({ payment_required: true, payment_amount_cents: 5000 })
    ]);
    expect(
      await submitPublicBooking(TOKEN, { ...VALID, meetingTypeSlug: "discovery-call" })
    ).toEqual({ ok: false, detail: "payment_required" });
  });

  it("refuses a submission missing a required intake answer BEFORE any claim", async () => {
    mockPage.mockResolvedValue({
      ...PAGE,
      intake_questions: [
        { id: "project", label: "Project?", type: "choice", options: ["A", "B"], required: true }
      ]
    });
    expect(await submitPublicBooking(TOKEN, VALID)).toEqual({
      ok: false,
      detail: "missing_answers"
    });
    expect(mockSlotClaim).not.toHaveBeenCalled();
    expect(mockBook).not.toHaveBeenCalled();
  });

  it("a resubmit wins over a stale form: idempotent success despite a new required question", async () => {
    // The owner added a required question AFTER the visitor booked; the
    // retry for the same start is still the idempotent success, stamping
    // whatever answers it carried (here: none).
    mockPage.mockResolvedValue({
      ...PAGE,
      intake_questions: [
        { id: "project", label: "Project?", type: "choice", options: ["A", "B"], required: true }
      ]
    });
    mockUpcomingForAttendee.mockResolvedValueOnce([
      { startIso: "2026-01-05T16:00:00.000Z", eventId: "evt-1" }
    ] as never);
    expect((await submitPublicBooking(TOKEN, VALID)).ok).toBe(true);
    expect(mockStampContact).toHaveBeenCalledWith(
      BIZ,
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ intakeAnswers: null })
    );
  });

  it("platform mode: the Zoom agenda carries the note and the intake answers", async () => {
    mockConn.mockResolvedValue(null);
    mockPage.mockResolvedValue({
      ...PAGE,
      intake_questions: [
        { id: "project", label: "Project?", type: "choice", options: ["A", "B"], required: true }
      ]
    });
    expect(
      (
        await submitPublicBooking(TOKEN, {
          ...VALID,
          note: "Side gate is open",
          intakeAnswers: { project: "A" }
        })
      ).ok
    ).toBe(true);
    expect(mockZoomCreate).toHaveBeenCalledWith(
      BIZ,
      expect.objectContaining({ agenda: "Side gate is open\nProject?: A" })
    );
  });

  it("carries the intake answers into the event notes and onto the booking row", async () => {
    mockPage.mockResolvedValue({
      ...PAGE,
      intake_questions: [
        { id: "project", label: "Project?", type: "choice", options: ["A", "B"], required: true }
      ]
    });
    expect(
      (await submitPublicBooking(TOKEN, { ...VALID, intakeAnswers: { project: "A" } })).ok
    ).toBe(true);
    // The person taking the call reads the answers on the event itself.
    expect(mockBook).toHaveBeenCalledWith(
      BIZ,
      expect.objectContaining({ notes: expect.stringContaining("Project?: A") }),
      expect.anything(),
      expect.anything()
    );
    // And the row keeps the structured answers for the dashboard.
    expect(mockStampContact).toHaveBeenCalledWith(
      BIZ,
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ intakeAnswers: { project: "A" } })
    );
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
      videoJoinUrl: "https://zoom.example/j/1",
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
      // No alertSurface: the page fires its own owner alert once, after the
      // contact and the assignee exist. Letting the booking core fire it
      // would put it back before both writes.
      { trustProvidedName: true }
    );
    expect(mockCapture).toHaveBeenCalledWith(BIZ, {
      e164: "+14805550100",
      name: "Liz Developer",
      email: "liz@example.com",
      // Its own channel, not the borrowed "webchat": nobody chatted with
      // the widget, and a later real chat must be able to move the value.
      channel: "booking_page",
      sourceTag: BOOKING_PAGE_SOURCE_TAG
    });
  });

  it("omits the note line when empty and nulls missing booking-core extras", async () => {
    mockBook.mockResolvedValueOnce({ ok: true, data: { eventId: "evt-2" } });
    const out = await submitPublicBooking(TOKEN, { ...VALID, note: "  " });
    expect(out).toMatchObject({ ok: true, startLocal: null, videoJoinUrl: null });
    const args = mockBook.mock.calls[0][1];
    expect(args.notes).not.toContain("Note:");
  });

  it("handles an omitted note and a data-less booking result", async () => {
    mockBook.mockResolvedValueOnce({ ok: true, detail: "already_booked" });
    const { note: _unused, ...noNote } = VALID;
    void _unused;
    const out = await submitPublicBooking(TOKEN, noNote);
    expect(out).toMatchObject({ ok: true, startLocal: null, videoJoinUrl: null });
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
        videoJoinUrl: "https://zoom.example/j/9",
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
          // The visitor booked this themselves, and the alert names the real
          // ledger row rather than a literal "platform".
          surface: "booking_page",
          eventId: expect.stringMatching(/^platform:/),
          // Context the owner needs in order to show up.
          durationMinutes: 30,
          joinUrl: "https://zoom.example/j/9",
          note: "Referred by James"
        })
      );
      expect(mockCapture).toHaveBeenCalledTimes(1);
      expect(mockSlotRelease).not.toHaveBeenCalled();
    });

    it("alerts the owner only AFTER the contact is filed and the assignee is stamped", async () => {
      // The defect this pins (HQ internal, Aug 3 2026): the alert reports who
      // is on the hook, and it used to run inside the booking write, before
      // either fact existed. Order is the assertion, so a future refactor
      // that moves the call back earlier fails here rather than in
      // production.
      const order: string[] = [];
      mockCapture.mockImplementation(async () => {
        order.push("capture");
        return undefined as never;
      });
      mockStampContact.mockImplementation(async () => {
        order.push("stamp");
        return true;
      });
      mockUnassignedAlert.mockImplementation(async () => {
        order.push("alert");
        return "sent_solo";
      });

      await submitPublicBooking(TOKEN, VALID);

      expect(order).toEqual(["capture", "stamp", "alert"]);
    });

    it("a resubmit alerts only AFTER its contact re-stamp, like the primary path", async () => {
      // The retry branch had the same inversion this PR removes from the
      // primary path: the alert reports who is on the hook, so it must not
      // run before the stamp that can change the answer.
      const order: string[] = [];
      mockStampContact.mockImplementation(async () => {
        order.push("stamp");
        return true;
      });
      mockUnassignedAlert.mockImplementation(async () => {
        order.push("alert");
        return "sent_solo";
      });
      mockUpcomingForAttendee.mockResolvedValueOnce([
        { startIso: "2026-01-05T16:00:00.000Z", eventId: "evt-1" }
      ] as never);
      mockStampAssignee.mockResolvedValueOnce(false);
      mockClaimAlert.mockResolvedValueOnce({ claimed: true, assigneeMemberId: null });

      expect((await submitPublicBooking(TOKEN, VALID)).ok).toBe(true);

      expect(order).toEqual(["stamp", "alert"]);
    });

    it("stays silent when another request already claimed the alert", async () => {
      // Two requests racing for one booking: whichever wins the claim pages
      // the owner, and the loser must not page them again.
      mockClaimAlert.mockResolvedValueOnce({ claimed: false, assigneeMemberId: null });
      mockUnassignedAlert.mockClear();
      expect((await submitPublicBooking(TOKEN, VALID)).ok).toBe(true);
      expect(mockUnassignedAlert).not.toHaveBeenCalled();
    });

    it("alerts anyway when the claim itself cannot be written", async () => {
      // The claim exists to prevent a DOUBLE alert. If it cannot be written
      // we still send: an owner who might hear about a booking twice is a
      // far better failure than an appointment nobody knows about.
      mockClaimAlert.mockRejectedValueOnce(new Error("claim column missing"));
      mockUnassignedAlert.mockClear();
      expect((await submitPublicBooking(TOKEN, VALID)).ok).toBe(true);
      expect(mockUnassignedAlert).toHaveBeenCalled();

      // Same for a non-Error rejection, which a driver can throw.
      mockClaimAlert.mockRejectedValueOnce("claim string sad");
      mockUnassignedAlert.mockClear();
      expect((await submitPublicBooking(TOKEN, VALID)).ok).toBe(true);
      expect(mockUnassignedAlert).toHaveBeenCalled();
    });

    it("books without Zoom when none is connected (note omitted too)", async () => {
      mockZoomCreate.mockResolvedValueOnce(null);
      const { note: _unused, ...noNote } = VALID;
      void _unused;
      const out = await submitPublicBooking(TOKEN, noNote);
      expect(out).toMatchObject({ ok: true, videoJoinUrl: null });
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

/**
 * Broadcast mode ("first to reply 1 takes it"): the page books nobody at
 * booking time; a claim row + invites pick the assignee later. The
 * solo-owner collapse (the #1500 rule) stamps the owner directly instead
 * of racing them against themselves.
 */
describe("submitPublicBooking: broadcast assignment", () => {
  const VALID = {
    startIso: "2026-01-05T16:00:00.000Z",
    durationMinutes: 30,
    name: "Pat Visitor",
    phone: "+14805550100",
    email: "pat@example.com"
  };
  const TEAM = [
    { id: "m-1", name: "Ana", phone_e164: "+14805550111", active: true, weekly_schedule: null, last_offered_at: null },
    { id: "m-2", name: "Ben", phone_e164: "+14805550112", active: true, weekly_schedule: null, last_offered_at: null }
  ];
  const OWNER_PHONE = "+16026866672";

  beforeEach(() => {
    mockPage.mockResolvedValue({ ...PAGE, assignment_mode: "broadcast" } as never);
    vi.mocked(businessOwnerNumbers).mockResolvedValue([]);
    vi.mocked(findDedupeRowId).mockResolvedValue("dedupe-row-1");
    vi.mocked(broadcastBookingClaim).mockResolvedValue(["+14805550111", "+14805550112"]);
  });

  it("parks a claim + invites the team, stamps nobody, and feeds the alert the invited phones", async () => {
    mockMembers.mockResolvedValue(TEAM as never);
    const out = await submitPublicBooking(TOKEN, VALID);
    expect(out.ok).toBe(true);

    // Nobody is picked at booking time.
    expect(mockStampContact).toHaveBeenCalledWith(
      BIZ,
      "phone:+14805550100",
      "2026-01-05T16:00:00.000Z",
      expect.objectContaining({ assigneeMemberId: null })
    );
    expect(mockNotifyAssignee).not.toHaveBeenCalled();
    expect(mockMarkOffered).not.toHaveBeenCalled();

    // One claim row + invites for the textable roster.
    expect(vi.mocked(broadcastBookingClaim)).toHaveBeenCalledWith(
      BIZ,
      "dedupe-row-1",
      expect.arrayContaining([
        expect.objectContaining({ id: "m-1" }),
        expect.objectContaining({ id: "m-2" })
      ]),
      expect.objectContaining({ visitorName: "Pat Visitor", visitorPhone: "+14805550100" })
    );

    // The owner alert knows who was already texted, so its employee leg
    // cannot double-text an invitee.
    expect(mockUnassignedAlert).toHaveBeenCalledWith(
      BIZ,
      expect.objectContaining({
        bookingAssigneeMemberId: null,
        employeesAlreadyInvited: ["+14805550111", "+14805550112"]
      })
    );
  });

  it("solo owner-only roster: stamps the owner, no invites, no assignee text", async () => {
    mockMembers.mockResolvedValue([
      { id: "m-owner", name: "Brian", phone_e164: OWNER_PHONE, active: true, weekly_schedule: null, last_offered_at: null }
    ] as never);
    vi.mocked(businessOwnerNumbers).mockResolvedValue([OWNER_PHONE]);

    const out = await submitPublicBooking(TOKEN, VALID);
    expect(out.ok).toBe(true);
    expect(mockStampContact).toHaveBeenCalledWith(
      BIZ,
      "phone:+14805550100",
      "2026-01-05T16:00:00.000Z",
      expect.objectContaining({ assigneeMemberId: "m-owner" })
    );
    // The assignee IS the owner: the owner alert covers them, so the
    // separate assignee text must not double-page the same person.
    expect(mockNotifyAssignee).not.toHaveBeenCalled();
    expect(vi.mocked(broadcastBookingClaim)).not.toHaveBeenCalled();
    expect(mockUnassignedAlert).toHaveBeenCalledWith(
      BIZ,
      expect.objectContaining({
        bookingAssigneeMemberId: "m-owner",
        employeesAlreadyInvited: []
      })
    );
  });

  it("no dedupe row found: no invites, booking simply stays unassigned", async () => {
    mockMembers.mockResolvedValue(TEAM as never);
    vi.mocked(findDedupeRowId).mockResolvedValue(null);
    const out = await submitPublicBooking(TOKEN, VALID);
    expect(out.ok).toBe(true);
    expect(vi.mocked(broadcastBookingClaim)).not.toHaveBeenCalled();
    expect(mockUnassignedAlert).toHaveBeenCalledWith(
      BIZ,
      expect.objectContaining({ employeesAlreadyInvited: [] })
    );
  });

  it("nobody textable: warns and books unassigned with no claim machinery", async () => {
    mockMembers.mockResolvedValue([
      { id: "m-4", name: "Nophone", phone_e164: "", active: true, weekly_schedule: null, last_offered_at: null }
    ] as never);
    const out = await submitPublicBooking(TOKEN, VALID);
    expect(out.ok).toBe(true);
    expect(vi.mocked(findDedupeRowId)).not.toHaveBeenCalled();
    expect(vi.mocked(broadcastBookingClaim)).not.toHaveBeenCalled();
  });
});

describe("submitPublicBooking: broadcast startLocal fallback", () => {
  it("derives the invite's local start when the booking core answered none", async () => {
    mockPage.mockResolvedValue({ ...PAGE, assignment_mode: "broadcast" } as never);
    vi.mocked(businessOwnerNumbers).mockResolvedValue([]);
    vi.mocked(findDedupeRowId).mockResolvedValue("dedupe-row-1");
    vi.mocked(broadcastBookingClaim).mockResolvedValue([]);
    mockMembers.mockResolvedValue([
      { id: "m-1", name: "Ana", phone_e164: "+14805550111", active: true, weekly_schedule: null, last_offered_at: null }
    ] as never);
    // Platform-mode shape: the booking is durable but carries no startLocal.
    mockBook.mockResolvedValueOnce({ ok: true, data: { eventId: "ev-x" } } as never);
    const out = await submitPublicBooking(TOKEN, {
      startIso: "2026-01-05T16:00:00.000Z",
      durationMinutes: 30,
      name: "Pat Visitor",
      phone: "+14805550100",
      email: "pat@example.com"
    });
    expect(out.ok).toBe(true);
    expect(vi.mocked(broadcastBookingClaim)).toHaveBeenCalledWith(
      BIZ,
      "dedupe-row-1",
      expect.anything(),
      expect.objectContaining({ startLocal: expect.stringContaining("9:00") })
    );
  });
});

/**
 * Bugbot on PR #1543: the resubmit path must behave like the first submit
 * for broadcast pages. The retry must not re-page invitees (the claim rows
 * are the durable record of who was texted) and a solo-owner gap-fill must
 * not send the assignee text the first-submit path deliberately skips.
 */
describe("submitPublicBooking: broadcast resubmit", () => {
  const VALID = {
    startIso: "2026-01-05T16:00:00.000Z",
    durationMinutes: 30,
    name: "Pat Visitor",
    phone: "+14805550100",
    email: "pat@example.com"
  };
  const OWNER_PHONE = "+16026866672";

  beforeEach(() => {
    mockPage.mockResolvedValue({ ...PAGE, assignment_mode: "broadcast" } as never);
    vi.mocked(businessOwnerNumbers).mockResolvedValue([]);
    // Hard reset, not just re-pin: unconsumed mockResolvedValueOnce entries
    // queued by earlier suites survive vi.clearAllMocks and would fire
    // before anything this suite queues (the leaked `false` made the
    // gap-fill silently no-op here).
    mockStampAssignee.mockReset();
    mockStampAssignee.mockResolvedValue(true);
    vi.mocked(findInvitedPhonesForBooking).mockReset();
    vi.mocked(findInvitedPhonesForBooking).mockResolvedValue([]);
    mockUpcomingForAttendee.mockReset();
    // The resubmit trigger: the attendee already holds this exact start.
    mockUpcomingForAttendee.mockResolvedValue([
      { startIso: "2026-01-05T16:00:00.000Z", eventId: "evt-1" }
    ] as never);
  });

  it("feeds the alert the durably recorded invitees instead of re-texting them", async () => {
    mockMembers.mockResolvedValue([
      { id: "m-1", name: "Ana", phone_e164: "+14805550111", active: true, weekly_schedule: null, last_offered_at: null },
      { id: "m-2", name: "Ben", phone_e164: "+14805550112", active: true, weekly_schedule: null, last_offered_at: null }
    ] as never);
    vi.mocked(findInvitedPhonesForBooking).mockResolvedValue(["+14805550111", "+14805550112"]);

    const out = await submitPublicBooking(TOKEN, VALID);
    expect(out.ok).toBe(true);
    // No re-invite: the first attempt's invites are the only ones ever sent.
    expect(vi.mocked(broadcastBookingClaim)).not.toHaveBeenCalled();
    expect(mockUnassignedAlert).toHaveBeenCalledWith(
      BIZ,
      expect.objectContaining({
        employeesAlreadyInvited: ["+14805550111", "+14805550112"]
      })
    );
  });

  it("a solo-owner gap-fill stamps without paging the owner twice", async () => {
    mockMembers.mockResolvedValue([
      { id: "m-owner", name: "Brian", phone_e164: OWNER_PHONE, active: true, weekly_schedule: null, last_offered_at: null }
    ] as never);
    vi.mocked(businessOwnerNumbers).mockResolvedValue([OWNER_PHONE]);
    mockStampAssignee.mockResolvedValueOnce(true);

    const out = await submitPublicBooking(TOKEN, VALID);
    expect(out.ok).toBe(true);
    expect(mockStampAssignee).toHaveBeenCalledWith(
      BIZ,
      "phone:+14805550100",
      "2026-01-05T16:00:00.000Z",
      "m-owner"
    );
    // The owner alert is the page; the assignee text would be a second one.
    expect(mockNotifyAssignee).not.toHaveBeenCalled();
    expect(mockUnassignedAlert).toHaveBeenCalledWith(
      BIZ,
      expect.objectContaining({ bookingAssigneeMemberId: "m-owner" })
    );
  });
});
