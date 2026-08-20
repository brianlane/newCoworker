/**
 * `booking_pages` rows: one public self-serve booking page per business.
 *
 * Service-role only (RLS on, no policies). The token is plaintext by
 * design (public capability, see keys.ts); everything else is the
 * availability policy the slot search applies on top of calendar
 * free/busy.
 */
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { mintBookingPageToken, parseBookingPageSlug } from "@/lib/booking-page/keys";
import { parseIntakeQuestions } from "@/lib/booking-page/intake";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export type BookingPageRow = {
  id: string;
  business_id: string;
  token: string;
  enabled: boolean;
  allowed_durations: number[];
  min_notice_minutes: number;
  max_advance_days: number;
  buffer_minutes: number;
  max_daily_bookings: number | null;
  require_staff_on_shift: boolean;
  description: string | null;
  /** Cancellation waitlist: master toggle (on by default). */
  waitlist_enabled: boolean;
  /** How long one customer holds an offered freed slot before it passes on. */
  waitlist_offer_ttl_minutes: number;
  /** Vanity /book/<slug> URL; null = token URL only. */
  slug: string | null;
  /** Branded confirmation email at booking time (needs an attendee email). */
  send_confirmation_email: boolean;
  /** Master switch for both reminders. */
  reminders_enabled: boolean;
  /** Hours before the start for the email reminder; 0 disables just that one. */
  reminder_email_hours: number;
  /** Hours before the start for the SMS reminder; 0 disables just that one. */
  reminder_sms_hours: number;
  /** 'any' | 'round_robin' | 'fixed' | 'broadcast'; see booking-page/assignment.ts. */
  assignment_mode: string;
  /** The employee a 'fixed' page books; null otherwise. */
  employee_id: string | null;
  /** Text the assigned teammate when a booking lands on them. */
  notify_assignee: boolean;
  /** Owner-defined intake questions (see booking-page/intake.ts); [] = none. */
  intake_questions: unknown;
  /**
   * Payment hooks, schema only: when true the public submit refuses
   * bookings until collection ships, so a page marked as paid can never
   * hand out free appointments. No dashboard control yet by design.
   */
  payment_required: boolean;
  payment_amount_cents: number | null;
  payment_currency: string;
  created_at: string;
  updated_at: string;
};

const ALL_COLUMNS =
  "id,business_id,token,enabled,allowed_durations,min_notice_minutes," +
  "max_advance_days,buffer_minutes,max_daily_bookings,require_staff_on_shift," +
  "description,waitlist_enabled,waitlist_offer_ttl_minutes,slug," +
  "send_confirmation_email,reminders_enabled,reminder_email_hours,reminder_sms_hours," +
  "assignment_mode,employee_id,notify_assignee,intake_questions," +
  "payment_required,payment_amount_cents,payment_currency," +
  "created_at,updated_at";

/** Resolve a page by its public token. Enabled pages only. */
export async function getEnabledBookingPageByToken(
  token: string,
  client?: SupabaseClient
): Promise<BookingPageRow | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("booking_pages")
    .select(ALL_COLUMNS)
    .eq("token", token)
    .eq("enabled", true)
    .maybeSingle();
  if (error) throw new Error(`getEnabledBookingPageByToken: ${error.message}`);
  return (data as unknown as BookingPageRow | null) ?? null;
}

/** Resolve a page by its vanity slug. Enabled pages only. */
export async function getEnabledBookingPageBySlug(
  slug: string,
  client?: SupabaseClient
): Promise<BookingPageRow | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("booking_pages")
    .select(ALL_COLUMNS)
    .eq("slug", slug)
    .eq("enabled", true)
    .maybeSingle();
  if (error) throw new Error(`getEnabledBookingPageBySlug: ${error.message}`);
  return (data as unknown as BookingPageRow | null) ?? null;
}

/** The business's page row (any enabled state), or null before first setup. */
export async function getBookingPageForBusiness(
  businessId: string,
  client?: SupabaseClient
): Promise<BookingPageRow | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("booking_pages")
    .select(ALL_COLUMNS)
    .eq("business_id", businessId)
    .maybeSingle();
  if (error) throw new Error(`getBookingPageForBusiness: ${error.message}`);
  return (data as unknown as BookingPageRow | null) ?? null;
}

