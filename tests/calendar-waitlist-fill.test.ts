import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({ createSupabaseServiceClient: vi.fn() }));
vi.mock("@/lib/voice-tools/connections", () => ({ resolveCalendarConnection: vi.fn() }));
vi.mock("@/lib/calendar-tools/handlers", () => ({
  formatBookingStartLocal: vi.fn((iso: string) => `local(${iso})`),
  resolveToolTimezone: vi.fn(async () => "America/Phoenix"),
  getWorkspaceBusyBlocks: vi.fn()
}));
vi.mock("@/lib/calendar-tools/caldav", () => ({ getCaldavBusyBlocks: vi.fn() }));
vi.mock("@/lib/calendar-tools/vagaro", () => ({ findVagaroSlots: vi.fn() }));
vi.mock("@/lib/calendar-tools/acuity", () => ({ findAcuitySlots: vi.fn() }));
vi.mock("@/lib/db/booking-waitlist", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getWaitlistSettings: vi.fn(),
  listLiveWaitlistEntries: vi.fn(),
  listExpiredWaitlistOffers: vi.fn(),
  listLapsedWaitlistEntries: vi.fn(),
  findLiveWaitlistEntriesForAttendee: vi.fn(),
  markWaitlistOffered: vi.fn(),
  revertWaitlistOfferToWaiting: vi.fn(),
  setWaitlistStatus: vi.fn()
}));
vi.mock("@/lib/calendar-tools/waitlist-resolve", () => ({
  cancelWaitlistForAttendee: vi.fn()
}));
vi.mock("@/lib/db/businesses", () => ({ getBusiness: vi.fn() }));
vi.mock("@/lib/db/contact-language", () => ({ getContactLanguage: vi.fn() }));
vi.mock("@/lib/sms/opt-outs", () => ({ checkSmsOptOut: vi.fn() }));
vi.mock("@/lib/telnyx/messaging", () => ({
  getTelnyxMessagingForBusiness: vi.fn(),
  sendTelnyxSms: vi.fn()
}));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn() } }));

import {
  eligibleWaitlistCandidates,
  handleObservedCancellation,
  offerFreedSlot,
  pendingWaitlistOfferLine,
  sweepWaitlist,
  verifyFreedSlotOpen,
  waitlistOfferSmsBody,
  WAITLIST_OFFER_SMS_SOURCE
} from "@/lib/calendar-tools/waitlist-fill";
import { cancelWaitlistForAttendee } from "@/lib/calendar-tools/waitlist-resolve";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { resolveCalendarConnection } from "@/lib/voice-tools/connections";
import { getWorkspaceBusyBlocks } from "@/lib/calendar-tools/handlers";
import { getCaldavBusyBlocks } from "@/lib/calendar-tools/caldav";
import { findVagaroSlots } from "@/lib/calendar-tools/vagaro";
import { findAcuitySlots } from "@/lib/calendar-tools/acuity";
import {
  findLiveWaitlistEntriesForAttendee,
  getWaitlistSettings,
  listExpiredWaitlistOffers,
  listLapsedWaitlistEntries,
  listLiveWaitlistEntries,
  markWaitlistOffered,
  revertWaitlistOfferToWaiting,
  setWaitlistStatus,
  type BookingWaitlistRow
} from "@/lib/db/booking-waitlist";
import { getBusiness } from "@/lib/db/businesses";
import { getContactLanguage } from "@/lib/db/contact-language";
import { checkSmsOptOut } from "@/lib/sms/opt-outs";
import { getTelnyxMessagingForBusiness, sendTelnyxSms } from "@/lib/telnyx/messaging";
import { logger } from "@/lib/logger";

/**
 * Cancellation-waitlist fill: a freed slot is verified against LIVE
 * availability, offered to the oldest matching entry over metered SMS with
 * a compare-and-set hold, and passes to the next candidate when the hold
 * lapses. Every failure mode degrades without affecting the caller.
 */

const BIZ = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-08-01T00:00:00Z");
const SLOT = "2026-08-01T16:00:00.000Z";
const SLOT_MS = Date.parse(SLOT);

const GOOGLE = { provider: "google", connectionId: "c", providerConfigKey: "g" } as never;
const CALDAV = { provider: "caldav", connectionId: "d", providerConfigKey: "dk" } as never;
const VAGARO = { provider: "vagaro", connectionId: "v", providerConfigKey: "vk" } as never;
const ACUITY = { provider: "acuity", connectionId: "a", providerConfigKey: "acuity" } as never;
const CALENDLY = { provider: "calendly", connectionId: "y", providerConfigKey: "yk" } as never;

