/**
 * The confirmation email a public-page booking sends: from the tenant's own
 * mailbox, filed on the Emails page, and never able to fail the booking.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/email/owner-mailbox", () => ({ sendFromOwnerMailbox: vi.fn() }));
vi.mock("@/lib/db/email-log", () => ({ recordOutboundAssistantEmail: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

import { sendBookingConfirmationEmail } from "@/lib/booking-page/confirmation-email";
import { sendFromOwnerMailbox } from "@/lib/email/owner-mailbox";
import { recordOutboundAssistantEmail } from "@/lib/db/email-log";
import { logger } from "@/lib/logger";

const BIZ = "11111111-1111-4111-8111-111111111111";
const mockSend = vi.mocked(sendFromOwnerMailbox);
const mockRecord = vi.mocked(recordOutboundAssistantEmail);

const INPUT = {
  businessId: BIZ,
  businessName: "New Coworker",
  businessTimeZone: "America/Phoenix",
  startIso: "2026-07-27T16:00:00.000Z",
  durationMinutes: 30,
  attendeeEmail: "liz@example.com",
  joinUrl: "https://zoom.example.com/j/1?pwd=x",
  manageLink: "/book/manage/ncbm_abc",
  visitorTimeZone: "America/New_York"
};

beforeEach(() => {
  vi.clearAllMocks();
  mockSend.mockResolvedValue({
    ok: true,
    provider: "google",
    messageId: "m-1",
    threadId: "t-1",
    fromEmail: "owner@biz.com"
  });
  mockRecord.mockResolvedValue(undefined);
});

describe("sendBookingConfirmationEmail", () => {
  it("sends from the tenant mailbox with both clocks and both links", async () => {
    expect(await sendBookingConfirmationEmail(INPUT)).toBe(true);
    const args = mockSend.mock.calls[0][1];
    expect(args.toEmail).toBe("liz@example.com");
    expect(args.subject).toContain("New Coworker");
    expect(args.bodyText).toContain("12:00 PM");
    expect(args.bodyText).toContain("9:00 AM");
    expect(args.bodyText).toContain("pwd=x");
    // The relative manage path becomes an absolute URL in the email.
    expect(args.bodyText).toMatch(/https?:\/\/[^\s]+\/book\/manage\/ncbm_abc/);
    expect(mockRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "booking_reminder",
        providerMessageId: "m-1",
        // The address the mailbox send reported, so the log never shows a dash.
        fromEmail: "owner@biz.com"
      })
    );
  });

  it("does nothing without an attendee address", async () => {
    expect(await sendBookingConfirmationEmail({ ...INPUT, attendeeEmail: "  " })).toBe(false);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("treats a missing mailbox as ordinary, not an error", async () => {
    // Most tenants in platform mode have no connected mailbox; the booking
    // is unaffected either way.
    mockSend.mockResolvedValue({ ok: false, detail: "email_not_connected" });
    expect(await sendBookingConfirmationEmail(INPUT)).toBe(false);
    expect(mockRecord).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      "booking-page: confirmation email not sent",
      expect.objectContaining({ detail: "email_not_connected" })
    );
  });

  it("sends Spanish for a Spanish page, English for anything else", async () => {
    await sendBookingConfirmationEmail({ ...INPUT, locale: "es" });
    expect(String(mockSend.mock.calls[0][1].subject)).toContain("está confirmada");

    mockSend.mockClear();
    await sendBookingConfirmationEmail({ ...INPUT, locale: "fr" });
    expect(String(mockSend.mock.calls[0][1].subject)).toContain("You are booked");
  });

  it("omits the manage link when the booking has none", async () => {
    await sendBookingConfirmationEmail({ ...INPUT, manageLink: null, joinUrl: null });
    expect(String(mockSend.mock.calls[0][1].bodyText)).not.toContain("/book/manage/");
  });
});