export type BookingPageSettingsPatch = {
  enabled?: boolean;
  allowedDurations?: number[];
  minNoticeMinutes?: number;
  maxAdvanceDays?: number;
  bufferMinutes?: number;
  maxDailyBookings?: number | null;
  requireStaffOnShift?: boolean;
  description?: string | null;
  waitlistEnabled?: boolean;
  waitlistOfferTtlMinutes?: number;
  sendConfirmationEmail?: boolean;
  remindersEnabled?: boolean;
  /** Hours before the start; 0 turns off just the email reminder. */
  reminderEmailHours?: number;
  /** Hours before the start; 0 turns off just the text reminder. */
  reminderSmsHours?: number;
  assignmentMode?: string;
  /** Required by 'fixed'; null clears it. */
  employeeId?: string | null;
  notifyAssignee?: boolean;
  /** Full replacement of the question list; validated before writing. */
  intakeQuestions?: unknown;
  paymentRequired?: boolean;
  paymentAmountCents?: number | null;
  paymentCurrency?: string;
  /** Vanity URL slug; null/blank clears back to the token-only URL. */
  slug?: string | null;
};

export class BookingPageValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BookingPageValidationError";
  }
}

/** Durations the picker supports; anything else is rejected at write time. */
export const BOOKING_PAGE_DURATION_CHOICES = [15, 30, 60] as const;

function validatePatch(patch: BookingPageSettingsPatch): void {
  if (patch.allowedDurations !== undefined) {
    const ok =
      patch.allowedDurations.length > 0 &&
      patch.allowedDurations.every((d) =>
        (BOOKING_PAGE_DURATION_CHOICES as readonly number[]).includes(d)
      );
    if (!ok) {
      throw new BookingPageValidationError(
        "Allowed durations must be a non-empty subset of 15, 30, 60"
      );
    }
  }
  if (
    patch.minNoticeMinutes !== undefined &&
    (!Number.isInteger(patch.minNoticeMinutes) ||
      patch.minNoticeMinutes < 0 ||
      patch.minNoticeMinutes > 7 * 24 * 60)
  ) {
    throw new BookingPageValidationError("Minimum notice must be 0 to 10080 minutes");
  }
  if (
    patch.maxAdvanceDays !== undefined &&
    (!Number.isInteger(patch.maxAdvanceDays) ||
      patch.maxAdvanceDays < 1 ||
      patch.maxAdvanceDays > 60)
  ) {
    throw new BookingPageValidationError("Max advance must be 1 to 60 days");
  }
  if (
    patch.bufferMinutes !== undefined &&
    (!Number.isInteger(patch.bufferMinutes) ||
      patch.bufferMinutes < 0 ||
      patch.bufferMinutes > 120)
  ) {
    throw new BookingPageValidationError("Buffer must be 0 to 120 minutes");
  }
  if (
    patch.maxDailyBookings !== undefined &&
    patch.maxDailyBookings !== null &&
    (!Number.isInteger(patch.maxDailyBookings) ||
      patch.maxDailyBookings < 1 ||
      patch.maxDailyBookings > 100)
  ) {
    throw new BookingPageValidationError("Daily cap must be 1 to 100 bookings, or empty");
  }
  if (
    patch.description !== undefined &&
    patch.description !== null &&
    patch.description.length > 500
  ) {
    throw new BookingPageValidationError("Description must be 500 characters or fewer");
  }
  if (
    patch.waitlistOfferTtlMinutes !== undefined &&
    (!Number.isInteger(patch.waitlistOfferTtlMinutes) ||
      patch.waitlistOfferTtlMinutes < 15 ||
      patch.waitlistOfferTtlMinutes > 24 * 60)
  ) {
    throw new BookingPageValidationError("Waitlist offer hold must be 15 to 1440 minutes");
  }
  if (patch.slug !== undefined && patch.slug !== null && patch.slug.trim() !== "") {
    if (parseBookingPageSlug(patch.slug) === null) {
      throw new BookingPageValidationError(
        "Custom link must be 3 to 60 lowercase letters, digits, or hyphens"
      );
    }
  }
  if (
    patch.assignmentMode !== undefined &&
    !["any", "round_robin", "fixed", "broadcast"].includes(patch.assignmentMode)
  ) {
    throw new BookingPageValidationError("Unknown assignment mode");
  }
  if (patch.intakeQuestions !== undefined && !Array.isArray(patch.intakeQuestions)) {
    throw new BookingPageValidationError("Questions must be a list");
  }
  if (
    patch.paymentAmountCents !== undefined &&
    patch.paymentAmountCents !== null &&
    (!Number.isInteger(patch.paymentAmountCents) ||
      patch.paymentAmountCents < 50 ||
      patch.paymentAmountCents > 5_000_000)
  ) {
    // Stripe's own floor and a sanity ceiling; the DB check mirrors this.
    throw new BookingPageValidationError("Price must be between $0.50 and $50,000");
  }
  if (
    patch.paymentCurrency !== undefined &&
    !["usd", "cad", "mxn", "eur", "gbp"].includes(patch.paymentCurrency)
  ) {
    throw new BookingPageValidationError("Unsupported currency");
  }

  for (const [value, label] of [
    [patch.reminderEmailHours, "Email reminder"],
    [patch.reminderSmsHours, "Text reminder"]
  ] as Array<[number | undefined, string]>) {
    // 0 is meaningful (that channel off); a week is the ceiling because the
    // sweep only scans that far ahead.
    if (value !== undefined && (!Number.isInteger(value) || value < 0 || value > 168)) {
      throw new BookingPageValidationError(`${label} lead time must be 0 to 168 hours`);
    }
  }
}

