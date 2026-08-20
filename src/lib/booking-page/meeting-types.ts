/**
 * Meeting types under the booking calendar (the Calendly model).
 *
 * The page owns the shared policy (hours, notice, advance window, buffer,
 * caps, waitlist, reminders); a meeting type owns what the visitor is
 * actually booking: its name, duration, description, and optionally its
 * own questionnaire, assignment, and price. Each type has its own URL
 * (/book/<page>/<typeSlug>) rendering that meeting alone, so sharing a
 * discovery-call link never exposes the rest of the catalog.
 *
 * Inheritance is expressed as NULL in storage: a type with null
 * `intake_questions` asks the page's questions, a null `assignment_mode`
 * follows the page's assignment. `effectiveTypeSettings` is the single
 * place that resolution happens, pure so the rules are readable and
 * testable without a database.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { parseBookingPageSlug } from "@/lib/booking-page/keys";
import { logger } from "@/lib/logger";
import { parseIntakeQuestions, type BookingIntakeQuestion } from "@/lib/booking-page/intake";
import { BookingPageValidationError, type BookingPageRow } from "@/lib/booking-page/db";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export type BookingMeetingTypeRow = {
  id: string;
  business_id: string;
  name: string;
  slug: string;
  description: string | null;
  duration_minutes: number;
  /** Null = inherit the page's questions; [] = this type asks nothing. */
  intake_questions: unknown;
  /** Null = inherit the page's assignment. */
  assignment_mode: string | null;
  employee_id: string | null;
  payment_required: boolean;
  payment_amount_cents: number | null;
  payment_currency: string;
  enabled: boolean;
  /** Reachable by direct link, never listed on the page's picker. */
  hidden: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

const ALL_COLUMNS =
  "id,business_id,name,slug,description,duration_minutes,intake_questions," +
  "assignment_mode,employee_id,payment_required,payment_amount_cents,payment_currency," +
  "enabled,hidden,sort_order,created_at,updated_at";

/** Booking stays short: a handful of meetings, not a catalog. */
export const MAX_MEETING_TYPES = 10;
export const MAX_MEETING_TYPE_NAME_LENGTH = 120;
export const MAX_MEETING_TYPE_DESCRIPTION_LENGTH = 500;
/** Wide enough for a 15-minute intro or an all-day workshop. */
export const MIN_MEETING_DURATION_MINUTES = 5;
export const MAX_MEETING_DURATION_MINUTES = 480;

/** Every type the business has defined, in the owner's display order. */
export async function listMeetingTypes(
  businessId: string,
  client?: SupabaseClient
): Promise<BookingMeetingTypeRow[]> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("booking_meeting_types")
    .select(ALL_COLUMNS)
    .eq("business_id", businessId)
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: true });
  if (error) throw new Error(`listMeetingTypes: ${error.message}`);
  return (data ?? []) as unknown as BookingMeetingTypeRow[];
}

/**
 * The types the page's picker lists: enabled and not hidden. A hidden type
 * still books through its direct link; it is simply off the menu.
 */
export function visibleMeetingTypes(
  types: BookingMeetingTypeRow[]
): BookingMeetingTypeRow[] {
  return types.filter((t) => t.enabled && !t.hidden);
}

/**
 * Resolve one type by its URL segment. Disabled types answer null so the
 * direct link fails closed exactly like an unknown slug: the visitor sees
 * "not available", never the catalog.
 */
export async function getEnabledMeetingType(
  businessId: string,
  slug: string,
  client?: SupabaseClient
): Promise<BookingMeetingTypeRow | null> {
  const parsed = parseBookingPageSlug(slug);
  if (!parsed) return null;
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("booking_meeting_types")
    .select(ALL_COLUMNS)
    .eq("business_id", businessId)
    .eq("slug", parsed)
    .eq("enabled", true)
    .maybeSingle();
  if (error) throw new Error(`getEnabledMeetingType: ${error.message}`);
  return (data as unknown as BookingMeetingTypeRow | null) ?? null;
}

export type MeetingTypePatch = {
  name?: string;
  slug?: string;
  description?: string | null;
  durationMinutes?: number;
  /** Full replacement; null restores inheritance of the page's questions. */
  intakeQuestions?: unknown;
  /** Null restores inheritance of the page's assignment. */
  assignmentMode?: string | null;
  employeeId?: string | null;
  paymentRequired?: boolean;
  paymentAmountCents?: number | null;
  paymentCurrency?: string;
  enabled?: boolean;
  hidden?: boolean;
  sortOrder?: number;
};