const mockConn = vi.mocked(resolveCalendarConnection);
const mockBusy = vi.mocked(getWorkspaceBusyBlocks);
const mockCaldav = vi.mocked(getCaldavBusyBlocks);
const mockVagaro = vi.mocked(findVagaroSlots);
const mockAcuity = vi.mocked(findAcuitySlots);
const mockSettings = vi.mocked(getWaitlistSettings);
const mockList = vi.mocked(listLiveWaitlistEntries);
const mockExpired = vi.mocked(listExpiredWaitlistOffers);
const mockLapsed = vi.mocked(listLapsedWaitlistEntries);
const mockFindLive = vi.mocked(findLiveWaitlistEntriesForAttendee);
const mockMark = vi.mocked(markWaitlistOffered);
const mockRevert = vi.mocked(revertWaitlistOfferToWaiting);
const mockStatus = vi.mocked(setWaitlistStatus);
const mockBusiness = vi.mocked(getBusiness);
const mockLanguage = vi.mocked(getContactLanguage);
const mockOptOut = vi.mocked(checkSmsOptOut);
const mockMessaging = vi.mocked(getTelnyxMessagingForBusiness);
const mockSend = vi.mocked(sendTelnyxSms);
const mockClientFactory = vi.mocked(createSupabaseServiceClient);

function entry(overrides: Partial<BookingWaitlistRow> = {}): BookingWaitlistRow {
  return {
    id: "wl-1",
    business_id: BIZ,
    phone: "+15485773546",
    email: null,
    name: null,
    duration_minutes: 30,
    earliest_at: "2026-07-01T00:00:00Z",
    latest_at: null,
    current_booking_start_at: "2026-08-04T15:00:00Z",
    current_event_id: "evt-9",
    status: "waiting",
    offered_start_at: null,
    offered_end_at: null,
    offer_expires_at: null,
    last_offered_start_at: null,
    created_at: "2026-07-01T00:00:00Z",
    updated_at: "2026-07-01T00:00:00Z",
    ...overrides
  };
}