function patchColumns(patch: BookingPageSettingsPatch): Record<string, unknown> {
  return {
    ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
    ...(patch.allowedDurations === undefined
      ? {}
      : { allowed_durations: patch.allowedDurations }),
    ...(patch.minNoticeMinutes === undefined
      ? {}
      : { min_notice_minutes: patch.minNoticeMinutes }),
    ...(patch.maxAdvanceDays === undefined ? {} : { max_advance_days: patch.maxAdvanceDays }),
    ...(patch.bufferMinutes === undefined ? {} : { buffer_minutes: patch.bufferMinutes }),
    ...(patch.maxDailyBookings === undefined
      ? {}
      : { max_daily_bookings: patch.maxDailyBookings }),
    ...(patch.requireStaffOnShift === undefined
      ? {}
      : { require_staff_on_shift: patch.requireStaffOnShift }),
    ...(patch.description === undefined
      ? {}
      : { description: patch.description?.trim() || null }),
    ...(patch.waitlistEnabled === undefined ? {} : { waitlist_enabled: patch.waitlistEnabled }),
    ...(patch.waitlistOfferTtlMinutes === undefined
      ? {}
      : { waitlist_offer_ttl_minutes: patch.waitlistOfferTtlMinutes }),
    ...(patch.slug === undefined
      ? {}
      : { slug: patch.slug === null ? null : parseBookingPageSlug(patch.slug) }),
    ...(patch.sendConfirmationEmail === undefined
      ? {}
      : { send_confirmation_email: patch.sendConfirmationEmail }),
    ...(patch.remindersEnabled === undefined
      ? {}
      : { reminders_enabled: patch.remindersEnabled }),
    ...(patch.reminderEmailHours === undefined
      ? {}
      : { reminder_email_hours: patch.reminderEmailHours }),
    ...(patch.reminderSmsHours === undefined
      ? {}
      : { reminder_sms_hours: patch.reminderSmsHours }),
    ...(patch.assignmentMode === undefined ? {} : { assignment_mode: patch.assignmentMode }),
    ...(patch.employeeId === undefined ? {} : { employee_id: patch.employeeId }),
    ...(patch.notifyAssignee === undefined ? {} : { notify_assignee: patch.notifyAssignee }),
    // Stored NORMALIZED (parsed and re-serialized), never raw: the public
    // page trusts this column's shape.
    ...(patch.intakeQuestions === undefined
      ? {}
      : { intake_questions: parseIntakeQuestions(patch.intakeQuestions) }),
    ...(patch.paymentRequired === undefined ? {} : { payment_required: patch.paymentRequired }),
    ...(patch.paymentAmountCents === undefined
      ? {}
      : { payment_amount_cents: patch.paymentAmountCents }),
    ...(patch.paymentCurrency === undefined ? {} : { payment_currency: patch.paymentCurrency })
  };
}