function validatePatch(patch: MeetingTypePatch): void {
  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (!name || name.length > MAX_MEETING_TYPE_NAME_LENGTH) {
      throw new BookingPageValidationError(
        `Meeting name must be 1 to ${MAX_MEETING_TYPE_NAME_LENGTH} characters`
      );
    }
  }
  if (patch.slug !== undefined && parseBookingPageSlug(patch.slug) === null) {
    throw new BookingPageValidationError(
      "Meeting link must be 3 to 60 lowercase letters, digits, or hyphens"
    );
  }
  if (
    patch.description !== undefined &&
    patch.description !== null &&
    patch.description.length > MAX_MEETING_TYPE_DESCRIPTION_LENGTH
  ) {
    throw new BookingPageValidationError(
      `Description must be ${MAX_MEETING_TYPE_DESCRIPTION_LENGTH} characters or fewer`
    );
  }
  if (
    patch.durationMinutes !== undefined &&
    (!Number.isInteger(patch.durationMinutes) ||
      patch.durationMinutes < MIN_MEETING_DURATION_MINUTES ||
      patch.durationMinutes > MAX_MEETING_DURATION_MINUTES)
  ) {
    throw new BookingPageValidationError(
      `Duration must be ${MIN_MEETING_DURATION_MINUTES} to ${MAX_MEETING_DURATION_MINUTES} minutes`
    );
  }
  if (
    patch.intakeQuestions !== undefined &&
    patch.intakeQuestions !== null &&
    !Array.isArray(patch.intakeQuestions)
  ) {
    throw new BookingPageValidationError("Questions must be a list");
  }
  if (
    patch.assignmentMode !== undefined &&
    patch.assignmentMode !== null &&
    !["any", "round_robin", "fixed", "broadcast"].includes(patch.assignmentMode)
  ) {
    throw new BookingPageValidationError("Unknown assignment mode");
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
  if (
    patch.sortOrder !== undefined &&
    (!Number.isInteger(patch.sortOrder) || patch.sortOrder < 0 || patch.sortOrder > 999)
  ) {
    throw new BookingPageValidationError("Sort order must be 0 to 999");
  }
}

function patchColumns(patch: MeetingTypePatch): Record<string, unknown> {
  return {
    ...(patch.name === undefined ? {} : { name: patch.name.trim() }),
    ...(patch.slug === undefined ? {} : { slug: parseBookingPageSlug(patch.slug) }),
    ...(patch.description === undefined
      ? {}
      : { description: patch.description?.trim() || null }),
    ...(patch.durationMinutes === undefined
      ? {}
      : { duration_minutes: patch.durationMinutes }),
    // Stored NORMALIZED like the page's own column, and null stays null so
    // "inherit the page" survives the round trip.
    ...(patch.intakeQuestions === undefined
      ? {}
      : {
          intake_questions:
            patch.intakeQuestions === null
              ? null
              : parseIntakeQuestions(patch.intakeQuestions)
        }),
    ...(patch.assignmentMode === undefined ? {} : { assignment_mode: patch.assignmentMode }),
    ...(patch.employeeId === undefined ? {} : { employee_id: patch.employeeId }),
    ...(patch.paymentRequired === undefined ? {} : { payment_required: patch.paymentRequired }),
    ...(patch.paymentAmountCents === undefined
      ? {}
      : { payment_amount_cents: patch.paymentAmountCents }),
    ...(patch.paymentCurrency === undefined ? {} : { payment_currency: patch.paymentCurrency }),
    ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
    ...(patch.hidden === undefined ? {} : { hidden: patch.hidden }),
    ...(patch.sortOrder === undefined ? {} : { sort_order: patch.sortOrder })
  };
}

/** Owner-facing message for the per-business slug collision. */
function mapSlugCollision(message: string, prefix: string): Error {
  if (message.includes("uq_booking_meeting_types_business_slug")) {
    return new BookingPageValidationError("That meeting link is already taken");
  }
  return new Error(`${prefix}: ${message}`);
}

/**
 * The two self-contradicting states, checked on the RESULT of merging the
 * patch over what is stored (the same rule the page enforces): a 'fixed'
 * meeting with nobody named behaves like an unassigned one, and requiring
 * payment without a price refuses every booking while explaining nothing.
 */
function assertCoherent(
  existing: BookingMeetingTypeRow | null,
  patch: MeetingTypePatch
): void {
  const mode =
    patch.assignmentMode === undefined
      ? (existing?.assignment_mode ?? null)
      : patch.assignmentMode;
  const employee =
    patch.employeeId === undefined ? (existing?.employee_id ?? null) : patch.employeeId;
  if (mode === "fixed" && !employee?.trim()) {
    throw new BookingPageValidationError("Pick the employee this meeting books");
  }

  const required = patch.paymentRequired ?? existing?.payment_required ?? false;
  const amount =
    patch.paymentAmountCents === undefined
      ? (existing?.payment_amount_cents ?? null)
      : patch.paymentAmountCents;
  if (required && !amount) {
    throw new BookingPageValidationError("Set a price to require payment");
  }
}