function logDb() {
  const insert = vi.fn(async () => ({ error: null }));
  mockClientFactory.mockResolvedValue({ from: vi.fn(() => ({ insert })) } as never);
  return insert;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  mockSettings.mockResolvedValue({ enabled: true, offerTtlMinutes: 60 });
  mockList.mockResolvedValue([entry()]);
  mockConn.mockResolvedValue(GOOGLE);
  mockBusy.mockResolvedValue({ busy: [], complete: true });
  mockBusiness.mockResolvedValue({ name: "Acme Plumbing", timezone: "America/Phoenix" } as never);
  mockLanguage.mockResolvedValue({ preferred_language: null, language_source: null });
  mockOptOut.mockResolvedValue({ ok: true, optedOut: false } as never);
  mockMessaging.mockResolvedValue({ fromE164: "+15550001111" } as never);
  mockSend.mockResolvedValue({ id: "msg-1", channel: "sms" } as never);
  mockMark.mockResolvedValue(true);
  logDb();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("waitlistOfferSmsBody", () => {
  it("switches action wording on hasBooking and language", () => {
    const en = waitlistOfferSmsBody({
      businessName: "Acme",
      startLocal: "Tuesday 9 AM",
      ttlMinutes: 60,
      hasBooking: true,
      language: "en"
    });
    expect(en).toContain("move your appointment");
    expect(en).toContain("Acme");
    expect(en).toContain("60");

    expect(
      waitlistOfferSmsBody({
        businessName: "Acme",
        startLocal: "t",
        ttlMinutes: 60,
        hasBooking: false,
        language: "en"
      })
    ).toContain("book it for you");

    const es = waitlistOfferSmsBody({
      businessName: "Acme",
      startLocal: "t",
      ttlMinutes: 30,
      hasBooking: true,
      language: "es"
    });
    expect(es).toContain("le cambiamos su cita");
    expect(es).toContain("30");
    expect(
      waitlistOfferSmsBody({
        businessName: "Acme",
        startLocal: "t",
        ttlMinutes: 30,
        hasBooking: false,
        language: "es"
      })
    ).toContain("la reservamos");
  });
});

describe("eligibleWaitlistCandidates", () => {
  it("keeps only waiting entries whose window covers the slot, earlier than their booking, never re-offered the same slot", () => {
    const eligible = entry();
    const offered = entry({ id: "x1", status: "offered" });
    const tooEarly = entry({ id: "x2", earliest_at: "2026-08-02T00:00:00Z" });
    const tooLate = entry({ id: "x3", latest_at: "2026-08-01T00:00:00Z" });
    const alreadyEarlier = entry({ id: "x4", current_booking_start_at: SLOT });
    const sameSlotBefore = entry({ id: "x5", last_offered_start_at: SLOT });
    const kept = eligibleWaitlistCandidates(
      [eligible, offered, tooEarly, tooLate, alreadyEarlier, sameSlotBefore],
      SLOT_MS
    );
    expect(kept.map((e) => e.id)).toEqual(["wl-1"]);
  });

  it("excludes the acting attendee (digit-tolerant phone or email), never anyone else", () => {
    const canceler = entry({ id: "canceler", current_booking_start_at: null });
    const byEmail = entry({
      id: "by-email",
      phone: "+15005550000",
      email: "joe@acme.com",
      current_booking_start_at: null
    });
    const bystander = entry({
      id: "bystander",
      phone: "+15005559999",
      email: null,
      current_booking_start_at: null
    });
    // A digit-less stored phone can never phone-match; email decides.
    const digitless = entry({
      id: "digitless",
      phone: "---",
      email: null,
      current_booking_start_at: null
    });
    const kept = eligibleWaitlistCandidates(
      [canceler, byEmail, bystander, digitless],
      SLOT_MS,
      {
        // National formatting still matches the stored E.164; empty phone
        // strings are ignored.
        phones: ["", "(548) 577-3546"],
        email: "Joe@Acme.Com"
      }
    );
    expect(kept.map((e) => e.id)).toEqual(["bystander", "digitless"]);

    // No email in the exclusion: only the phone match applies.
    const keptNoEmail = eligibleWaitlistCandidates([canceler, byEmail, bystander], SLOT_MS, {
      phones: ["+15485773546"],
      email: null
    });
    expect(keptNoEmail.map((e) => e.id)).toEqual(["by-email", "bystander"]);
  });
});

describe("verifyFreedSlotOpen", () => {
  const END_MS = SLOT_MS + 30 * 60_000;

  it("Calendly is true by design (its own page enforces availability)", async () => {
    expect(await verifyFreedSlotOpen(BIZ, CALENDLY, SLOT_MS, END_MS)).toBe(true);
  });

  it("Vagaro: true only when the availability search offers the exact start", async () => {
    mockVagaro.mockResolvedValue({ ok: true, data: { slots: [{ startIso: SLOT }] } });
    expect(await verifyFreedSlotOpen(BIZ, VAGARO, SLOT_MS, END_MS)).toBe(true);

    mockVagaro.mockResolvedValue({
      ok: true,
      data: { slots: [{ startIso: "2026-08-01T17:00:00.000Z" }] }
    });
    expect(await verifyFreedSlotOpen(BIZ, VAGARO, SLOT_MS, END_MS)).toBe(false);

    // Defensive parse: a slot with no start never matches.
    mockVagaro.mockResolvedValue({ ok: true, data: { slots: [{}] } });
    expect(await verifyFreedSlotOpen(BIZ, VAGARO, SLOT_MS, END_MS)).toBe(false);

    // A result carrying no data at all reads as no slots.
    mockVagaro.mockResolvedValue({ ok: false, detail: "vagaro_auth_failed" });
    expect(await verifyFreedSlotOpen(BIZ, VAGARO, SLOT_MS, END_MS)).toBe(false);
  });

  it("Acuity: re-reads live availability and only confirms an exact slot match", async () => {
    mockAcuity.mockResolvedValue({
      ok: true,
      data: { slots: [{ startIso: new Date(SLOT_MS).toISOString() }] }
    });
    expect(await verifyFreedSlotOpen(BIZ, ACUITY, SLOT_MS, END_MS)).toBe(true);
    expect(mockAcuity).toHaveBeenCalled();
    // Vagaro's search must not be consulted for an Acuity tenant.
    expect(mockVagaro).not.toHaveBeenCalled();

    mockAcuity.mockResolvedValue({
      ok: true,
      data: { slots: [{ startIso: new Date(SLOT_MS + 60_000).toISOString() }] }
    });
    expect(await verifyFreedSlotOpen(BIZ, ACUITY, SLOT_MS, END_MS)).toBe(false);

    mockAcuity.mockResolvedValue({ ok: false, detail: "acuity_auth_failed" });
    expect(await verifyFreedSlotOpen(BIZ, ACUITY, SLOT_MS, END_MS)).toBe(false);
  });

  it("Acuity: asks in the BUSINESS timezone, never a hardcoded UTC", async () => {
    // Acuity availability is keyed by local calendar date. Asking in the
    // wrong zone asks about the wrong DAY for any merchant outside UTC, the
    // freed slot never appears, and this check fails closed, silently
    // swallowing a waitlist offer that should have gone out.
    mockAcuity.mockResolvedValue({
      ok: true,
      data: { slots: [{ startIso: new Date(SLOT_MS).toISOString() }] }
    });
    await verifyFreedSlotOpen(BIZ, ACUITY, SLOT_MS, END_MS);
    expect(mockAcuity.mock.calls[0][1]).toMatchObject({ timezone: "America/Phoenix" });
  });

  it("Vagaro: gets the same resolved timezone, so the two paths cannot drift", async () => {
    mockVagaro.mockResolvedValue({ ok: true, data: { slots: [] } });
    await verifyFreedSlotOpen(BIZ, VAGARO, SLOT_MS, END_MS);
    expect(mockVagaro.mock.calls[0][1]).toMatchObject({ timezone: "America/Phoenix" });
  });

  it("CalDAV: open when no busy block overlaps; refused reads fail closed", async () => {
    mockCaldav.mockResolvedValue({
      ok: true,
      busy: [{ start: new Date(END_MS), end: new Date(END_MS + 60_000) }]
    });
    expect(await verifyFreedSlotOpen(BIZ, CALDAV, SLOT_MS, END_MS)).toBe(true);

    mockCaldav.mockResolvedValue({
      ok: true,
      busy: [{ start: new Date(SLOT_MS + 60_000), end: new Date(SLOT_MS + 120_000) }]
    });
    expect(await verifyFreedSlotOpen(BIZ, CALDAV, SLOT_MS, END_MS)).toBe(false);

    mockCaldav.mockResolvedValue({
      ok: false,
      result: { ok: false, detail: "calendar_not_connected" }
    } as never);
    expect(await verifyFreedSlotOpen(BIZ, CALDAV, SLOT_MS, END_MS)).toBe(false);
  });

  it("Google/Microsoft: free/busy overlap fails closed; null fetch fails closed; throws fail closed", async () => {
    mockBusy.mockResolvedValue({
      busy: [
        { start: new Date(SLOT_MS - 60_000), end: new Date(SLOT_MS) }
      ],
      complete: true
    });
    expect(await verifyFreedSlotOpen(BIZ, GOOGLE, SLOT_MS, END_MS)).toBe(true);

    mockBusy.mockResolvedValue({
      busy: [
        { start: new Date(SLOT_MS), end: new Date(SLOT_MS + 60_000) }
      ],
      complete: true
    });
    expect(await verifyFreedSlotOpen(BIZ, GOOGLE, SLOT_MS, END_MS)).toBe(false);

    mockBusy.mockResolvedValue(null);
    expect(await verifyFreedSlotOpen(BIZ, GOOGLE, SLOT_MS, END_MS)).toBe(false);

    // An INCOMPLETE read fails closed too, even when the blocks it did return
    // leave the slot looking open. This path texts a customer an offer for the
    // slot, so "free" has to mean proven free, and unread reads as free.
    mockBusy.mockResolvedValue({
      busy: [{ start: new Date(SLOT_MS - 60_000), end: new Date(SLOT_MS) }],
      complete: false
    });
    expect(await verifyFreedSlotOpen(BIZ, GOOGLE, SLOT_MS, END_MS)).toBe(false);

    mockBusy.mockRejectedValue(new Error("nango down"));
    expect(await verifyFreedSlotOpen(BIZ, GOOGLE, SLOT_MS, END_MS)).toBe(false);
    expect(logger.warn).toHaveBeenCalled();

    mockBusy.mockRejectedValue("string blast");
    expect(await verifyFreedSlotOpen(BIZ, GOOGLE, SLOT_MS, END_MS)).toBe(false);
    expect(logger.warn).toHaveBeenLastCalledWith(
      "waitlist-fill: slot verification failed (treating as taken)",
      expect.objectContaining({ error: "string blast" })
    );
  });
});

describe("offerFreedSlot", () => {
  it("skips invalid, past, and owner-disabled slots", async () => {
    expect(await offerFreedSlot(BIZ, "not-a-date")).toBe("skipped_invalid");
    expect(await offerFreedSlot(BIZ, "2026-07-31T00:00:00Z")).toBe("skipped_past");

    mockSettings.mockResolvedValue({ enabled: false, offerTtlMinutes: 60 });
    expect(await offerFreedSlot(BIZ, SLOT)).toBe("skipped_disabled");
    expect(mockList).not.toHaveBeenCalled();
  });

  it("answers no_candidates with no live entries or none eligible", async () => {
    mockList.mockResolvedValue([]);
    expect(await offerFreedSlot(BIZ, SLOT)).toBe("no_candidates");

    mockList.mockResolvedValue([entry({ last_offered_start_at: SLOT })]);
    expect(await offerFreedSlot(BIZ, SLOT)).toBe("no_candidates");

    // The only candidate is the excluded actor (the canceler/mover).
    mockList.mockResolvedValue([entry({ current_booking_start_at: null })]);
    expect(
      await offerFreedSlot(BIZ, SLOT, {}, { phones: ["+15485773546"], email: null })
    ).toBe("no_candidates");
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("holds one pending offer per slot (slot_already_offered)", async () => {
    mockList.mockResolvedValue([
      entry({ id: "holder", status: "offered", offered_start_at: SLOT }),
      entry({ id: "waiting" })
    ]);
    expect(await offerFreedSlot(BIZ, SLOT)).toBe("slot_already_offered");
    expect(mockConn).not.toHaveBeenCalled();
  });

  it("answers slot_not_open on a busy or re-taken slot", async () => {
    mockConn.mockResolvedValue(GOOGLE);
    mockBusy.mockResolvedValue(null);
    expect(await offerFreedSlot(BIZ, SLOT)).toBe("slot_not_open");
    expect(mockMark).not.toHaveBeenCalled();
  });

  it("offers on a PLATFORM tenant, verifying against the ledger instead", async () => {
    // No calendar connected is platform mode, not "no calendar": refusing
    // here silently switched the waitlist off for every ledger-only
    // business (Bugbot High on PR #933).
    mockConn.mockResolvedValue(null as never);
    const isLedgerSlotOpen = vi.fn().mockResolvedValue(true);
    expect(await offerFreedSlot(BIZ, SLOT, { isLedgerSlotOpen })).toBe("offered");
    expect(isLedgerSlotOpen).toHaveBeenCalledWith(BIZ, Date.parse(SLOT), expect.any(Number));
    expect(mockBusy).not.toHaveBeenCalled();
  });

  it("platform: a slot the ledger says is taken is not offered", async () => {
    mockConn.mockResolvedValue(null as never);
    const isLedgerSlotOpen = vi.fn().mockResolvedValue(false);
    expect(await offerFreedSlot(BIZ, SLOT, { isLedgerSlotOpen })).toBe("slot_not_open");
    expect(mockMark).not.toHaveBeenCalled();
  });

  it("platform: falls back to the real ledger check when no override is injected", async () => {
    // The production wiring (no deps hook), so the default path is covered
    // rather than only the injected one.
    mockConn.mockResolvedValue(null as never);
    expect(await offerFreedSlot(BIZ, SLOT)).toBe("slot_not_open");
  });

  it("a slot too short for the first candidate still reaches a shorter-duration candidate", async () => {
    const long = entry({ id: "wl-long", duration_minutes: 60 });
    const short = entry({
      id: "wl-short",
      duration_minutes: 30,
      phone: "+15005550001",
      created_at: "2026-07-02T00:00:00Z"
    });
    mockList.mockResolvedValue([long, short]);
    // Busy block 30 minutes after the freed start: 60 min does not fit,
    // 30 min does.
    mockBusy.mockResolvedValue({
      busy: [
        { start: new Date(SLOT_MS + 30 * 60_000), end: new Date(SLOT_MS + 60 * 60_000) }
      ],
      complete: true
    });
    expect(await offerFreedSlot(BIZ, SLOT)).toBe("offered");
    expect(mockMark).toHaveBeenCalledTimes(1);
    expect(mockMark).toHaveBeenCalledWith("wl-short", expect.anything(), undefined);
  });

  it("offers the oldest candidate: verified slot, CAS hold with the owner's TTL, metered SMS, outbound log", async () => {
    const insert = logDb();
    expect(await offerFreedSlot(BIZ, SLOT)).toBe("offered");

    expect(mockMark).toHaveBeenCalledWith(
      "wl-1",
      {
        startIso: SLOT,
        endIso: new Date(SLOT_MS + 30 * 60_000).toISOString(),
        expiresAtIso: new Date(NOW.getTime() + 60 * 60_000).toISOString()
      },
      undefined
    );
    expect(mockSend).toHaveBeenCalledWith(
      { fromE164: "+15550001111" },
      "+15485773546",
      expect.stringContaining("Acme Plumbing"),
      { meterBusinessId: BIZ }
    );
    const body = mockSend.mock.calls[0][2] as string;
    expect(body).toContain(`local(${SLOT})`);
    expect(body).toContain("move your appointment");
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        business_id: BIZ,
        to_e164: "+15485773546",
        source: WAITLIST_OFFER_SMS_SOURCE,
        telnyx_message_id: "msg-1",
        channel: "sms"
      })
    );
    expect(mockRevert).not.toHaveBeenCalled();
  });

  it("texts Spanish to an es-preferring contact and degrades to English on a language read error", async () => {
    mockLanguage.mockResolvedValue({ preferred_language: "es", language_source: "detected" });
    await offerFreedSlot(BIZ, SLOT);
    expect(mockSend.mock.calls[0][2]).toContain("Buenas noticias");

    mockSend.mockClear();
    mockLanguage.mockRejectedValue(new Error("db down"));
    await offerFreedSlot(BIZ, SLOT);
    expect(mockSend.mock.calls[0][2]).toContain("Good news");
  });

  it("uses the book-it wording for entries with no linked booking", async () => {
    mockList.mockResolvedValue([entry({ current_booking_start_at: null })]);
    await offerFreedSlot(BIZ, SLOT);
    expect(mockSend.mock.calls[0][2]).toContain("book it for you");
  });

  it("moves to the next candidate when the CAS is lost, and reverts + retries when the SMS fails", async () => {
    const second = entry({ id: "wl-2", created_at: "2026-07-02T00:00:00Z" });
    mockList.mockResolvedValue([entry(), second]);
    mockMark.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    expect(await offerFreedSlot(BIZ, SLOT)).toBe("offered");
    expect(mockMark).toHaveBeenLastCalledWith("wl-2", expect.anything(), undefined);

    // SMS failure: the holder never saw the offer, so it reverts with the
    // slot memory cleared and the next candidate is tried.
    vi.clearAllMocks();
    mockSettings.mockResolvedValue({ enabled: true, offerTtlMinutes: 60 });
    mockList.mockResolvedValue([entry(), second]);
    mockConn.mockResolvedValue(GOOGLE);
    mockBusy.mockResolvedValue({ busy: [], complete: true });
    mockBusiness.mockResolvedValue({ name: "Acme", timezone: "America/Phoenix" } as never);
    mockLanguage.mockResolvedValue({ preferred_language: null, language_source: null });
    mockMark.mockResolvedValue(true);
    mockOptOut.mockResolvedValue({ ok: true, optedOut: true } as never);
    logDb();
    expect(await offerFreedSlot(BIZ, SLOT)).toBe("offer_failed");
    expect(mockRevert).toHaveBeenCalledTimes(2);
    expect(mockRevert).toHaveBeenCalledWith("wl-1", { clearLastOffered: true }, undefined);
  });

  it("send failures cover the fail-closed opt-out read, the thrown send, and the failed log insert", async () => {
    // Opt-out read itself broken: refuse (fail closed) → revert.
    mockList.mockResolvedValue([entry()]);
    mockOptOut.mockResolvedValue({ ok: false, error: "rpc down" } as never);
    expect(await offerFreedSlot(BIZ, SLOT)).toBe("offer_failed");

    // Telnyx throws: revert.
    mockOptOut.mockResolvedValue({ ok: true, optedOut: false } as never);
    mockSend.mockRejectedValue(new Error("Monthly SMS limit"));
    expect(await offerFreedSlot(BIZ, SLOT)).toBe("offer_failed");
    expect(logger.warn).toHaveBeenCalled();

    // Outbound-log insert failure never fails the offer (the text went out).
    mockSend.mockResolvedValue({ id: "msg-2", channel: "sms" } as never);
    mockClientFactory.mockRejectedValue(new Error("db down"));
    expect(await offerFreedSlot(BIZ, SLOT)).toBe("offered");
    expect(logger.error).toHaveBeenCalled();
  });

  it("fails soft (offer_failed) when the entry listing throws (any throw shape)", async () => {
    mockList.mockRejectedValue(new Error("db down"));
    expect(await offerFreedSlot(BIZ, SLOT)).toBe("offer_failed");
    expect(logger.warn).toHaveBeenCalled();

    mockList.mockRejectedValue("string blast");
    expect(await offerFreedSlot(BIZ, SLOT)).toBe("offer_failed");
  });

  it("degrades the business read to a generic name and logs missing from numbers as null", async () => {
    const insert = logDb();
    mockBusiness.mockResolvedValue(null);
    mockMessaging.mockResolvedValue({} as never);
    expect(await offerFreedSlot(BIZ, SLOT)).toBe("offered");
    expect(mockSend.mock.calls[0][2]).toContain("the business");
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ from_e164: null }));

    // A business row with no usable name degrades the same way.
    mockSend.mockClear();
    mockList.mockResolvedValue([entry({ id: "wl-9", phone: "+15005550001" })]);
    mockBusiness.mockResolvedValue({ timezone: "America/Phoenix" } as never);
    expect(await offerFreedSlot(BIZ, SLOT)).toBe("offered");
    expect(mockSend.mock.calls[0][2]).toContain("the business");
  });

  it("non-Error trouble in the send and log paths degrades identically", async () => {
    // Thrown STRING from the send: revert + offer_failed.
    mockSend.mockRejectedValue("send blast");
    expect(await offerFreedSlot(BIZ, SLOT)).toBe("offer_failed");

    // Thrown STRING from the log-insert client: the offer still stands.
    mockSend.mockResolvedValue({ id: "msg-3", channel: "sms" } as never);
    mockClientFactory.mockRejectedValue("db blast");
    mockList.mockResolvedValue([entry({ id: "wl-9", phone: "+15005550001" })]);
    expect(await offerFreedSlot(BIZ, SLOT)).toBe("offered");
  });
});

