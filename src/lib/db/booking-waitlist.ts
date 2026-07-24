/**
 * `booking_waitlist` rows: customers who asked to be told when an EARLIER
 * appointment time opens up ("I'll let you know if I have a cancellation").
 *
 * One LIVE row (status waiting/offered) per (business, phone), enforced by
 * a partial unique index, so joining again refreshes the window instead of
 * stacking duplicate offers. Service-role only (RLS on, no policies).
 *
 * The offer/sweep state machine lives in
 * src/lib/calendar-tools/waitlist-fill.ts; this module is plain reads and
 * guarded writes.
 */
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { digitsOf, phoneDigitsMatch } from "@/lib/calendar-tools/phone-match";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export type BookingWaitlistStatus =
  | "waiting"
  | "offered"
  | "fulfilled"
  | "expired"
  | "canceled";

export type BookingWaitlistRow = {
  id: string;
  business_id: string;
  phone: string;
  email: string | null;
  name: string | null;
  duration_minutes: number;
  earliest_at: string;
  latest_at: string | null;
  current_booking_start_at: string | null;
  current_event_id: string | null;
  status: BookingWaitlistStatus;
  offered_start_at: string | null;
  offered_end_at: string | null;
  offer_expires_at: string | null;
  last_offered_start_at: string | null;
  created_at: string;
  updated_at: string;
};

const ALL_COLUMNS =
  "id,business_id,phone,email,name,duration_minutes,earliest_at,latest_at," +
  "current_booking_start_at,current_event_id,status,offered_start_at," +
  "offered_end_at,offer_expires_at,last_offered_start_at,created_at,updated_at";

/** Offer hold when the owner never tuned it. */
export const WAITLIST_DEFAULT_OFFER_TTL_MINUTES = 60;
/** Appointment length assumed when the tool call carries none. */
export const WAITLIST_DEFAULT_DURATION_MINUTES = 30;
/** Window of interest for entries with no linked booking and no bound. */
export const WAITLIST_DEFAULT_WINDOW_DAYS = 14;
/** Fleet-wide rows handled per sweep tick (both sweep phases). */
export const WAITLIST_SWEEP_PAGE = 100;

export type WaitlistSettings = {
  enabled: boolean;
  offerTtlMinutes: number;
};

/**
 * Owner knobs from the business's Bookings settings row. A missing row (or
 * any read hiccup) answers the defaults, the waitlist is ON by default and
 * must work for tenants who never opened the Bookings page.
 */
export async function getWaitlistSettings(
  businessId: string,
  client?: SupabaseClient
): Promise<WaitlistSettings> {
  const defaults: WaitlistSettings = {
    enabled: true,
    offerTtlMinutes: WAITLIST_DEFAULT_OFFER_TTL_MINUTES
  };
  try {
    const db = client ?? (await createSupabaseServiceClient());
    const { data, error } = await db
      .from("booking_pages")
      .select("waitlist_enabled, waitlist_offer_ttl_minutes")
      .eq("business_id", businessId)
      .maybeSingle();
    if (error || !data) return defaults;
    const row = data as {
      waitlist_enabled: boolean | null;
      waitlist_offer_ttl_minutes: number | null;
    };
    return {
      enabled: row.waitlist_enabled !== false,
      offerTtlMinutes:
        typeof row.waitlist_offer_ttl_minutes === "number" && row.waitlist_offer_ttl_minutes > 0
          ? row.waitlist_offer_ttl_minutes
          : WAITLIST_DEFAULT_OFFER_TTL_MINUTES
    };
  } catch {
    return defaults;
  }
}

export type UpsertWaitlistInput = {
  phone: string;
  email?: string | null;
  name?: string | null;
  durationMinutes?: number;
  earliestAtIso?: string | null;
  latestAtIso?: string | null;
  currentBookingStartAtIso?: string | null;
  currentEventId?: string | null;
};

function upsertColumns(input: UpsertWaitlistInput): Record<string, unknown> {
  return {
    ...(input.email !== undefined ? { email: input.email?.trim().toLowerCase() || null } : {}),
    ...(input.name !== undefined ? { name: input.name?.trim() || null } : {}),
    duration_minutes: input.durationMinutes ?? WAITLIST_DEFAULT_DURATION_MINUTES,
    earliest_at: input.earliestAtIso ?? new Date().toISOString(),
    latest_at: input.latestAtIso ?? null,
    current_booking_start_at: input.currentBookingStartAtIso ?? null,
    current_event_id: input.currentEventId ?? null
  };
}