/**
 * The name the backfill and the first-view provision both use, so a
 * freshly provisioned meeting reads the same in the dashboard as on the
 * public page.
 */
export const DEFAULT_MEETING_NAME = "Book a call";
export const DEFAULT_MEETING_SLUG = "book-a-call";

/**
 * What an ensure pass did, so a caller holding a page snapshot can keep it
 * honest: `pageQuestionsCleared` means the page row no longer carries the
 * questions the snapshot still shows.
 */
export type EnsureDefaultMeetingResult = {
  meetingType: BookingMeetingTypeRow | null;
  pageQuestionsCleared: boolean;
};

/**
 * Give a page its first meeting and finish the move of questions onto
 * meetings.
 *
 * Meetings are the only way a visitor books, so a page with none has
 * nothing to offer. The backfill migration handled every page that existed;
 * this covers pages created after it, called from the Bookings dashboard's
 * first view beside the page auto-provision.
 *
 * Questions are the delicate half. A page's list is still resolved by
 * `effectiveTypeSettings` for any meeting storing null, so the page's copy
 * cannot simply be deleted: every inheriting meeting takes its own copy
 * first, exactly as the migration does, and only then is the page cleared.
 * Both halves are idempotent and retried on later loads, since a page that
 * keeps its copy keeps handing hidden questions to new meetings.
 */
export async function ensureDefaultMeetingType(
  page: Pick<
    BookingPageRow,
    "business_id" | "description" | "allowed_durations" | "intake_questions"
  >,
  client?: SupabaseClient
): Promise<EnsureDefaultMeetingResult> {
  const db = client ?? (await createSupabaseServiceClient());
  const pageQuestions = parseIntakeQuestions(page.intake_questions);
  let existing = await listMeetingTypes(page.business_id, db);

  if (existing.length === 0) {
    // The shortest offered duration is what the page's picker selected by
    // default, so it is what visitors were most likely booking.
    const durationMinutes = page.allowed_durations.length
      ? Math.min(...page.allowed_durations)
      : 30;
    try {
      existing = [
        await createMeetingType(
          page.business_id,
          {
            // Always the default name. The page-level heading this used to
            // read (booking_pages.title) lost its editor in PR #985 and its
            // public render in #971, but this line kept it alive: deleting
            // your last meeting re-provisioned one named from a field you
            // could no longer see. The column is gone now.
            name: DEFAULT_MEETING_NAME,
            slug: DEFAULT_MEETING_SLUG,
            description: page.description,
            durationMinutes,
            // An explicit list, never null: inheriting questions the
            // dashboard no longer shows would surprise the owner.
            intakeQuestions: pageQuestions
          },
          db
        )
      ];
    } catch {
      // A second tab won the insert (unique slug per business); serve theirs.
      existing = await listMeetingTypes(page.business_id, db);
    }
  }

  const first = existing[0] ?? null;
  if (pageQuestions.length === 0 || !first) {
    return { meetingType: first, pageQuestionsCleared: false };
  }

  // Anything still storing null is asking the page's questions right now,
  // so it takes its own copy before the page loses them.
  const inheriting = existing.filter((t) => t.intake_questions === null);
  for (const type of inheriting) {
    const { error } = await db
      .from("booking_meeting_types")
      .update({ intake_questions: pageQuestions })
      .eq("id", type.id);
    // Leave the page's copy in place: it is the only record of what that
    // meeting asks until the copy lands. The next load retries.
    if (error) {
      logger.warn("ensureDefaultMeetingType: could not copy questions to a meeting", {
        businessId: page.business_id,
        meetingTypeId: type.id,
        error: error.message
      });
      return { meetingType: first, pageQuestionsCleared: false };
    }
  }

  const { error } = await db
    .from("booking_pages")
    .update({ intake_questions: [] })
    .eq("business_id", page.business_id);
  if (error) {
    logger.warn("ensureDefaultMeetingType: could not clear the page's questions", {
      businessId: page.business_id,
      error: error.message
    });
    return { meetingType: first, pageQuestionsCleared: false };
  }
  return { meetingType: first, pageQuestionsCleared: true };
}