describe("handleObservedCancellation", () => {
  it("drops the canceled customer's entries FIRST and offers with them excluded", async () => {
    const outcome = await handleObservedCancellation(BIZ, SLOT, {
      phones: ["+15485773546"],
      email: null
    });
    // The single default candidate IS the canceler: excluded, so nothing
    // to offer.
    expect(outcome).toBe("no_candidates");
    expect(vi.mocked(cancelWaitlistForAttendee)).toHaveBeenCalledWith(BIZ, {
      phones: ["+15485773546"],
      email: null
    });
    expect(mockSend).not.toHaveBeenCalled();

    // Email-only identity normalizes the missing email field to null.
    vi.mocked(cancelWaitlistForAttendee).mockClear();
    await handleObservedCancellation(BIZ, SLOT, { phones: [], email: "joe@acme.com" });
    expect(vi.mocked(cancelWaitlistForAttendee)).toHaveBeenCalledWith(BIZ, {
      phones: [],
      email: "joe@acme.com"
    });
  });

  it("offers unexcluded when no identity is derivable (thin tombstones)", async () => {
    expect(await handleObservedCancellation(BIZ, SLOT)).toBe("offered");
    expect(vi.mocked(cancelWaitlistForAttendee)).not.toHaveBeenCalled();

    vi.clearAllMocks();
    mockSettings.mockResolvedValue({ enabled: true, offerTtlMinutes: 60 });
    mockList.mockResolvedValue([entry()]);
    mockConn.mockResolvedValue(GOOGLE);
    mockBusy.mockResolvedValue({ busy: [], complete: true });
    mockBusiness.mockResolvedValue({ name: "Acme", timezone: "America/Phoenix" } as never);
    mockLanguage.mockResolvedValue({ preferred_language: null, language_source: null });
    mockOptOut.mockResolvedValue({ ok: true, optedOut: false } as never);
    mockMessaging.mockResolvedValue({ fromE164: "+15550001111" } as never);
    mockSend.mockResolvedValue({ id: "msg-1", channel: "sms" } as never);
    mockMark.mockResolvedValue(true);
    logDb();
    // An empty identity object counts as no identity too.
    expect(
      await handleObservedCancellation(BIZ, SLOT, { phones: [], email: null })
    ).toBe("offered");
    expect(vi.mocked(cancelWaitlistForAttendee)).not.toHaveBeenCalled();
  });
});