/**
 * Postgres unique-violation on the SLUG index → owner-facing message.
 * Other unique violations (e.g. a concurrent first-time insert racing on
 * uq_booking_pages_business) stay generic errors.
 */
function mapSlugCollision(message: string): Error {
  if (message.includes("uq_booking_pages_slug")) {
    return new BookingPageValidationError("That custom link is already taken");
  }
  return new Error(`upsertBookingPage: ${message}`);
}

/**
 * Create-or-update the business's single page row. Creation mints the
 * token; updates never touch it (see rotateBookingPageToken).
 */
export async function upsertBookingPage(
  businessId: string,
  patch: BookingPageSettingsPatch,
  client?: SupabaseClient
): Promise<BookingPageRow> {
  validatePatch(patch);
  const db = client ?? (await createSupabaseServiceClient());
  const existing = await getBookingPageForBusiness(businessId, db);

  // A 'fixed' page with nobody named silently behaves like an unassigned
  // one, so the RESULTING state is what gets checked, not the patch shape:
  // switching to fixed without naming anyone, and clearing the employee on
  // a page already fixed, are the same mistake. Checked here rather than in
  // validatePatch because only this scope can see what is stored.
  const effectiveMode = patch.assignmentMode ?? existing?.assignment_mode ?? "any";
  const effectiveEmployee =
    patch.employeeId === undefined ? (existing?.employee_id ?? null) : patch.employeeId;
  if (effectiveMode === "fixed" && !effectiveEmployee?.trim()) {
    throw new BookingPageValidationError("Pick the employee this page books");
  }

  // Requiring payment without a price would refuse every booking while
  // telling the owner nothing. Checked on the RESULTING state (patch merged
  // over stored), so clearing the price on a page already requiring payment
  // is refused the same as enabling payment without one.
  const effectiveRequired = patch.paymentRequired ?? existing?.payment_required ?? false;
  const effectiveAmount =
    patch.paymentAmountCents === undefined
      ? (existing?.payment_amount_cents ?? null)
      : patch.paymentAmountCents;
  if (effectiveRequired && !effectiveAmount) {
    throw new BookingPageValidationError("Set a price to require payment");
  }

  if (!existing) {
    const { data, error } = await db
      .from("booking_pages")
      .insert({
        business_id: businessId,
        token: mintBookingPageToken(),
        ...patchColumns(patch)
      })
      .select(ALL_COLUMNS)
      .single();
    if (error) throw mapSlugCollision(error.message);
    return data as unknown as BookingPageRow;
  }

  const { data, error } = await db
    .from("booking_pages")
    .update({ ...patchColumns(patch), updated_at: new Date().toISOString() })
    .eq("business_id", businessId)
    .select(ALL_COLUMNS)
    .single();
  if (error) throw mapSlugCollision(error.message);
  return data as unknown as BookingPageRow;
}

/** Mint a fresh token (invalidates every previously shared link). */
export async function rotateBookingPageToken(
  businessId: string,
  client?: SupabaseClient
): Promise<BookingPageRow> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("booking_pages")
    .update({ token: mintBookingPageToken(), updated_at: new Date().toISOString() })
    .eq("business_id", businessId)
    .select(ALL_COLUMNS)
    .single();
  if (error) throw new Error(`rotateBookingPageToken: ${error.message}`);
  return data as unknown as BookingPageRow;
}

export type UpcomingBookingRow = {
  /** `phone:+1480...` or `email:x@y`, the ledger's attendee identity. */
  attendee_key: string;
  start_at: string;
  event_id: string | null;
  zoom_meeting_id: string | null;
  meet_join_url: string | null;
};

/**
 * Upcoming bookings from the dedupe ledger (soonest first), the Bookings
 * dashboard list. Ledger-backed on purpose: it covers platform bookings on
 * every provider plus synced external Vagaro/Calendly claims, without a
 * provider API fan-out on page load.
 */
