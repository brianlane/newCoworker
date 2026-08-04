/**
 * Owner alert for a booking that just landed, and who is on the hook for it.
 *
 * Why it exists (Truly Insurance, Jul 21 2026): a Privyr lead arrived after
 * hours, the flow's route_to_team found no eligible broker (`claimed_agent:
 * none`, contact `owner_employee_id` null), and minutes later the texting
 * coworker booked a REAL "12:00 PM tomorrow" broker call, onto a shared
 * Outlook calendar no one was watching. The only human-facing signal
 * ("[AiFlow] No broker claimed ... Back to you") predated the booking by
 * three minutes, so the business was set up to no-show its own lead.
 *
 * Why it was reworked (HQ internal, Aug 3 2026): the alert had exactly one
 * thing to say, and said it to everyone. A business with NO employees was
 * told to "assign the contact to a teammate" when there is no teammate to
 * assign to and the owner is on the hook by definition; a booking-page
 * booking that had just been round-robined to a named person was still
 * reported as owned by nobody; and a booking the visitor made themselves was
 * credited to the AI coworker. So ownership is now RESOLVED into one of
 * three states and the copy follows it:
 *
 *   1. `solo`    - no active roster member exists. Nobody to assign to.
 *   2. `covered` - the booking's assignee, else the contact's owner.
 *   3. `unowned` - a roster exists and nobody holds this lead. The warning.
 *
 * The alert runs after every CONFIRMED booking on a customer-facing surface
 * (voice, texting, webchat, and the public booking page; owner-initiated
 * dashboard/MCP bookings are excluded at the call sites, since the owner
 * already knows what they booked).
 *
 * Best-effort BY CONTRACT: this must never fail, delay semantics, or alter
 * the booking result. The appointment already exists on the provider.
 */
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { getNotificationPreferences } from "@/lib/db/notification-preferences";
import { dispatchUrgentNotification } from "@/lib/notifications/dispatch";
import { getTeamMember } from "@/lib/db/employees";
import {
  buildBookingOwnerAlert,
  type BookingOwnerAlertState,
  type BookingOwnerAlertSurface
} from "@/lib/email/templates/booking-owner-alert";
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
  /** Which surface booked it. Only `booking_page` is visitor-made. */
  surface: BookingOwnerAlertSurface;
  /**
   * Who holds the APPOINTMENT, when the surface has its own assignment
   * (`calendar_booking_dedupe.assignee_member_id`, set by the booking page's
   * round-robin). Outranks the contact's owner: the question this alert
   * answers is who shows up to THIS meeting.
   */
  bookingAssigneeMemberId?: string | null;
  /** Context a person needs in order to actually show up. */
  durationMinutes?: number | null;
  joinUrl?: string | null;
  note?: string | null;
  intakeLines?: string[];
};

export type UnassignedBookingAlertOutcome =
  | "sent_unowned"
  | "sent_covered"
  | "sent_solo"
  | "skipped_disabled"
  | "failed";

export type UnassignedBookingAlertDeps = {
  /** Injectable service client (tests). */
  client?: Awaited<ReturnType<typeof createSupabaseServiceClient>>;
  /** Injectable preference read (tests). */
  getPreferences?: typeof getNotificationPreferences;
  /** Injectable dispatcher (tests). */
  dispatch?: typeof dispatchUrgentNotification;
  /** Injectable roster read (tests). */
  getMember?: typeof getTeamMember;
};

/**
 * Does this business have anyone to assign work to?
 *
 * Only ACTIVE members count: a roster of people who have all left is the
 * same situation as no roster at all.
 *
 * Deliberately fails toward "yes, there is a roster". This read only chooses
 * the WORDING, so an error must not be allowed to reach the catch and
 * suppress the alert outright. Of the two wrong answers, telling a solo
 * owner to assign the lead is a wording miss they can ignore; telling a real
 * team that nobody needs to show up is the no-show this alert exists to
 * prevent.
 */
async function hasActiveRoster(
  db: Awaited<ReturnType<typeof createSupabaseServiceClient>>,
  businessId: string
): Promise<boolean> {
  try {
    const { count, error } = await db
      .from("ai_flow_team_members")
      .select("id", { count: "exact", head: true })
      .eq("business_id", businessId)
      .eq("active", true);
    if (error) throw new Error(error.message);
    return (count ?? 0) > 0;
  } catch (err) {
    logger.warn("unassigned-booking alert: roster count unreadable, assuming a team", {
      businessId,
      error: err instanceof Error ? err.message : String(err)
    });
    return true;
  }
}

/**
 * The stored contact's owner, looked up phone-first (alias-aware), then email.
 *
 * Ordered and limited rather than `maybeSingle()`: one number legitimately
 * matches TWO contacts (a merge leaves the number on one row's
 * `customer_e164` and another row's `alias_e164s`), and `maybeSingle` errors
 * on multiple rows. That error used to reach the catch below, so the owner
 * was told NOTHING about a real booking. The exact match wins, since an
 * alias is the weaker claim on a number.
 */