describe("sweepWaitlist", () => {
  beforeEach(() => {
    mockLapsed.mockResolvedValue([]);
    mockExpired.mockResolvedValue([]);
  });

  it("expires lapsed entries and hands lapsed offers to the next candidate", async () => {
    mockLapsed.mockResolvedValue([entry({ id: "old-1" })]);
    const lapsedOffer = entry({
      id: "holder",
      status: "offered",
      offered_start_at: SLOT,
      offer_expires_at: "2026-07-31T23:00:00Z",
      last_offered_start_at: SLOT
    });
    mockExpired.mockResolvedValue([lapsedOffer]);
    // The re-offer inside lists POST-REVERT state: the lapsed holder is
    // waiting again but excluded by last_offered_start_at, so the NEXT
    // candidate takes the slot.
    mockList.mockResolvedValue([
      entry({ id: "holder", status: "waiting", last_offered_start_at: SLOT }),
      entry({ id: "wl-2", created_at: "2026-07-02T00:00:00Z" })
    ]);

    const result = await sweepWaitlist();
    expect(result).toEqual({ lapsedEntries: 1, expiredOffers: 1, reoffered: 1 });
    expect(mockStatus).toHaveBeenCalledWith("old-1", "expired", undefined);
    expect(mockRevert).toHaveBeenCalledWith("holder", {}, undefined);
    expect(mockMark).toHaveBeenCalledWith("wl-2", expect.anything(), undefined);
  });

  it("a LAPSING row that still holds an offer passes its slot to the next candidate", async () => {
    // The holder's linked booking start passed while their offer for an
    // (unrelated) earlier slot was pending; expiring them must not strand
    // the held slot.
    mockLapsed.mockResolvedValue([
      entry({
        id: "holder",
        status: "offered",
        current_booking_start_at: "2026-07-31T00:00:00Z",
        offered_start_at: SLOT,
        offer_expires_at: "2026-08-01T02:00:00Z",
        last_offered_start_at: SLOT
      })
    ]);
    mockList.mockResolvedValue([
      entry({ id: "wl-2", created_at: "2026-07-02T00:00:00Z" })
    ]);
    const result = await sweepWaitlist();
    expect(result).toEqual({ lapsedEntries: 1, expiredOffers: 0, reoffered: 1 });
    expect(mockStatus).toHaveBeenCalledWith("holder", "expired", undefined);
    expect(mockMark).toHaveBeenCalledWith("wl-2", expect.anything(), undefined);
  });

  it("skips the re-offer for rows with no recorded slot and counts non-offered outcomes honestly", async () => {
    // One lapsing holder whose re-offer finds nobody, plus expired offers
    // with and without a recorded slot.
    mockLapsed.mockResolvedValue([
      entry({
        id: "lapsed-holder",
        status: "offered",
        current_booking_start_at: "2026-07-31T00:00:00Z",
        offered_start_at: SLOT
      })
    ]);
    mockExpired.mockResolvedValue([
      entry({ id: "no-slot", status: "offered", offered_start_at: null }),
      entry({ id: "gone-slot", status: "offered", offered_start_at: SLOT })
    ]);
    // Every re-offer finds nobody eligible.
    mockList.mockResolvedValue([]);
    const result = await sweepWaitlist();
    expect(result).toEqual({ lapsedEntries: 1, expiredOffers: 2, reoffered: 0 });
  });

  it("isolates listing failures per phase (Error and non-Error shapes)", async () => {
    mockLapsed.mockRejectedValue(new Error("db down"));
    mockExpired.mockRejectedValue(new Error("db down"));
    expect(await sweepWaitlist()).toEqual({ lapsedEntries: 0, expiredOffers: 0, reoffered: 0 });
    expect(logger.warn).toHaveBeenCalledTimes(2);

    mockLapsed.mockRejectedValue("lapsed blast");
    mockExpired.mockRejectedValue("expired blast");
    expect(await sweepWaitlist()).toEqual({ lapsedEntries: 0, expiredOffers: 0, reoffered: 0 });
  });
});

