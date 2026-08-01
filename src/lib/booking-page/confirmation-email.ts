/**
 * The branded confirmation email for a public-page booking.
 *
 * Split from the booking flow so the flow reads as one story and this can be
 * tested on its own. Sent from the tenant's connected mailbox, because it
 * has to look like the business wrote it; tenants with no mailbox simply do
 * not get this (the booking is unaffected).
 */

import { buildBookingConfirmationEmail } from "@/lib/email/templates/booking-confirmation";
import { sendFromOwnerMailbox } from "@/lib/email/owner-mailbox";
import { recordOutboundAssistantEmail } from "@/lib/db/email-log";
import { logger } from "@/lib/logger";

export type BookingConfirmationSendInput = {
  businessId: string;
  businessName: string;
  businessTimeZone: string;
  startIso: string;
  durationMinutes: number;
  attendeeEmail: string;
  joinUrl: string | null;
  /** Relative manage path from the booking flow, or null. */
  manageLink: string | null;
  visitorTimeZone: string | null;
  /** Page locale; anything but "es" reads as English. */
  locale?: string | null;
};

export async function sendBookingConfirmationEmail(
  input: BookingConfirmationSendInput
): Promise<boolean> {
  const email = input.attendeeEmail.trim();
  if (!email) return false;

  // Same resolution the other transactional senders use.
  const siteUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
  const built = buildBookingConfirmationEmail({
    kind: "confirmation",
    businessName: input.businessName,
    startIso: input.startIso,
    durationMinutes: input.durationMinutes,
    businessTimeZone: input.businessTimeZone,
    visitorTimeZone: input.visitorTimeZone,
    joinUrl: input.joinUrl,
    manageUrl: input.manageLink ? `${siteUrl}${input.manageLink}` : null,
    recipientEmail: email,
    siteUrl,
    locale: input.locale === "es" ? "es" : "en"
  });

  const sent = await sendFromOwnerMailbox(input.businessId, {
    toEmail: email,
    subject: built.subject,
    bodyText: built.text
  });
  if (!sent.ok) {
    // No mailbox connected is the common case, not an error: the provider's
    // own invitation (or the on-screen confirmation) still covers the
    // visitor.
    logger.info("booking-page: confirmation email not sent", {
      businessId: input.businessId,
      detail: sent.detail
    });
    return false;
  }

  await recordOutboundAssistantEmail({
    businessId: input.businessId,
    toEmail: email,
    subject: built.subject,
    bodyText: built.text,
    source: "booking_reminder",
    fromEmail: sent.fromEmail,
    providerMessageId: sent.messageId
  });
  return true;
}
