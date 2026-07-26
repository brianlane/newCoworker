/**
 * Booking reminders: the email a day out and the text a couple of hours
 * out, for appointments made on the public page.
 *
 * Why both channels: email carries the video link and the manage link a
 * text cannot fit, and a text is what actually gets read on the day. Owners
 * set the lead times per page (0 turns off just that channel).
 *
 * Idempotence is the whole game here. Every send is stamped on the booking
 * row BEFORE it goes out, so an overlapping tick, a retry, or a redeploy
 * mid-sweep can never text the same person twice: an owner would rather a
 * reminder be missed than doubled.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { getBusiness } from "@/lib/db/businesses";
import {
  BOOKING_PAGE_SOURCE,
  getBookingPageForBusiness,
  type BookingPageRow
} from "@/lib/booking-page/db";
import { buildBookingConfirmationEmail } from "@/lib/email/templates/booking-confirmation";
import { sendFromOwnerMailbox } from "@/lib/email/owner-mailbox";
import { recordOutboundAssistantEmail } from "@/lib/db/email-log";
import { getTelnyxMessagingForBusiness, sendTelnyxSms } from "@/lib/telnyx/messaging";
import { checkSmsOptOut } from "@/lib/sms/opt-outs";
import { getZoomJoinUrl } from "@/lib/zoom/meetings";
import { bookingTimeLabel } from "@/lib/email/templates/booking-confirmation";
import { getContactLanguage } from "@/lib/db/contact-language";
import { fmtEmail } from "@/lib/i18n/email-copy";
import type { AppLocale } from "@/i18n/routing";
import { logger } from "@/lib/logger";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export type ReminderChannel = "email" | "sms";

export type BookingReminderResult = {
  scanned: number;
  emailsSent: number;
  textsSent: number;
  skipped: number;
};

/** How far ahead the sweep looks. Wider than the largest lead time. */
export const REMINDER_SCAN_HOURS = 7 * 24 + 2;

/** Per-pass ceiling, so one busy tenant cannot starve the rest. */
export const REMINDER_BATCH_LIMIT = 200;

type ReminderRow = {
  id: string;
  business_id: string;
  attendee_key: string;
  attendee_email: string | null;
  attendee_name: string | null;
  start_at: string;
  duration_minutes: number | null;
  zoom_meeting_id: string | null;
  manage_token: string | null;
  reminders_sent: Record<string, unknown> | null;
};

const COLUMNS =
  "id,business_id,attendee_key,attendee_email,attendee_name,start_at," +
  "duration_minutes,zoom_meeting_id,manage_token,reminders_sent";

/** SMS reminder copy. Kept beside the email catalog entry it mirrors. */
function reminderSmsCopy(locale: AppLocale): { body: string; change: string } {
  return locale === "es"
    ? {
        body: "Recordatorio: tu cita con {business} es {when}.",
        change: "Cámbiala aquí: {url}"
      }
    : {
        body: "Reminder: your appointment with {business} is {when}.",
        change: "Change it here: {url}"
      };
}

/**
 * Language for one booking's reminders: the contact's stored preference
 * when there is one, else English. Phone-keyed lookups only, which is what
 * the contacts table is keyed on.
 */
async function contactLocale(row: ReminderRow, db: SupabaseClient): Promise<AppLocale> {
  const phone = attendeePhoneFromKey(row.attendee_key);
  if (!phone) return "en";
  try {
    const language = await getContactLanguage(row.business_id, phone, db);
    return language.preferred_language === "es" ? "es" : "en";
  } catch {
    return "en";
  }
}

/** Phone from the ledger's attendee key, when it is phone-keyed. */
export function attendeePhoneFromKey(attendeeKey: string): string | null {
  return attendeeKey.startsWith("phone:") ? attendeeKey.slice("phone:".length) : null;
}

