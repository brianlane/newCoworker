/**
 * `booking_pages` rows: one public self-serve booking page per business.
 *
 * Service-role only (RLS on, no policies). The token is plaintext by
 * design (public capability — see keys.ts); everything else is the
 * availability policy the slot search applies on top of calendar
 * free/busy.
 */
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { mintBookingPageToken } from "@/lib/booking-page/keys";

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
  created_at: string;
  updated_at: string;
};

const ALL_COLUMNS =
  "id,business_id,token,enabled,allowed_durations,min_notice_minutes," +
  "max_advance_days,buffer_minutes,max_daily_bookings,require_staff_on_shift," +
  "description,created_at,updated_at";

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
      : { description: patch.description?.trim() || null })
  };
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
    if (error) throw new Error(`upsertBookingPage: ${error.message}`);
    return data as unknown as BookingPageRow;
  }

  const { data, error } = await db
    .from("booking_pages")
    .update({ ...patchColumns(patch), updated_at: new Date().toISOString() })
    .eq("business_id", businessId)
    .select(ALL_COLUMNS)
    .single();
  if (error) throw new Error(`upsertBookingPage: ${error.message}`);
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

/**
 * Platform bookings created for a business-local day (UTC instants of the
 * day's bounds are computed by the caller) — the daily-cap input. Counts
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
    .gte("start_at", startIso)
    .lt("start_at", endIso);
  if (error) throw new Error(`countBookingsBetween: ${error.message}`);
  return count ?? 0;
}
