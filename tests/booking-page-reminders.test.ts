/**
 * The reminder sweep: lead-time windows, per-channel claiming (so an
 * overlapping tick can never double-send), the STOP-list gate, and the
 * per-booking failure isolation that keeps one dead mailbox from stopping
 * the fleet's reminders.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({ createSupabaseServiceClient: vi.fn() }));
vi.mock("@/lib/db/businesses", () => ({ getBusiness: vi.fn() }));
vi.mock("@/lib/booking-page/db", () => ({ getBookingPageForBusiness: vi.fn() }));
vi.mock("@/lib/email/owner-mailbox", () => ({ sendFromOwnerMailbox: vi.fn() }));
vi.mock("@/lib/db/email-log", () => ({ recordOutboundAssistantEmail: vi.fn() }));
vi.mock("@/lib/telnyx/messaging", () => ({
  getTelnyxMessagingForBusiness: vi.fn(),
  sendTelnyxSms: vi.fn()
}));
vi.mock("@/lib/sms/opt-outs", () => ({ checkSmsOptOut: vi.fn() }));
vi.mock("@/lib/zoom/meetings", () => ({ getZoomJoinUrl: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

import {
  REMINDER_BATCH_LIMIT,
  attendeePhoneFromKey,
  reminderDue,
  sweepBookingReminders
} from "@/lib/booking-page/reminders";
import { getBusiness } from "@/lib/db/businesses";
import { getBookingPageForBusiness } from "@/lib/booking-page/db";
import { sendFromOwnerMailbox } from "@/lib/email/owner-mailbox";
import { recordOutboundAssistantEmail } from "@/lib/db/email-log";
import { getTelnyxMessagingForBusiness, sendTelnyxSms } from "@/lib/telnyx/messaging";
import { checkSmsOptOut } from "@/lib/sms/opt-outs";
import { getZoomJoinUrl } from "@/lib/zoom/meetings";

const BIZ = "11111111-1111-4111-8111-111111111111";
const SITE = "https://www.newcoworker.com";
const NOW = Date.parse("2026-07-26T16:00:00.000Z");

const mockBusiness = vi.mocked(getBusiness);
const mockPage = vi.mocked(getBookingPageForBusiness);
const mockSendEmail = vi.mocked(sendFromOwnerMailbox);
const mockRecord = vi.mocked(recordOutboundAssistantEmail);
const mockTelnyxConfig = vi.mocked(getTelnyxMessagingForBusiness);
const mockSendSms = vi.mocked(sendTelnyxSms);
const mockOptOut = vi.mocked(checkSmsOptOut);
const mockJoinUrl = vi.mocked(getZoomJoinUrl);

function booking(over: Record<string, unknown> = {}) {
  return {
    id: "row-1",
    business_id: BIZ,
    attendee_key: "phone:+14805550177",
    attendee_email: "liz@example.com",
    attendee_name: "Liz",
    // 20 hours out: inside a 24h email window, outside a 2h SMS window.
    start_at: new Date(NOW + 20 * 60 * 60 * 1000).toISOString(),
    duration_minutes: 30,
    zoom_meeting_id: null,
    manage_token: `ncbm_${"a".repeat(64)}`,
    reminders_sent: {},
    ...over
  };
}

/** Ledger reads (the scan) plus the per-channel claim updates. */
function db(rows: Array<Record<string, unknown>>, claimResults: Array<{ data: unknown }> = []) {
  let claimIdx = 0;
  const claims: Array<Record<string, unknown>> = [];
  const from = vi.fn(() => {
    const b: Record<string, unknown> = {};
    for (const m of ["select", "eq", "is", "not", "gte", "lt", "order"]) {
      b[m] = vi.fn(() => b);
    }
    b.limit = vi.fn(() => Promise.resolve({ data: rows, error: null }));
    return b;
  });
  // The claim is a server-side jsonb merge (claim_booking_reminder), so it
  // rides rpc rather than an update payload.
  const rpc = vi.fn((_fn: string, args: Record<string, unknown>) => {
    claims.push(args);
    return Promise.resolve(claimResults[claimIdx++] ?? { data: true, error: null });
  });
  return { client: { from, rpc } as never, claims };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPage.mockResolvedValue({
    reminders_enabled: true,
    reminder_email_hours: 24,
    reminder_sms_hours: 2
  } as never);
  mockBusiness.mockResolvedValue({ name: "New Coworker", timezone: "America/Phoenix" } as never);
  mockSendEmail.mockResolvedValue({
    ok: true,
    provider: "google",
    messageId: "m-1",
    threadId: "t-1"
  });
  mockRecord.mockResolvedValue(undefined);
  mockTelnyxConfig.mockResolvedValue({ fromE164: "+16026886672" } as never);
  mockSendSms.mockResolvedValue({ id: "sms-1", channel: "sms" } as never);
  mockOptOut.mockResolvedValue({ ok: true, optedOut: false } as never);
  mockJoinUrl.mockResolvedValue(null);
});

