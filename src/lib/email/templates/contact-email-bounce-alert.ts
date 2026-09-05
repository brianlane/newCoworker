/**
 * What the owner is told when an email their AI coworker sent to a CONTACT
 * did not arrive.
 *
 * Why it exists (KYP Ads / Vantage Flow Media, 2026-09-03): a lead booked a
 * strategy call on Calendly with a work address whose mailbox did not exist.
 * Our booking-confirmation email bounced, Calendly's own confirmation and
 * calendar invite went to the same dead address, and the only place the
 * bounce surfaced was the admin System Errors card, which the tenant never
 * sees. The lead had a confirmation text and nothing else; the person who
 * could fix it (text the lead, send the invite to the address on the lead
 * form) was never told.
 *
 * The copy answers the three questions the owner has in order: what did not
 * arrive, why, and how else to reach the person. The alternate address line
 * is the useful part in the motivating case: the lead's form email differed
 * from the booking email, and it is right there on the contact record.
 *
 * Deterministic and input-pure (no DB, no Date.now(), no env) so the copy is
 * testable without a stack, matching the other templates in this directory.
 */

import type { AppLocale } from "@/i18n/routing";
import { defaultLocale } from "@/i18n/routing";
import type { EmailDeliveryStatus } from "@/lib/email/delivery";
import { formatAttendeePhone } from "@/lib/email/templates/booking-owner-alert";
import { emailMessagesForLocale, fmtEmail } from "@/lib/i18n/email-copy";

export type ContactEmailBounceAlertInput = {
  /** The failure state the receipt carried (bounced / complained / failed). */
  status: EmailDeliveryStatus;
  /** Resend's bounce classification, "Permanent" or "Transient", when known. */
  errorCode?: string | null;
  /** How the contact is known, or the address itself when there is no name. */
  contactName: string;
  /** The address that rejected the mail. */
  address: string;
  /** Subject of the email that did not arrive, when logged. */
  emailSubject?: string | null;
  /** The contact's phone, E.164, when they have one. */
  phone?: string | null;
  /**
   * A DIFFERENT email address on the contact's record, when there is one.
   * The caller compares case-insensitively and passes null when it is the
   * same address, so the template never suggests re-sending to the address
   * that just bounced.
   */
  otherEmail?: string | null;
  locale?: AppLocale;
};

export type ContactEmailBounceAlertCopy = {
  subject: string;
  heading: string;
  body: string;
  smsBody: string;
  ctaLabel: string;
  /** App-relative, joined to the origin by the dispatcher. */
  ctaPath: string;
  /** The dashboard notification row's one-line summary. */
  summaryLine: string;
};

export function buildContactEmailBounceAlert(
  input: ContactEmailBounceAlertInput
): ContactEmailBounceAlertCopy {
  const locale = input.locale ?? defaultLocale;
  const copy = emailMessagesForLocale(locale).contactEmailBounceAlert;

  const phone = input.phone?.trim() || null;
  const displayPhone = phone ? formatAttendeePhone(phone) : null;
  const vars = {
    name: input.contactName,
    address: input.address,
    emailSubject: input.emailSubject?.trim() || "",
    phone: displayPhone ?? ""
  };

  // A spam complaint means the mail ARRIVED, so the line that says the
  // provider rejected it would be false there; the reason line carries the
  // whole story on its own. Transient is Resend's word for "refused
  // repeatedly and given up on", which is a bounce we stop retrying, not a
  // dead mailbox, so it gets its own sentence rather than "does not exist".
  const reason =
    input.status === "complained"
      ? copy.reasonComplained
      : input.status === "failed"
        ? copy.reasonFailed
        : (input.errorCode ?? "").toLowerCase() === "transient"
          ? copy.reasonTransient
          : copy.reasonBounced;
  const sentLine = input.status === "complained" ? null : fmtEmail(copy.sentLine, vars);

  const details = [
    displayPhone ? fmtEmail(copy.phoneLine, { phone: displayPhone }) : null,
    input.otherEmail?.trim()
      ? fmtEmail(copy.otherEmailLine, { email: input.otherEmail.trim() })
      : null
  ].filter((line): line is string => line !== null);

  const summaryLine = fmtEmail(copy.summary, vars);

  return {
    subject: fmtEmail(copy.subject, vars),
    heading: fmtEmail(copy.heading, vars),
    // Blank line between blocks: the dispatcher splits on \n\n into paragraphs.
    body: [
      sentLine,
      reason,
      details.length > 0 ? details.join("\n") : null,
      fmtEmail(copy.consequence, vars),
      copy.action
    ]
      .filter((b): b is string => typeof b === "string" && b.length > 0)
      .join("\n\n"),
    smsBody: fmtEmail(displayPhone ? copy.smsWithPhone : copy.sms, vars),
    ctaLabel: phone ? copy.openContactCta : copy.openEmailsCta,
    // The contact page is where the phone and the alternate address live,
    // so the button lands where the fix happens; with no phone there is no
    // contact page to land on, and the Emails page shows the bounced row.
    ctaPath: phone ? `/dashboard/customers/${encodeURIComponent(phone)}` : "/dashboard/emails",
    summaryLine
  };
}
