/**
 * Transactional email: booking confirmation and reminder for a booking made
 * on the public page.
 *
 * The provider's own calendar invitation is the calendar entry; this is the
 * branded companion that carries what an .ics cannot: the time in BOTH the
 * visitor's and the business's zone, the video link, and the self-serve
 * reschedule/cancel link. In platform mode (no calendar connected) there is
 * no invitation at all, so this is the only confirmation the visitor gets.
 *
 * One builder serves the confirmation and the reminders; `kind` picks the
 * copy. Deterministic and input-pure (no DB reads, no Date.now(), no env)
 * so it is snapshot-testable.
 */

import { buildBrandedEmailHtml } from "@/lib/email/branded-html";
import type { AppLocale } from "@/i18n/routing";
import { defaultLocale } from "@/i18n/routing";
import { emailMessagesForLocale, fmtEmail } from "@/lib/i18n/email-copy";

export type BookingEmailKind = "confirmation" | "reminder";

export type BookingConfirmationInput = {
  kind: BookingEmailKind;
  businessName: string;
  /** ISO start instant of the appointment. */
  startIso: string;
  durationMinutes: number;
  /** Business IANA zone, always rendered (the business's own clock). */
  businessTimeZone: string;
  /**
   * Visitor's IANA zone when known. Rendered ALONGSIDE the business zone,
   * never instead of it: a booking has two clocks and showing one invites
   * the no-show the confirmation exists to prevent.
   */
  visitorTimeZone?: string | null;
  /** Video meeting link, when the booking has one. */
  joinUrl?: string | null;
  /** Absolute self-serve reschedule/cancel URL, when the booking has one. */
  manageUrl?: string | null;
  recipientEmail: string;
  /** App origin without a trailing slash. */
  siteUrl: string;
  locale?: AppLocale;
};

export type BookingConfirmationEmail = { subject: string; text: string; html: string };

/** "Monday, July 27 at 9:00 AM MST" in one zone. */
export function bookingTimeLabel(
  startIso: string,
  timeZone: string,
  locale: AppLocale
): string {
  try {
    return new Intl.DateTimeFormat(locale === "es" ? "es-US" : "en-US", {
      timeZone,
      weekday: "long",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short"
    }).format(new Date(startIso));
  } catch {
    return startIso;
  }
}

export function buildBookingConfirmationEmail(
  input: BookingConfirmationInput
): BookingConfirmationEmail {
  const locale = input.locale ?? defaultLocale;
  const copy = emailMessagesForLocale(locale).bookingConfirmation;
  const businessLine = bookingTimeLabel(input.startIso, input.businessTimeZone, locale);
  const visitorZone = input.visitorTimeZone?.trim();
  // Only when it actually differs: repeating the same clock twice reads as
  // a mistake.
  const visitorLine =
    visitorZone && visitorZone !== input.businessTimeZone
      ? bookingTimeLabel(input.startIso, visitorZone, locale)
      : null;

  const subject = fmtEmail(
    input.kind === "reminder" ? copy.reminderSubject : copy.confirmationSubject,
    { business: input.businessName }
  );

  const lines: string[] = [
    fmtEmail(input.kind === "reminder" ? copy.reminderIntro : copy.confirmationIntro, {
      business: input.businessName
    }),
    visitorLine
      ? fmtEmail(copy.whenBothZones, { yourTime: visitorLine, businessTime: businessLine })
      : fmtEmail(copy.when, { time: businessLine }),
    fmtEmail(copy.duration, { minutes: String(input.durationMinutes) })
  ];
  if (input.joinUrl) lines.push(fmtEmail(copy.joinLine, { url: input.joinUrl }));
  if (input.manageUrl) lines.push(fmtEmail(copy.manageLine, { url: input.manageUrl }));

  const normalizedSite = input.siteUrl.replace(/\/$/, "");
  // The most useful button differs by what the booking has: joining beats
  // managing on a reminder, managing is the only action on a confirmation
  // without a video call.
  const cta = input.joinUrl
    ? { label: copy.joinCta, href: input.joinUrl }
    : input.manageUrl
      ? { label: copy.manageCta, href: input.manageUrl }
      : undefined;

  return {
    subject,
    text: [...lines, copy.signoff].join("\n\n"),
    html: buildBrandedEmailHtml({
      siteUrl: normalizedSite,
      documentTitle: subject,
      heading: subject,
      bodyBlocks: lines.map((text) => ({ kind: "text" as const, text })),
      ...(cta ? { cta } : {}),
      includeFallbackLink: cta !== undefined,
      recipientEmail: input.recipientEmail
    })
  };
}
