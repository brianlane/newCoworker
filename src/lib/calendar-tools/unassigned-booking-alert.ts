/**
 * Owner alert for AI bookings NOBODY on the team owns.
 *
 * Why (Truly Insurance, Jul 21 2026): a Privyr lead arrived after hours, the
 * flow's route_to_team found no eligible broker (`claimed_agent: none`,
 * contact `owner_employee_id` null), and minutes later the texting coworker
 * booked a REAL "12:00 PM tomorrow" broker call — onto a shared Outlook
 * calendar no one was watching. The only human-facing signal ("[AiFlow] No
 * broker claimed … Back to you") predated the booking by three minutes, so
 * the business was set up to no-show its own lead.
 *
 * This core runs after every CONFIRMED booking made on a customer-facing AI
 * surface (voice, texting, webchat — owner-initiated dashboard/MCP bookings
 * are excluded at the call sites: the owner already knows what they booked):
 *
 *   1. Resolve the attendee's contact (phone alias-aware, else email). A
 *      contact with `owner_employee_id` set is OWNED — no alert, the
 *      assignee's own workflow covers it. A missing contact counts as
 *      unowned (a booking is exactly when a lead must stop being nobody's).
 *   2. Honor the `unassigned_booking_alerts` preference — per-business
 *      toggle, ON by default (rows predating the column read as on).
 *   3. Fan out through the standard alert dispatcher (dashboard row + the
 *      owner's SMS/email/WhatsApp channel toggles). The dashboard row also
 *      surfaces the booking in the Recent Activity feed.
 *
 * Best-effort BY CONTRACT: this must never fail, delay semantics, or alter
 * the booking result — the appointment already exists on the provider.
 */
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { getNotificationPreferences } from "@/lib/db/notification-preferences";
import { dispatchUrgentNotification } from "@/lib/notifications/dispatch";
import { logger } from "@/lib/logger";

export type UnassignedBookingAlertInput = {
  /** Attendee identity as the booking core resolved it (post contact merge). */
  attendeeName: string;
  attendeePhone: string | null;
  attendeeEmail: string | null;
  /** Booking start: ISO instant + the human-readable business-local echo. */
  startIso: string;
  startLocal: string;
  /** Event title. */
  summary: string;
  /** Provider event id (diagnostics payload only). */
  eventId: string | null;
  /** Which AI surface booked it. */
  surface: "voice" | "sms" | "webchat";
};

export type UnassignedBookingAlertOutcome =
  | "sent"
  | "skipped_owned"
  | "skipped_disabled"
  | "failed";

export type UnassignedBookingAlertDeps = {
  /** Injectable service client (tests). */
  client?: Awaited<ReturnType<typeof createSupabaseServiceClient>>;
  /** Injectable preference read (tests). */
  getPreferences?: typeof getNotificationPreferences;
  /** Injectable dispatcher (tests). */
  dispatch?: typeof dispatchUrgentNotification;
};

/** The stored contact's owner, looked up phone-first (alias-aware), then email. */
async function contactOwnerEmployeeId(
  db: Awaited<ReturnType<typeof createSupabaseServiceClient>>,
  businessId: string,
  phone: string | null,
  email: string | null
): Promise<string | null> {
  if (phone) {
    const { data, error } = await db
      .from("contacts")
      .select("owner_employee_id")
      .eq("business_id", businessId)
      .or(`customer_e164.eq.${phone},alias_e164s.cs.{${phone}}`)
      .maybeSingle();
    if (error) throw new Error(`contact lookup (phone): ${error.message}`);
    if (data) return (data as { owner_employee_id: string | null }).owner_employee_id;
  }
  if (email) {
    const { data, error } = await db
      .from("contacts")
      .select("owner_employee_id")
      .eq("business_id", businessId)
      .eq("email", email.trim().toLowerCase())
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(`contact lookup (email): ${error.message}`);
    if (data) return (data as { owner_employee_id: string | null }).owner_employee_id;
  }
  // No contact row at all: unowned by definition.
  return null;
}

export async function maybeAlertUnassignedBooking(
  businessId: string,
  input: UnassignedBookingAlertInput,
  deps: UnassignedBookingAlertDeps = {}
): Promise<UnassignedBookingAlertOutcome> {
  try {
    const db = deps.client ?? (await createSupabaseServiceClient());
    const getPreferences = deps.getPreferences ?? getNotificationPreferences;
    const dispatch = deps.dispatch ?? dispatchUrgentNotification;

    const ownerEmployeeId = await contactOwnerEmployeeId(
      db,
      businessId,
      input.attendeePhone,
      input.attendeeEmail
    );
    if (ownerEmployeeId) return "skipped_owned";

    // Missing prefs row = defaults = enabled; rows predating the column
    // read undefined = enabled. Only an explicit false disables.
    const prefs = await getPreferences(businessId, db);
    if (prefs?.unassigned_booking_alerts === false) return "skipped_disabled";

    const who = input.attendeePhone
      ? `${input.attendeeName} (${input.attendeePhone})`
      : input.attendeeName;
    const summary = `Unassigned booking: ${who} — ${input.startLocal}`;
    const detailLines = [
      `Your AI coworker booked "${input.summary}" for ${who} at ${input.startLocal}.`,
      "No teammate owns this lead yet, so nobody is on the hook to show up.",
      "Assign the contact to a teammate (or handle it yourself) so the appointment is covered."
    ];
    await dispatch({
      businessId,
      kind: "unassigned_booking",
      summary,
      emailSubject: `New appointment needs an owner: ${who} — ${input.startLocal}`,
      emailBody: detailLines.join("\n\n"),
      smsBody: `New Coworker Alert: ${summary}. No teammate owns this lead yet — assign it so the appointment is covered.`,
      payload: {
        attendee_name: input.attendeeName,
        attendee_phone: input.attendeePhone,
        attendee_email: input.attendeeEmail,
        start_iso: input.startIso,
        start_local: input.startLocal,
        event_summary: input.summary,
        event_id: input.eventId,
        surface: input.surface,
        ...(input.attendeePhone ? { contactE164: input.attendeePhone } : {})
      }
    });
    return "sent";
  } catch (err) {
    logger.warn("unassigned-booking alert failed (booking unaffected)", {
      businessId,
      error: err instanceof Error ? err.message : String(err)
    });
    return "failed";
  }
}