export async function listUpcomingBookings(
  businessId: string,
  limit = 25,
  client?: SupabaseClient
): Promise<UpcomingBookingRow[]> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("calendar_booking_dedupe")
    .select("attendee_key,start_at,event_id,zoom_meeting_id,meet_join_url")
    .eq("business_id", businessId)
    .gte("start_at", new Date().toISOString())
    .order("start_at", { ascending: true })
    .limit(limit);
  if (error) throw new Error(`listUpcomingBookings: ${error.message}`);
  return (data ?? []) as UpcomingBookingRow[];
}

export type PlatformBookingRecord =
  | { ok: true }
  | { ok: false; reason: "duplicate" | "error" };

/**
 * Record a PLATFORM-NATIVE booking (no calendar integration connected):
 * a confirmed dedupe-ledger row with a synthetic `platform:` event id.
 * The ledger IS the calendar of record in this mode, the dashboard's
 * upcoming list, the daily cap, the attendee duplicate guard, and slot
 * busy-blocking all read it. Unlike recordExternalBookingClaim (a
 * best-effort sync mirror), a failure here is surfaced: this row is the
 * booking.
 */
export async function recordPlatformBooking(
  businessId: string,
  attendeeKey: string,
  startIso: string,
  eventId: string,
  zoomMeetingId: string | null,
  client?: SupabaseClient,
  manage?: { token: string; durationMinutes: number }
): Promise<PlatformBookingRecord> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db.from("calendar_booking_dedupe").insert({
    business_id: businessId,
    attendee_key: attendeeKey,
    start_at: startIso,
    event_id: eventId,
    zoom_meeting_id: zoomMeetingId,
    ...(manage
      ? { manage_token: manage.token, duration_minutes: manage.durationMinutes }
      : {})
  });
  if (!error) return { ok: true };
  if ((error as { code?: string }).code === "23505") {
    return { ok: false, reason: "duplicate" };
  }
  return { ok: false, reason: "error" };
}

/**
 * Booking start instants from the dedupe ledger inside a UTC window, the
 * daily-cap input (covers platform bookings on every provider plus synced
 * external Vagaro/Calendly claims). Callers group by business-local day.
 */
export async function listBookingStartsBetween(
  businessId: string,
  fromIso: string,
  toIso: string,
  client?: SupabaseClient
): Promise<Date[]> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("calendar_booking_dedupe")
    .select("start_at")
    .eq("business_id", businessId)
    // Confirmed bookings only: unconfirmed rows are transient in-flight
    // claims (including the public page's slot-scoped claim), not
    // appointments.
    .not("event_id", "is", null)
    .gte("start_at", fromIso)
    .lt("start_at", toIso);
  if (error) throw new Error(`listBookingStartsBetween: ${error.message}`);
  return ((data ?? []) as Array<{ start_at: string }>).map((r) => new Date(r.start_at));
}

/**
 * Platform bookings created for a business-local day (UTC instants of the
 * day's bounds are computed by the caller), the daily-cap input. Counts
 * the dedupe ledger, so external Vagaro/Calendly claims count too.
 */
export async function countBookingsBetween(
  businessId: string,
  startIso: string,
  endIso: string,
  client?: SupabaseClient
): Promise<number> {
  const db = client ?? (await createSupabaseServiceClient());
  const { count, error } = await db
    .from("calendar_booking_dedupe")
    .select("id", { count: "exact", head: true })
    .eq("business_id", businessId)
    // Confirmed bookings only, matching listBookingStartsBetween.
    .not("event_id", "is", null)
    .gte("start_at", startIso)
    .lt("start_at", endIso);
  if (error) throw new Error(`countBookingsBetween: ${error.message}`);
  return count ?? 0;
}

/** One public-page booking, addressed by its own manage token. */
export type ManagedBookingRow = {
  id: string;
  business_id: string;
  attendee_key: string;
  start_at: string;
  event_id: string | null;
  zoom_meeting_id: string | null;
  meet_join_url: string | null;
  duration_minutes: number | null;
};

/**
 * Attach a manage token to the ledger row a page booking just created, so
 * the confirmation can carry a self-serve reschedule/cancel link.
 *
 * Matched on (business, attendee, start) because the provider-mode write
 * happens inside the booking core, which knows nothing about manage links.
 * Only ever stamps a row that has none: a retry of the same booking must
 * not mint a second token and orphan the first.
 */
