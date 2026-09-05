/**
 * What the owner is told when a booking lands.
 *
 * One builder, three states, because "who is on the hook for this
 * appointment" has three genuinely different answers and the original alert
 * only ever expressed one of them:
 *
 *   - `solo`: the business has no roster. There is nobody to assign to and
 *     the owner is on the hook by definition, so the ownership language must
 *     not appear at all. This is the defect that prompted the rework (HQ
 *     internal, Aug 3 2026): a one-person business was told to "assign the
 *     contact to a teammate".
 *   - `covered`: somebody holds it. Name them and drop the warning. The copy
 *     deliberately says "is assigned", never "we texted them": the assignee
 *     SMS is best effort and returns false on an opt-out or a missing
 *     number, so the email must not report a send that may not have
 *     happened.
 *   - `unowned`: a roster exists and nobody on it holds this lead. The
 *     original alert (Truly Insurance, Jul 21 2026), and the only case where
 *     the warning was ever true.
 *
 * Attribution is a SEPARATE axis from state. A booking made on the public
 * page was made by the visitor, so crediting the AI coworker for it is
 * simply false; `surface` decides that line on its own.
 *
 * Deterministic and input-pure (no DB, no Date.now(), no env) so the copy is
 * testable without a stack, matching the other templates in this directory.
 */

import type { AppLocale } from "@/i18n/routing";
import { defaultLocale } from "@/i18n/routing";
import { emailMessagesForLocale, fmtEmail } from "@/lib/i18n/email-copy";

/** Which of the three answers to "who is on the hook" applies. */
export type BookingOwnerAlertState = "solo" | "covered" | "unowned";

/** Where the booking came from. Only `booking_page` is visitor-made. */
export type BookingOwnerAlertSurface = "voice" | "sms" | "webchat" | "booking_page";

export type BookingOwnerAlertInput = {
  state: BookingOwnerAlertState;
  /** Who holds it. Required in practice for `covered`; see the fallback below. */
  assigneeName?: string | null;
  attendeeName: string;
  attendeePhone?: string | null;
  attendeeEmail?: string | null;
  /** Human-readable business-local start, e.g. "Friday, August 14 ... MST". */
  startLocal: string;
  /** Event title, e.g. "Brett Douglas + New Coworker: Discovery Call". */
  summary: string;
  surface: BookingOwnerAlertSurface;
  durationMinutes?: number | null;
  joinUrl?: string | null;
  /** Whatever the visitor typed into the booking form. */
  note?: string | null;
  /** Answered intake questions, already rendered as "Question: answer" lines. */
  intakeLines?: string[];
  locale?: AppLocale;
};

export type BookingOwnerAlertCopy = {
  subject: string;
  /** Short H1. Deliberately NOT the subject: the old email said it twice. */
  heading: string;
  body: string;
  smsBody: string;
  ctaLabel: string;
  /** App-relative, joined to the origin by the dispatcher. */
  ctaPath: string;
  /** The dashboard notification row's one-line summary. */
  summaryLine: string;
};

/**
 * A US number the way a person reads it; anything else untouched.
 *
 * There is no shared display formatter in the repo (the dashboard renders
 * E.164 directly), and inventing a general one here would be the wrong
 * place for it. Non-NANP numbers stay E.164 rather than being forced into a
 * US shape, which matters now that Mexico tenants are live.
 */
function formatAttendeePhone(e164: string): string {
  const match = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164.trim());
  return match ? `(${match[1]}) ${match[2]}-${match[3]}` : e164;
}

/**
 * The meeting, without the visitor's name repeated back at the reader.
 *
 * The booking page titles its events `"<visitor> + <business>: <meeting>"`
 * (or `"<visitor> + <business> (<n> min)"` when the page has no meeting
 * types), so quoting the whole title inside a sentence that already names
 * the visitor produces `Brett Douglas booked "Brett Douglas + New Coworker:
 * Discovery Call"`. Strip the part the sentence already said.
 *
 * Page titles ONLY. An AI-surface summary is whatever the model passed and
 * has no fixed shape, so nothing is stripped from it.
 */