/**
 * Create the customer's live waitlist entry, or refresh the existing one
 * (window, duration, linked booking) in place. A refresh keeps the row's
 * status and offer state, a pending offer survives the customer restating
 * the request. Returns null on any DB error (callers fail soft).
 */
export async function upsertLiveWaitlistEntry(
  businessId: string,
  input: UpsertWaitlistInput,
  client?: SupabaseClient
): Promise<{ row: BookingWaitlistRow; created: boolean } | null> {
  try {
    const db = client ?? (await createSupabaseServiceClient());
    const phone = input.phone.trim();

    const refresh = async (): Promise<{ row: BookingWaitlistRow; created: boolean } | null> => {
      const { data, error } = await db
        .from("booking_waitlist")
        .update({ ...upsertColumns(input), updated_at: new Date().toISOString() })
        .eq("business_id", businessId)
        .eq("phone", phone)
        .in("status", ["waiting", "offered"])
        .select(ALL_COLUMNS)
        .maybeSingle();
      if (error || !data) return null;
      return { row: data as unknown as BookingWaitlistRow, created: false };
    };

    const existing = await refresh();
    if (existing) return existing;

    const { data, error } = await db
      .from("booking_waitlist")
      .insert({ business_id: businessId, phone, ...upsertColumns(input) })
      .select(ALL_COLUMNS)
      .maybeSingle();
    if (!error && data) {
      return { row: data as unknown as BookingWaitlistRow, created: true };
    }
    // Unique-violation: a racing join created the live row between the
    // refresh miss and the insert, refresh that one instead.
    if (error && (error as { code?: string }).code === "23505") {
      return refresh();
    }
    return null;
  } catch {
    return null;
  }
}

/** Every live (waiting/offered) entry for the business, oldest first. */
export async function listLiveWaitlistEntries(
  businessId: string,
  client?: SupabaseClient
): Promise<BookingWaitlistRow[]> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("booking_waitlist")
    .select(ALL_COLUMNS)
    .eq("business_id", businessId)
    .in("status", ["waiting", "offered"])
    .order("created_at", { ascending: true })
    .limit(WAITLIST_SWEEP_PAGE);
  if (error) throw new Error(`listLiveWaitlistEntries: ${error.message}`);
  return (data ?? []) as unknown as BookingWaitlistRow[];
}

/**
 * Live entries belonging to an attendee, matched digit-tolerantly on phone
 * (E.164 vs national shapes agree) or exactly on lower-cased email. Empty
 * on any error, lifecycle hooks fail soft.
 */
export async function findLiveWaitlistEntriesForAttendee(
  businessId: string,
  attendee: { phones: string[]; email?: string | null },
  client?: SupabaseClient
): Promise<BookingWaitlistRow[]> {
  try {
    const rows = await listLiveWaitlistEntries(businessId, client);
    const wantedDigits = attendee.phones.map((p) => digitsOf(p)).filter((d) => d.length > 0);
    const wantedEmail = attendee.email?.trim().toLowerCase() || null;
    return rows.filter((row) => {
      const rowDigits = digitsOf(row.phone);
      if (
        rowDigits.length > 0 &&
        wantedDigits.some((d) => phoneDigitsMatch(rowDigits, d))
      ) {
        return true;
      }
      return wantedEmail !== null && (row.email ?? "") === wantedEmail;
    });
  } catch {
    return [];
  }
}

/**
 * Move a WAITING entry to `offered` for one slot. The status filter makes
 * racing offers first-writer-wins: the loser matches zero rows and answers
 * false, so two freed-slot observers can never double-text one entry.
 */