/**
 * Is this channel's reminder due for a booking starting at `startMs`?
 * Due means "inside the lead window and not yet past the appointment": a
 * sweep that missed its exact moment (outage, cold start) still sends,
 * because a late reminder beats none.
 */
export function reminderDue(
  startMs: number,
  leadHours: number,
  nowMs: number
): boolean {
  if (leadHours <= 0) return false;
  if (startMs <= nowMs) return false;
  return startMs - nowMs <= leadHours * 60 * 60 * 1000;
}

/** Rows whose appointment is inside the scan window, soonest first. */
async function upcomingBookings(db: SupabaseClient, nowMs: number): Promise<ReminderRow[]> {
  const { data, error } = await db
    .from("calendar_booking_dedupe")
    .select(COLUMNS)
    .not("event_id", "is", null)
    // Public-page bookings ONLY: their attendees are the ones who opted into
    // reminders, unlike AI, voice, and synced provider appointments. Keyed
    // on the provenance stamp rather than the manage token, so a booking
    // whose manage-link stamp failed still gets reminded.
    .eq("booking_source", BOOKING_PAGE_SOURCE)
    .gte("start_at", new Date(nowMs).toISOString())
    .lt("start_at", new Date(nowMs + REMINDER_SCAN_HOURS * 60 * 60 * 1000).toISOString())
    .order("start_at", { ascending: true })
    .limit(REMINDER_BATCH_LIMIT);
  if (error) throw new Error(`upcomingBookings: ${error.message}`);
  return (data ?? []) as unknown as ReminderRow[];
}

/**
 * Claim one channel's reminder for one booking. Conditional on the stamp
 * still being absent, so two overlapping passes cannot both send: the
 * loser's update matches no row.
 */
async function claimReminder(
  db: SupabaseClient,
  row: ReminderRow,
  channel: ReminderChannel
): Promise<boolean> {
  // Server-side jsonb concat, not a read-modify-write: spreading the scan
  // row's stamps here would let the second channel's write drop the first
  // channel's stamp (which a later pass would then re-send), and the
  // WHERE clause inside the function is what makes the claim atomic.
  const { data, error } = await db.rpc("claim_booking_reminder", {
    p_booking_id: row.id,
    p_channel: channel
  });
  if (error) throw new Error(`claimReminder: ${error.message}`);
  return data === true;
}

async function sendEmailReminder(
  row: ReminderRow,
  businessName: string,
  businessTimeZone: string,
  siteUrl: string,
  locale: AppLocale
): Promise<boolean> {
  /* c8 ignore next -- callers gate on attendee_email before claiming */
  if (!row.attendee_email) return false;
  const joinUrl = row.zoom_meeting_id
    ? await getZoomJoinUrl(row.business_id, row.zoom_meeting_id)
    : null;
  const email = buildBookingConfirmationEmail({
    kind: "reminder",
    businessName,
    startIso: row.start_at,
    durationMinutes: row.duration_minutes ?? 30,
    businessTimeZone,
    joinUrl,
    manageUrl: row.manage_token ? `${siteUrl}/book/manage/${row.manage_token}` : null,
    recipientEmail: row.attendee_email,
    siteUrl,
    locale
  });
  const sent = await sendFromOwnerMailbox(row.business_id, {
    toEmail: row.attendee_email,
    subject: email.subject,
    bodyText: email.text
  });
  if (!sent.ok) return false;
  await recordOutboundAssistantEmail({
    businessId: row.business_id,
    toEmail: row.attendee_email,
    subject: email.subject,
    bodyText: email.text,
    source: "booking_reminder",
    providerMessageId: sent.messageId
  });
  // Deliberately NOT claiming the thread for the email coworker: nobody
  // asked it a question, so a reply here belongs to a person.
  return true;
}