function meetingLabel(summary: string, attendeeName: string): string {
  const prefix = `${attendeeName} + `;
  if (!summary.startsWith(prefix)) return summary;
  const withoutVisitor = summary.slice(prefix.length);
  // "New Coworker: Discovery Call" -> "Discovery Call". No colon means the
  // no-meeting-type shape, which has nothing further to drop.
  const colon = withoutVisitor.indexOf(": ");
  const label = colon >= 0 ? withoutVisitor.slice(colon + 2) : withoutVisitor;
  return label.trim() || summary;
}

export function buildBookingOwnerAlert(input: BookingOwnerAlertInput): BookingOwnerAlertCopy {
  const locale = input.locale ?? defaultLocale;
  const copy = emailMessagesForLocale(locale).bookingOwnerAlert;

  const phone = input.attendeePhone?.trim() || null;
  const displayPhone = phone ? formatAttendeePhone(phone) : null;
  // "Name (phone)" is how the dashboard row and the SMS have always read.
  const who = displayPhone ? `${input.attendeeName} (${displayPhone})` : input.attendeeName;

  // A `covered` alert whose assignee name could not be resolved would say
  // "undefined is assigned to this appointment". Degrade to the warning
  // instead: over-asking is recoverable, a silent no-show is not.
  const assignee = input.assigneeName?.trim() || null;
  const state: BookingOwnerAlertState =
    input.state === "covered" && !assignee ? "unowned" : input.state;

  const vars = {
    name: input.attendeeName,
    who,
    when: input.startLocal,
    summary: input.summary,
    assignee: assignee ?? ""
  };

  const bookedLine =
    input.surface === "booking_page"
      ? fmtEmail(copy.bookedByVisitor, {
          ...vars,
          summary: meetingLabel(input.summary, input.attendeeName)
        })
      : fmtEmail(copy.bookedByAi, vars);

  // Everything a person needs in order to actually show up. Each line is
  // dropped entirely when there is no value for it, so the block never
  // renders a dangling label.
  const details = [
    displayPhone ? fmtEmail(copy.phoneLine, { phone: displayPhone }) : null,
    input.attendeeEmail?.trim() ? fmtEmail(copy.emailLine, { email: input.attendeeEmail.trim() }) : null,
    typeof input.durationMinutes === "number" && input.durationMinutes > 0
      ? fmtEmail(copy.durationLine, { minutes: String(input.durationMinutes) })
      : null,
    input.joinUrl?.trim() ? fmtEmail(copy.joinLine, { url: input.joinUrl.trim() }) : null,
    input.note?.trim() ? fmtEmail(copy.noteLine, { note: input.note.trim() }) : null,
    ...(input.intakeLines ?? []).filter((line) => line.trim().length > 0)
  ].filter((line): line is string => line !== null);

  const closing =
    state === "unowned"
      ? [copy.unownedWarning, copy.unownedAction]
      : state === "covered"
        ? [fmtEmail(copy.coveredLine, vars)]
        : // Solo: no closing line at all. The booking IS the message.
          [];

  const subject =
    state === "unowned"
      ? fmtEmail(copy.unownedSubject, vars)
      : state === "covered"
        ? fmtEmail(copy.coveredSubject, vars)
        : fmtEmail(copy.bookedSubject, vars);

  const summaryLine =
    state === "unowned"
      ? fmtEmail(copy.summaryUnowned, vars)
      : state === "covered"
        ? fmtEmail(copy.summaryCovered, vars)
        : fmtEmail(copy.summarySolo, vars);

  const smsTemplate =
    state === "unowned" ? copy.smsUnowned : state === "covered" ? copy.smsCovered : copy.smsSolo;

  return {
    subject,
    heading: state === "unowned" ? copy.unownedHeading : copy.bookedHeading,
    // Blank line between blocks: the dispatcher splits on \n\n into paragraphs.
    body: [bookedLine, details.join("\n"), ...closing].filter((b) => b.length > 0).join("\n\n"),
    smsBody: fmtEmail(smsTemplate, {
      // The SMS has always carried the summary line, trailing period trimmed
      // by the dispatcher.
      summary: summaryLine
    }),
    ctaLabel: state === "unowned" ? copy.assignCta : copy.openContactCta,
    // The contact page is where the owner picker lives, so the button does
    // the thing the email asks for instead of landing on a bare dashboard.
    ctaPath: phone ? `/dashboard/customers/${encodeURIComponent(phone)}` : "/dashboard/bookings",
    summaryLine
  };
}