describe("reminderDue", () => {
  it("is due inside the lead window, and never for a disabled channel or a past start", () => {
    const start = NOW + 3 * 60 * 60 * 1000;
    expect(reminderDue(start, 24, NOW)).toBe(true);
    expect(reminderDue(start, 2, NOW)).toBe(false); // still too early
    expect(reminderDue(start, 0, NOW)).toBe(false); // channel off
    expect(reminderDue(NOW - 60_000, 24, NOW)).toBe(false); // already started
  });

  it("still fires after a missed moment (a late reminder beats none)", () => {
    // 30 minutes out with a 2 hour lead: the exact moment passed, but the
    // appointment has not.
    expect(reminderDue(NOW + 30 * 60_000, 2, NOW)).toBe(true);
  });
});

describe("attendeePhoneFromKey", () => {
  it("reads a phone-keyed booking and nothing else", () => {
    expect(attendeePhoneFromKey("phone:+14805550177")).toBe("+14805550177");
    expect(attendeePhoneFromKey("email:liz@example.com")).toBeNull();
    expect(attendeePhoneFromKey("anonymous")).toBeNull();
  });
});

describe("sweepBookingReminders", () => {
  it("emails the 24h reminder and files it, without texting yet", async () => {
    const { client, claims } = db([booking()]);
    const out = await sweepBookingReminders(SITE, client, NOW);
    expect(out).toMatchObject({ scanned: 1, emailsSent: 1, textsSent: 0 });
    expect(mockSendEmail).toHaveBeenCalledWith(
      BIZ,
      expect.objectContaining({ toEmail: "liz@example.com" })
    );
    // The manage link rides the reminder so a change is still self-serve.
    expect(String(mockSendEmail.mock.calls[0][1].bodyText)).toContain("/book/manage/ncbm_");
    expect(mockRecord).toHaveBeenCalledWith(
      expect.objectContaining({ source: "booking_reminder" })
    );
    // Claimed before sending, on the email channel only, through the
    // merge-safe function.
    expect(claims[0]).toEqual({ p_booking_id: "row-1", p_channel: "email" });
    expect(mockSendSms).not.toHaveBeenCalled();
  });

  it("texts inside the SMS window, with the time and the manage link", async () => {
    const { client } = db([
      booking({ start_at: new Date(NOW + 90 * 60_000).toISOString(), reminders_sent: { email: "x" } })
    ]);
    const out = await sweepBookingReminders(SITE, client, NOW);
    expect(out).toMatchObject({ textsSent: 1, emailsSent: 0 });
    const body = String(mockSendSms.mock.calls[0][2]);
    expect(body).toContain("New Coworker");
    expect(body).toMatch(/MST/);
    expect(body).toContain("/book/manage/ncbm_");
  });

  it("never sends a channel twice (an existing stamp is respected)", async () => {
    const { client } = db([booking({ reminders_sent: { email: "2026-07-26T00:00:00Z" } })]);
    const out = await sweepBookingReminders(SITE, client, NOW);
    expect(out.emailsSent).toBe(0);
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it("loses the claim race quietly (another pass is sending)", async () => {
    const { client } = db([booking()], [{ data: false }]);
    const out = await sweepBookingReminders(SITE, client, NOW);
    expect(out.emailsSent).toBe(0);
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it("skips a page with reminders off, a missing page, and a missing business", async () => {
    mockPage.mockResolvedValue({
      reminders_enabled: false,
      reminder_email_hours: 24,
      reminder_sms_hours: 2
    } as never);
    expect((await sweepBookingReminders(SITE, db([booking()]).client, NOW)).skipped).toBe(1);

    mockPage.mockResolvedValue(null as never);
    expect((await sweepBookingReminders(SITE, db([booking()]).client, NOW)).skipped).toBe(1);

    mockPage.mockResolvedValue({
      reminders_enabled: true,
      reminder_email_hours: 24,
      reminder_sms_hours: 2
    } as never);
    mockBusiness.mockResolvedValue(null as never);
    expect((await sweepBookingReminders(SITE, db([booking()]).client, NOW)).skipped).toBe(1);
  });

  it("scans PAGE bookings only (AI, voice, and synced appointments are not opted in)", async () => {
    const { client } = db([booking()]);
    await sweepBookingReminders(SITE, client, NOW);
    const from = (client as unknown as { from: ReturnType<typeof vi.fn> }).from;
    const builder = from.mock.results[0].value as Record<string, ReturnType<typeof vi.fn>>;
    // The manage token is what marks a public-page booking; nothing else
    // has one.
    expect(builder.not.mock.calls).toContainEqual(["manage_token", "is", null]);
  });

  it("claims both channels without either wiping the other's stamp", async () => {
    // Both due in one pass: the merge happens server-side, so the second
    // claim cannot drop the first channel's stamp (which a later pass would
    // otherwise re-send).
    const { client, claims } = db([
      booking({ start_at: new Date(NOW + 90 * 60_000).toISOString(), reminders_sent: {} })
    ]);
    const out = await sweepBookingReminders(SITE, client, NOW);
    expect(out).toMatchObject({ emailsSent: 1, textsSent: 1 });
    expect(claims).toEqual([
      { p_booking_id: "row-1", p_channel: "email" },
      { p_booking_id: "row-1", p_channel: "sms" }
    ]);
  });

  it("is a cheap no-op with nothing upcoming", async () => {
    const out = await sweepBookingReminders(SITE, db([]).client, NOW);
    expect(out).toEqual({ scanned: 0, emailsSent: 0, textsSent: 0, skipped: 0 });
    expect(mockPage).not.toHaveBeenCalled();
  });

  it("respects the STOP list and a booking with no phone", async () => {
    const soon = new Date(NOW + 90 * 60_000).toISOString();
    mockOptOut.mockResolvedValue({ ok: true, optedOut: true } as never);
    let out = await sweepBookingReminders(
      SITE,
      db([booking({ start_at: soon, reminders_sent: { email: "x" } })]).client,
      NOW
    );
    expect(out.textsSent).toBe(0);
    expect(mockSendSms).not.toHaveBeenCalled();

    // A failed opt-out read also refuses (fail closed).
    mockOptOut.mockResolvedValue({ ok: false, error: "db down" } as never);
    out = await sweepBookingReminders(
      SITE,
      db([booking({ start_at: soon, reminders_sent: { email: "x" } })]).client,
      NOW
    );
    expect(out.textsSent).toBe(0);

    mockOptOut.mockResolvedValue({ ok: true, optedOut: false } as never);
    out = await sweepBookingReminders(
      SITE,
      db([
        booking({
          start_at: soon,
          attendee_key: "email:liz@example.com",
          reminders_sent: { email: "x" }
        })
      ]).client,
      NOW
    );
    expect(out.textsSent).toBe(0);
  });

  it("skips the email for a booking with no address, and attaches a join link when there is one", async () => {
    let out = await sweepBookingReminders(
      SITE,
      db([booking({ attendee_email: null })]).client,
      NOW
    );
    expect(out.emailsSent).toBe(0);
    expect(mockSendEmail).not.toHaveBeenCalled();

    mockJoinUrl.mockResolvedValue("https://zoom.example.com/j/1?pwd=x");
    out = await sweepBookingReminders(
      SITE,
      db([booking({ zoom_meeting_id: "934123" })]).client,
      NOW
    );
    expect(out.emailsSent).toBe(1);
    expect(String(mockSendEmail.mock.calls[0][1].bodyText)).toContain("pwd=x");
  });

  it("treats a refused mailbox as not sent, and isolates a thrown booking", async () => {
    mockSendEmail.mockResolvedValue({ ok: false, detail: "email_not_connected" });
    let out = await sweepBookingReminders(SITE, db([booking()]).client, NOW);
    expect(out.emailsSent).toBe(0);
    expect(mockRecord).not.toHaveBeenCalled();

    mockSendEmail.mockRejectedValue(new Error("gmail 500"));
    out = await sweepBookingReminders(SITE, db([booking()]).client, NOW);
    expect(out.skipped).toBe(1);

    mockSendEmail.mockRejectedValue("string boom");
    out = await sweepBookingReminders(SITE, db([booking()]).client, NOW);
    expect(out.skipped).toBe(1);
  });

  it("defaults a missing duration and tolerates missing stamps", async () => {
    const { client } = db([booking({ duration_minutes: null, reminders_sent: null })]);
    const out = await sweepBookingReminders(SITE, client, NOW);
    expect(out.emailsSent).toBe(1);
    expect(String(mockSendEmail.mock.calls[0][1].bodyText)).toContain("30 minutes");
  });

  it("omits the manage line when the booking has no token", async () => {
    const { client } = db([booking({ manage_token: null })]);
    await sweepBookingReminders(SITE, client, NOW);
    expect(String(mockSendEmail.mock.calls[0][1].bodyText)).not.toContain("/book/manage/");
  });

  it("bounds one pass, and reuses the page and business per tenant", async () => {
    const { client } = db([booking({ id: "a" }), booking({ id: "b" })]);
    await sweepBookingReminders(SITE, client, NOW);
    // Two bookings, one tenant: one page read, one business read.
    expect(mockPage).toHaveBeenCalledTimes(1);
    expect(mockBusiness).toHaveBeenCalledTimes(1);
    expect(REMINDER_BATCH_LIMIT).toBeGreaterThan(0);
  });

  it("omits the manage link from the TEXT when the booking has no token", async () => {
    const { client } = db([
      booking({
        start_at: new Date(NOW + 90 * 60_000).toISOString(),
        reminders_sent: { email: "x" },
        manage_token: null
      })
    ]);
    await sweepBookingReminders(SITE, client, NOW);
    expect(String(mockSendSms.mock.calls[0][2])).not.toContain("/book/manage/");
  });

  it("reads a business with no timezone as UTC", async () => {
    mockBusiness.mockResolvedValue({ name: "New Coworker", timezone: "" } as never);
    const { client } = db([booking()]);
    await sweepBookingReminders(SITE, client, NOW);
    // The start instant rendered in UTC rather than Phoenix.
    expect(String(mockSendEmail.mock.calls[0][1].bodyText)).toMatch(/UTC|GMT/);
  });

  it("surfaces a ledger read failure and a failed claim write", async () => {
    const failingRead = {
      from: vi.fn(() => {
        const b: Record<string, unknown> = {};
        for (const m of ["select", "eq", "is", "not", "gte", "lt", "order"]) {
          b[m] = vi.fn(() => b);
        }
        b.limit = vi.fn(() => Promise.resolve({ data: null, error: { message: "rls" } }));
        return b;
      }),
      rpc: vi.fn(() => Promise.resolve({ data: true, error: null }))
    } as never;
    await expect(sweepBookingReminders(SITE, failingRead, NOW)).rejects.toThrow(
      /upcomingBookings: rls/
    );

    // A failed claim is isolated to that booking, not the whole pass.
    const failingClaim = {
      from: vi.fn(() => {
        const b: Record<string, unknown> = {};
        for (const m of ["select", "eq", "is", "not", "gte", "lt", "order"]) {
          b[m] = vi.fn(() => b);
        }
        b.limit = vi.fn(() => Promise.resolve({ data: [booking()], error: null }));
        return b;
      }),
      rpc: vi.fn(() => Promise.resolve({ data: null, error: { message: "denied" } }))
    } as never;
    const out = await sweepBookingReminders(SITE, failingClaim, NOW);
    expect(out.skipped).toBe(1);
    expect(out.emailsSent).toBe(0);
  });

  it("tolerates a driver that answers data: null (scan, claim, and SMS claim)", async () => {
    const nullScan = {
      from: vi.fn(() => {
        const b: Record<string, unknown> = {};
        for (const m of ["select", "eq", "is", "not", "gte", "lt", "order"]) {
          b[m] = vi.fn(() => b);
        }
        b.limit = vi.fn(() => Promise.resolve({ data: null, error: null }));
        return b;
      }),
      rpc: vi.fn(() => Promise.resolve({ data: true, error: null }))
    } as never;
    expect((await sweepBookingReminders(SITE, nullScan, NOW)).scanned).toBe(0);

    // A claim whose select answers null reads as "not claimed".
    const soon = new Date(NOW + 90 * 60_000).toISOString();
    const nullClaim = db(
      [booking({ start_at: soon, reminders_sent: {} })],
      [{ data: null }, { data: null }]
    );
    const out = await sweepBookingReminders(SITE, nullClaim.client, NOW);
    expect(out.emailsSent).toBe(0);
    expect(out.textsSent).toBe(0);
  });

  it("falls back to the service client", async () => {
    const { client } = db([]);
    const { createSupabaseServiceClient } = await import("@/lib/supabase/server");
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(client);
    expect((await sweepBookingReminders(SITE)).scanned).toBe(0);
  });
});