async function sendSmsReminder(
  row: ReminderRow,
  businessName: string,
  businessTimeZone: string,
  siteUrl: string,
  locale: AppLocale
): Promise<boolean> {
  const phone = attendeePhoneFromKey(row.attendee_key);
  /* c8 ignore next -- callers gate on a phone-keyed booking before claiming */
  if (!phone) return false;
  // STOP-list gate, fail closed like every other customer-facing send.
  const optOut = await checkSmsOptOut(row.business_id, phone);
  if (!optOut.ok || optOut.optedOut) return false;

  const when = bookingTimeLabel(row.start_at, businessTimeZone, locale);
  const manageUrl = row.manage_token ? `${siteUrl}/book/manage/${row.manage_token}` : null;
  const copy = reminderSmsCopy(locale);
  const body = [
    fmtEmail(copy.body, { business: businessName, when }),
    ...(manageUrl ? [fmtEmail(copy.change, { url: manageUrl })] : [])
  ].join(" ");

  const config = await getTelnyxMessagingForBusiness(row.business_id, undefined, {
    resolveRcs: true
  });
  await sendTelnyxSms(config, phone, body, { meterBusinessId: row.business_id });
  return true;
}

/**
 * One reminder pass. Per-booking failures are isolated: a dead mailbox on
 * one tenant must not stop the rest of the fleet's reminders.
 */
export async function sweepBookingReminders(
  siteUrl: string,
  client?: SupabaseClient,
  nowMs = Date.now()
): Promise<BookingReminderResult> {
  const db = client ?? (await createSupabaseServiceClient());
  const result: BookingReminderResult = { scanned: 0, emailsSent: 0, textsSent: 0, skipped: 0 };

  const rows = await upcomingBookings(db, nowMs);
  result.scanned = rows.length;
  if (rows.length === 0) return result;

  // Page + business are per-tenant, and one tenant usually owns several of
  // the rows in a pass.
  const pageCache = new Map<string, BookingPageRow | null>();
  const businessCache = new Map<string, { name: string; timezone: string } | null>();

  for (const row of rows) {
    try {
      if (!pageCache.has(row.business_id)) {
        pageCache.set(row.business_id, await getBookingPageForBusiness(row.business_id));
      }
      const page = pageCache.get(row.business_id) ?? null;
      if (!page || !page.reminders_enabled) {
        result.skipped += 1;
        continue;
      }

      if (!businessCache.has(row.business_id)) {
        const business = await getBusiness(row.business_id);
        businessCache.set(
          row.business_id,
          business
            ? { name: business.name, timezone: business.timezone || "UTC" }
            : null
        );
      }
      const business = businessCache.get(row.business_id) ?? null;
      if (!business) {
        result.skipped += 1;
        continue;
      }

      const startMs = Date.parse(row.start_at);
      const stamps = row.reminders_sent ?? {};
      // The contact's own language, the same source SMS and waitlist offers
      // use, so a Spanish-speaking visitor is not reminded in English.
      const locale = await contactLocale(row, db);

      // Reachability BEFORE the claim: claiming a channel we cannot use
      // would stamp it and stop every later pass from trying.
      const canEmail = Boolean(row.attendee_email);
      const canText = attendeePhoneFromKey(row.attendee_key) !== null;

      if (canEmail && !stamps.email && reminderDue(startMs, page.reminder_email_hours, nowMs)) {
        // Claimed BEFORE sending: a crash after this point costs one
        // reminder, while claiming after would risk sending twice.
        if (await claimReminder(db, row, "email")) {
          if (
            await sendEmailReminder(row, business.name, business.timezone, siteUrl, locale)
          ) {
            result.emailsSent += 1;
          }
        }
      }

      if (canText && !stamps.sms && reminderDue(startMs, page.reminder_sms_hours, nowMs)) {
        if (await claimReminder(db, row, "sms")) {
          if (await sendSmsReminder(row, business.name, business.timezone, siteUrl, locale)) {
            result.textsSent += 1;
          }
        }
      }
    } catch (err) {
      result.skipped += 1;
      logger.warn("booking-reminders: booking skipped", {
        businessId: row.business_id,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  return result;
}