/** Add one meeting type. Name, slug, and duration are required at birth. */
export async function createMeetingType(
  businessId: string,
  patch: MeetingTypePatch,
  client?: SupabaseClient
): Promise<BookingMeetingTypeRow> {
  validatePatch(patch);
  if (!patch.name?.trim() || !patch.slug || patch.durationMinutes === undefined) {
    throw new BookingPageValidationError("A meeting needs a name, link, and duration");
  }
  assertCoherent(null, patch);

  const db = client ?? (await createSupabaseServiceClient());
  const existing = await listMeetingTypes(businessId, db);
  if (existing.length >= MAX_MEETING_TYPES) {
    throw new BookingPageValidationError(
      `You can have up to ${MAX_MEETING_TYPES} meeting types`
    );
  }

  const { data, error } = await db
    .from("booking_meeting_types")
    .insert({
      business_id: businessId,
      // New types land at the end of the owner's list.
      sort_order: existing.length,
      ...patchColumns(patch)
    })
    .select(ALL_COLUMNS)
    .single();
  if (error) throw mapSlugCollision(error.message, "createMeetingType");
  return data as unknown as BookingMeetingTypeRow;
}

/** Edit one type, scoped to the business so a stray id cannot cross tenants. */
export async function updateMeetingType(
  businessId: string,
  id: string,
  patch: MeetingTypePatch,
  client?: SupabaseClient
): Promise<BookingMeetingTypeRow> {
  validatePatch(patch);
  const db = client ?? (await createSupabaseServiceClient());
  const existing = (await listMeetingTypes(businessId, db)).find((t) => t.id === id);
  if (!existing) throw new BookingPageValidationError("That meeting no longer exists");
  assertCoherent(existing, patch);

  const { data, error } = await db
    .from("booking_meeting_types")
    .update({ ...patchColumns(patch), updated_at: new Date().toISOString() })
    .eq("business_id", businessId)
    .eq("id", id)
    .select(ALL_COLUMNS)
    .single();
  if (error) throw mapSlugCollision(error.message, "updateMeetingType");
  return data as unknown as BookingMeetingTypeRow;
}

/**
 * Remove a type. Appointments already booked under it survive (the ledger
 * reference nulls out): deleting a meeting from the menu must never delete
 * the meetings people hold.
 */
export async function deleteMeetingType(
  businessId: string,
  id: string,
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db
    .from("booking_meeting_types")
    .delete()
    .eq("business_id", businessId)
    .eq("id", id);
  if (error) throw new Error(`deleteMeetingType: ${error.message}`);
}

export type EffectiveBookingSettings = {
  durationMinutes: number;
  /** The meeting's name: the event title and the left panel's heading. */
  title: string | null;
  description: string | null;
  questions: BookingIntakeQuestion[];
  assignmentMode: string;
  employeeId: string | null;
  paymentRequired: boolean;
  paymentAmountCents: number | null;
  paymentCurrency: string;
};

/**
 * What actually applies to one booking: the type's own settings where it
 * defines them, the page's everywhere else.
 *
 * `type` null is the typeless flow (no meeting types defined, or the AI
 * booking through the page), where the caller supplies the duration the
 * visitor picked.
 */
export function effectiveTypeSettings(
  page: BookingPageRow,
  type: BookingMeetingTypeRow | null,
  fallbackDurationMinutes: number
): EffectiveBookingSettings {
  const pageQuestions = parseIntakeQuestions(page.intake_questions);
  if (!type) {
    return {
      durationMinutes: fallbackDurationMinutes,
      // A meeting names itself, and without one there is nothing to name
      // the booking after: the caller falls back to its localized default.
      title: null,
      description: page.description,
      questions: pageQuestions,
      assignmentMode: page.assignment_mode,
      employeeId: page.employee_id,
      paymentRequired: page.payment_required,
      paymentAmountCents: page.payment_amount_cents,
      paymentCurrency: page.payment_currency
    };
  }

  // An explicit [] means "this meeting asks nothing", which is why the
  // inherit test is null and not emptiness.
  const ownQuestions =
    type.intake_questions === null || type.intake_questions === undefined
      ? null
      : parseIntakeQuestions(type.intake_questions);

  return {
    durationMinutes: type.duration_minutes,
    title: type.name,
    description: type.description ?? page.description,
    questions: ownQuestions ?? pageQuestions,
    assignmentMode: type.assignment_mode ?? page.assignment_mode,
    // The employee travels with the mode: a type that declares its own
    // assignment must not borrow the page's person, and one that inherits
    // must not strand the page's 'fixed' mode without one.
    employeeId: type.assignment_mode === null ? page.employee_id : type.employee_id,
    // Payment is an override in one direction only: a type can charge for
    // a meeting the page gives away, and a page that charges cannot be
    // undercut by a type that forgot to.
    paymentRequired: type.payment_required || page.payment_required,
    paymentAmountCents: type.payment_required
      ? type.payment_amount_cents
      : page.payment_amount_cents,
    paymentCurrency: type.payment_required ? type.payment_currency : page.payment_currency
  };
}