export async function markWaitlistOffered(
  id: string,
  offer: { startIso: string; endIso: string; expiresAtIso: string },
  client?: SupabaseClient
): Promise<boolean> {
  try {
    const db = client ?? (await createSupabaseServiceClient());
    const { data, error } = await db
      .from("booking_waitlist")
      .update({
        status: "offered",
        offered_start_at: offer.startIso,
        offered_end_at: offer.endIso,
        offer_expires_at: offer.expiresAtIso,
        last_offered_start_at: offer.startIso,
        updated_at: new Date().toISOString()
      })
      .eq("id", id)
      .eq("status", "waiting")
      .select("id")
      .maybeSingle();
    if (error || !data) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Put an offered entry back in line. `clearLastOffered` distinguishes the
 * two callers: a FAILED offer SMS clears the slot memory (they never saw
 * it, a retry may offer it again); a LAPSED offer keeps it (the slot must
 * pass to the next candidate, never bounce back).
 */
export async function revertWaitlistOfferToWaiting(
  id: string,
  opts: { clearLastOffered?: boolean } = {},
  client?: SupabaseClient
): Promise<void> {
  try {
    const db = client ?? (await createSupabaseServiceClient());
    await db
      .from("booking_waitlist")
      .update({
        status: "waiting",
        offered_start_at: null,
        offered_end_at: null,
        offer_expires_at: null,
        ...(opts.clearLastOffered ? { last_offered_start_at: null } : {}),
        updated_at: new Date().toISOString()
      })
      .eq("id", id)
      .eq("status", "offered");
  } catch {
    // Best-effort: a stuck offered row is re-examined by the next sweep.
  }
}

/** Terminal transitions (fulfilled / expired / canceled). Best-effort. */
export async function setWaitlistStatus(
  id: string,
  status: Extract<BookingWaitlistStatus, "fulfilled" | "expired" | "canceled">,
  client?: SupabaseClient
): Promise<void> {
  try {
    const db = client ?? (await createSupabaseServiceClient());
    await db
      .from("booking_waitlist")
      .update({ status, updated_at: new Date().toISOString() })
      .eq("id", id)
      .in("status", ["waiting", "offered"]);
  } catch {
    // Best-effort: the sweep re-derives expiry; fulfilled/canceled misses
    // only risk one redundant future offer, which verification then drops.
  }
}

/** Re-point a live entry at the attendee's moved booking. Best-effort. */
export async function updateWaitlistBookingLink(
  id: string,
  link: { currentBookingStartAtIso: string; currentEventId?: string | null },
  client?: SupabaseClient
): Promise<void> {
  try {
    const db = client ?? (await createSupabaseServiceClient());
    await db
      .from("booking_waitlist")
      .update({
        current_booking_start_at: link.currentBookingStartAtIso,
        ...(link.currentEventId !== undefined ? { current_event_id: link.currentEventId } : {}),
        updated_at: new Date().toISOString()
      })
      .eq("id", id)
      .in("status", ["waiting", "offered"]);
  } catch {
    // Best-effort.
  }
}

/** Fleet-wide offered rows whose hold lapsed (sweep input). */
export async function listExpiredWaitlistOffers(
  nowIso: string,
  client?: SupabaseClient
): Promise<BookingWaitlistRow[]> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("booking_waitlist")
    .select(ALL_COLUMNS)
    .eq("status", "offered")
    .lte("offer_expires_at", nowIso)
    .order("offer_expires_at", { ascending: true })
    .limit(WAITLIST_SWEEP_PAGE);
  if (error) throw new Error(`listExpiredWaitlistOffers: ${error.message}`);
  return (data ?? []) as unknown as BookingWaitlistRow[];
}

/**
 * Fleet-wide live rows whose window of interest has passed: their linked
 * booking already started (nothing earlier exists anymore) or their outer
 * bound lapsed (sweep input).
 */
export async function listLapsedWaitlistEntries(
  nowIso: string,
  client?: SupabaseClient
): Promise<BookingWaitlistRow[]> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("booking_waitlist")
    .select(ALL_COLUMNS)
    .in("status", ["waiting", "offered"])
    .or(`current_booking_start_at.lte.${nowIso},latest_at.lte.${nowIso}`)
    .order("created_at", { ascending: true })
    .limit(WAITLIST_SWEEP_PAGE);
  if (error) throw new Error(`listLapsedWaitlistEntries: ${error.message}`);
  return (data ?? []) as unknown as BookingWaitlistRow[];
}