describe("pendingWaitlistOfferLine", () => {
  it("describes a live offer with the right completion tool", async () => {
    mockFindLive.mockResolvedValue([
      entry({
        status: "offered",
        offered_start_at: SLOT,
        offer_expires_at: "2026-08-01T01:00:00Z"
      })
    ]);
    const line = await pendingWaitlistOfferLine(BIZ, "+15485773546", "America/Phoenix");
    expect(line).toContain("PENDING waitlist offer");
    expect(line).toContain(`local(${SLOT})`);
    expect(line).toContain("calendar_reschedule_appointment");

    mockFindLive.mockResolvedValue([
      entry({
        status: "offered",
        current_booking_start_at: null,
        offered_start_at: SLOT,
        offer_expires_at: "2026-08-01T01:00:00Z"
      })
    ]);
    expect(await pendingWaitlistOfferLine(BIZ, "+15485773546", null)).toContain(
      "calendar_book_appointment"
    );
  });

  it("answers null with no live offer, an expired hold, or a read error", async () => {
    mockFindLive.mockResolvedValue([entry()]);
    expect(await pendingWaitlistOfferLine(BIZ, "+15485773546", null)).toBeNull();

    mockFindLive.mockResolvedValue([
      entry({
        status: "offered",
        offered_start_at: SLOT,
        offer_expires_at: "2026-07-31T00:00:00Z"
      })
    ]);
    expect(await pendingWaitlistOfferLine(BIZ, "+15485773546", null)).toBeNull();

    mockFindLive.mockRejectedValue(new Error("db down"));
    expect(await pendingWaitlistOfferLine(BIZ, "+15485773546", null)).toBeNull();
    expect(logger.warn).toHaveBeenCalled();

    mockFindLive.mockRejectedValue("string blast");
    expect(await pendingWaitlistOfferLine(BIZ, "+15485773546", null)).toBeNull();
  });
});