export async function stampManageToken(
  businessId: string,
  attendeeKey: string,
  startIso: string,
  token: string,
  durationMinutes: number,
  client?: SupabaseClient
): Promise<boolean> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("calendar_booking_dedupe")
    .update({ manage_token: token, duration_minutes: durationMinutes })
    .eq("business_id", businessId)
    .eq("attendee_key", attendeeKey)
    .eq("start_at", startIso)
    .is("manage_token", null)
    .select("id");
  if (error) throw new Error(`stampManageToken: ${error.message}`);
  return (data ?? []).length > 0;
}

/** The booking a manage token addresses, or null when it matches nothing. */
export async function getBookingByManageToken(
  token: string,
  client?: SupabaseClient
): Promise<ManagedBookingRow | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("calendar_booking_dedupe")
    .select(
      "id,business_id,attendee_key,start_at,event_id,zoom_meeting_id,meet_join_url,duration_minutes"
    )
    .eq("manage_token", token)
    .maybeSingle();
  if (error) throw new Error(`getBookingByManageToken: ${error.message}`);
  return (data as ManagedBookingRow | null) ?? null;
}

/**
 * Move a platform-mode booking in place. The ledger IS the calendar there,
 * so the row's start is the appointment; the token (and thus the invitee's
 * link) survives the move.
 */
export async function moveManagedBooking(
  rowId: string,
  startIso: string,
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db
    .from("calendar_booking_dedupe")
    // Reminder stamps belong to the OLD time; keeping them would silence
    // the reminders for the time the invitee actually holds now.
    .update({ start_at: startIso, reminders_sent: {} })
    .eq("id", rowId);
  if (error) throw new Error(`moveManagedBooking: ${error.message}`);
}

/** Drop a platform-mode booking: the row is the appointment. */
export async function deleteManagedBooking(
  rowId: string,
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db.from("calendar_booking_dedupe").delete().eq("id", rowId);
  if (error) throw new Error(`deleteManagedBooking: ${error.message}`);
}

/** Marks a ledger row as having come from the public booking page. */
export const BOOKING_PAGE_SOURCE = "booking_page";

/**
 * Record who the booking is for, and that it came from the public page.
 *
 * Two jobs, one write, because reminders need both: the ledger's
 * `attendee_key` is phone-first (so an email-reachable booking would be
 * unreachable by email), and the sweep must be able to tell page bookings
 * from AI, voice, and synced appointments whose attendees never opted into
 * reminders. The provenance is deliberately NOT inferred from the manage
 * token, so a booking whose manage-link stamp failed still gets reminded.
 *
 * Matched the same way the manage-token stamp is (business, attendee,
 * start), and answers whether a row actually matched.
 */
export async function stampAttendeeContact(
  businessId: string,
  attendeeKey: string,
  startIso: string,
  contact: {
    email?: string | null;
    name?: string | null;
    /** Who holds it, for a round-robin or per-employee page. */
    assigneeMemberId?: string | null;
    /** The visitor's intake answers, when the page asks questions. */
    intakeAnswers?: Record<string, string | string[]> | null;
    /** Which meeting type was booked; null on the typeless page flow. */
    meetingTypeId?: string | null;
  },
  client?: SupabaseClient
): Promise<boolean> {
  const email = contact.email?.trim() || null;
  const name = contact.name?.trim() || null;
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("calendar_booking_dedupe")
    .update({
      booking_source: BOOKING_PAGE_SOURCE,
      ...(contact.assigneeMemberId === undefined
        ? {}
        : { assignee_member_id: contact.assigneeMemberId }),
      ...(contact.intakeAnswers ? { intake_answers: contact.intakeAnswers } : {}),
      ...(contact.meetingTypeId ? { meeting_type_id: contact.meetingTypeId } : {}),
      ...(email ? { attendee_email: email } : {}),
      ...(name ? { attendee_name: name } : {})
    })
    .eq("business_id", businessId)
    .eq("attendee_key", attendeeKey)
    .eq("start_at", startIso)
    // Reported, not assumed: a key or start mismatch would otherwise leave
    // the booking unreachable for reminders with no sign anything was wrong.
    .select("id");
  if (error) throw new Error(`stampAttendeeContact: ${error.message}`);
  return (data ?? []).length > 0;
}