async function contactOwnerEmployeeId(
  db: Awaited<ReturnType<typeof createSupabaseServiceClient>>,
  businessId: string,
  phone: string | null,
  email: string | null
): Promise<string | null> {
  if (phone) {
    const { data, error } = await db
      .from("contacts")
      .select("owner_employee_id, customer_e164")
      .eq("business_id", businessId)
      .or(`customer_e164.eq.${phone},alias_e164s.cs.{${phone}}`)
      .limit(5);
    if (error) throw new Error(`contact lookup (phone): ${error.message}`);
    const rows = (data ?? []) as Array<{
      owner_employee_id: string | null;
      customer_e164: string | null;
    }>;
    if (rows.length > 0) {
      const exact = rows.find((r) => r.customer_e164 === phone);
      return (exact ?? rows[0]).owner_employee_id;
    }
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
    const getMember = deps.getMember ?? getTeamMember;

    // Missing prefs row = defaults = enabled; rows predating the column
    // read undefined = enabled. Only an explicit false disables. Checked
    // before any other read so a switched-off tenant costs one query.
    const prefs = await getPreferences(businessId, db);
    if (prefs?.unassigned_booking_alerts === false) return "skipped_disabled";

    const rostered = await hasActiveRoster(db, businessId);

    // Whoever holds the appointment outranks whoever owns the lead.
    const holderId =
      input.bookingAssigneeMemberId ??
      (await contactOwnerEmployeeId(db, businessId, input.attendeePhone, input.attendeeEmail));

    let assigneeName: string | null = null;
    if (holderId) {
      const member = await getMember(businessId, holderId);
      assigneeName = member?.name?.trim() || null;
    }

    // A solo business is never "unowned": there is no one to assign to.
    const state: BookingOwnerAlertState = !rostered
      ? "solo"
      : assigneeName
        ? "covered"
        : "unowned";

    const copyFor = (locale: Parameters<typeof buildBookingOwnerAlert>[0]["locale"]) =>
      buildBookingOwnerAlert({
        state,
        assigneeName,
        attendeeName: input.attendeeName,
        attendeePhone: input.attendeePhone,
        attendeeEmail: input.attendeeEmail,
        startLocal: input.startLocal,
        summary: input.summary,
        surface: input.surface,
        durationMinutes: input.durationMinutes,
        joinUrl: input.joinUrl,
        note: input.note,
        intakeLines: input.intakeLines,
        locale
      });

    // English for the dashboard row and the SMS: neither resolves a locale,
    // so there is nothing to render them in.
    const base = copyFor(undefined);

    await dispatch({
      businessId,
      kind: state === "unowned" ? "unassigned_booking" : "assigned_booking",
      summary: base.summaryLine,
      // The path is locale-independent, so it is safe (and useful) to set:
      // the SMS link uses it too, and all three links must agree.
      ctaPath: base.ctaPath,
      // No emailSubject / emailBody / emailHeading / ctaLabel here on
      // purpose. Explicit fields outrank the template in the dispatcher, so
      // supplying English ones would resolve the owner's locale and then
      // throw the result away. The email's copy comes from the template and
      // only from the template.
      emailTemplate: (locale) => {
        const localized = copyFor(locale);
        return {
          subject: localized.subject,
          heading: localized.heading,
          body: localized.body,
          ctaLabel: localized.ctaLabel,
          ctaPath: localized.ctaPath
        };
      },
      // No top-level contactE164 on purpose: this alert is addressed to the
      // business owner on every branch. Redirecting a "nobody owns this"
      // page to a contact owner would send it to the person the covered
      // branch already names, and send the solo branch nowhere new. The
      // contactE164 in the payload below is a dedupe key and the dashboard
      // row's deep link, not a routing input.
      smsBody: base.smsBody,
      payload: {
        attendee_name: input.attendeeName,
        attendee_phone: input.attendeePhone,
        attendee_email: input.attendeeEmail,
        start_iso: input.startIso,
        start_local: input.startLocal,
        event_summary: input.summary,
        event_id: input.eventId,
        surface: input.surface,
        ownership_state: state,
        assignee_member_id: holderId ?? null,
        assignee_name: assigneeName,
        ...(input.attendeePhone ? { contactE164: input.attendeePhone } : {})
      }
    });
    return state === "unowned" ? "sent_unowned" : state === "covered" ? "sent_covered" : "sent_solo";
  } catch (err) {
    logger.warn("unassigned-booking alert failed (booking unaffected)", {
      businessId,
      error: err instanceof Error ? err.message : String(err)
    });
    return "failed";
  }
}