/**
 * Each employee's upcoming assigned load, for the round-robin choice.
 *
 * Counting real bookings rather than rotating a pointer means a week that
 * emptied out to cancellations self-corrects instead of compounding. Only
 * confirmed, still-upcoming page bookings count.
 */
export async function countUpcomingByAssignee(
  businessId: string,
  client?: SupabaseClient
): Promise<Map<string, number>> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("calendar_booking_dedupe")
    .select("assignee_member_id")
    .eq("business_id", businessId)
    .not("event_id", "is", null)
    .not("assignee_member_id", "is", null)
    .gte("start_at", new Date().toISOString());
  if (error) throw new Error(`countUpcomingByAssignee: ${error.message}`);
  const counts = new Map<string, number>();
  for (const row of (data ?? []) as Array<{ assignee_member_id: string | null }>) {
    const id = row.assignee_member_id;
    if (!id) continue;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

/**
 * Fill in a booking's assignee ONLY if it does not have one.
 *
 * For the idempotent resubmit: the original booking's assignment is the
 * right answer, and re-resolving can legitimately name someone else (loads
 * moved, shifts changed), so a blind write would silently reassign work
 * that is already on somebody's calendar. Conditional on the column still
 * being null, so the retry only repairs a genuine gap.
 */
export async function stampAssigneeIfUnset(
  businessId: string,
  attendeeKey: string,
  startIso: string,
  memberId: string,
  client?: SupabaseClient
): Promise<boolean> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("calendar_booking_dedupe")
    .update({ assignee_member_id: memberId })
    .eq("business_id", businessId)
    .eq("attendee_key", attendeeKey)
    .eq("start_at", startIso)
    .is("assignee_member_id", null)
    // Whether the gap was actually filled, so the caller can tell a repair
    // from a no-op and only then advance the round-robin tiebreak.
    .select("id");
  if (error) throw new Error(`stampAssigneeIfUnset: ${error.message}`);
  return (data ?? []).length > 0;
}

/**
 * Stamp a booking's assignee by its dedupe-ledger row id, only when nobody
 * holds it yet. The AI door and the broadcast "1" claim both land here: the
 * compare-and-swap on null means a duplicate model turn, a raced claim, or
 * a stale reply can never reassign work already on somebody's calendar.
 */
export async function stampAssigneeByClaimId(
  claimId: string,
  memberId: string,
  client?: SupabaseClient
): Promise<boolean> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("calendar_booking_dedupe")
    .update({ assignee_member_id: memberId })
    .eq("id", claimId)
    .is("assignee_member_id", null)
    .select("id");
  if (error) throw new Error(`stampAssigneeByClaimId: ${error.message}`);
  return (data ?? []).length > 0;
}

/**
 * Win the right to tell the owner about this booking, exactly once.
 *
 * The owner alert reports who is on the hook, so it runs late, after contact
 * filing and assignment. That leaves a window: a request that persists the
 * booking and then dies has an appointment nobody was told about, and the
 * visitor's idempotent resubmit would return success without paging anyone.
 * Claiming lets the resubmit close that gap while making a double alert
 * impossible, the same conditional-update shape `stampAssigneeIfUnset` uses.
 *
 * Returns the assignee as it stands at claim time, so the caller does not
 * need a second read to say who has it.
 */
export async function claimOwnerBookingAlert(
  businessId: string,
  attendeeKey: string,
  startIso: string,
  client?: SupabaseClient
): Promise<{ claimed: boolean; assigneeMemberId: string | null }> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("calendar_booking_dedupe")
    .update({ owner_alerted_at: new Date().toISOString() })
    .eq("business_id", businessId)
    .eq("attendee_key", attendeeKey)
    .eq("start_at", startIso)
    .is("owner_alerted_at", null)
    .select("id, assignee_member_id");
  if (error) throw new Error(`claimOwnerBookingAlert: ${error.message}`);
  const rows = (data ?? []) as Array<{ assignee_member_id: string | null }>;
  return {
    claimed: rows.length > 0,
    assigneeMemberId: rows[0]?.assignee_member_id ?? null
  };
}
