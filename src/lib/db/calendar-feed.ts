/**
 * Subscribable calendar-feed tokens (`calendar_feed_tokens`) and the ledger
 * read the feed renders.
 *
 * The token is a plaintext capability with the same posture as the booking
 * page's `ncb_` token: it ships inside a URL the owner pastes into Google
 * Calendar / Outlook / Apple Calendar, so it is public by design. It grants
 * nothing beyond reading coarse upcoming booking rows for one business, and
 * rotating it revokes every previously shared copy at once.
 */
import { randomBytes } from "crypto";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export const CALENDAR_FEED_TOKEN_PREFIX = "ncbf_";

export const CALENDAR_FEED_TOKEN_REGEX = /^ncbf_[0-9a-f]{64}$/;

export function mintCalendarFeedToken(): string {
  return `${CALENDAR_FEED_TOKEN_PREFIX}${randomBytes(32).toString("hex")}`;
}

/**
 * A syntactically valid feed token from a request value, else null so
 * callers fail closed without a DB round-trip on garbage. Tolerates a
 * trailing `.ics`, because that is how the URL is handed out (some calendar
 * apps only accept subscription URLs ending in .ics).
 */
export function parseCalendarFeedToken(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().replace(/\.ics$/, "");
  return CALENDAR_FEED_TOKEN_REGEX.test(trimmed) ? trimmed : null;
}

/**
 * The business's feed token, minting one on first ask. The mint races
 * benignly: the PK makes the second insert fail, and the loser re-reads the
 * winner's token, so both callers hand out the same URL.
 */
export async function ensureCalendarFeedToken(
  businessId: string,
  client?: SupabaseClient
): Promise<string> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("calendar_feed_tokens")
    .select("token")
    .eq("business_id", businessId)
    .maybeSingle();
  if (error) throw new Error(`ensureCalendarFeedToken: ${error.message}`);
  if (data?.token) return (data as { token: string }).token;

  const token = mintCalendarFeedToken();
  const { error: insertError } = await db
    .from("calendar_feed_tokens")
    .insert({ business_id: businessId, token });
  if (!insertError) return token;

  // Lost the race (or a transient failure that left a row): the re-read is
  // the truth either way.
  const { data: winner, error: rereadError } = await db
    .from("calendar_feed_tokens")
    .select("token")
    .eq("business_id", businessId)
    .maybeSingle();
  if (rereadError || !winner?.token) {
    throw new Error(`ensureCalendarFeedToken: ${insertError.message}`);
  }
  return (winner as { token: string }).token;
}

/** Replace the token, revoking every previously shared feed URL at once. */
export async function rotateCalendarFeedToken(
  businessId: string,
  client?: SupabaseClient
): Promise<string> {
  const db = client ?? (await createSupabaseServiceClient());
  // Ensure the row exists first so a rotate-before-first-view still works.
  await ensureCalendarFeedToken(businessId, db);
  const token = mintCalendarFeedToken();
  const { error } = await db
    .from("calendar_feed_tokens")
    .update({ token, updated_at: new Date().toISOString() })
    .eq("business_id", businessId);
  if (error) throw new Error(`rotateCalendarFeedToken: ${error.message}`);
  return token;
}

/** The business a presented token belongs to, or null. */
export async function findBusinessByCalendarFeedToken(
  token: string,
  client?: SupabaseClient
): Promise<string | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("calendar_feed_tokens")
    .select("business_id")
    .eq("token", token)
    .maybeSingle();
  if (error) throw new Error(`findBusinessByCalendarFeedToken: ${error.message}`);
  return (data as { business_id: string } | null)?.business_id ?? null;
}

export type FeedBookingRow = {
  id: string;
  start_at: string;
  duration_minutes: number | null;
  attendee_name: string | null;
  booking_source: string | null;
};

/** How far ahead the feed reaches, and its row ceiling. */
export const CALENDAR_FEED_HORIZON_DAYS = 90;
export const CALENDAR_FEED_MAX_EVENTS = 500;

/**
 * Upcoming confirmed ledger rows for the feed. The ledger is the one store
 * that sees every provider's bookings (platform, Google/Microsoft, CalDAV,
 * Vagaro, Acuity via webhook/poll sync), which is exactly why the feed
 * renders it rather than any single provider's calendar.
 */
export async function listFeedBookings(
  businessId: string,
  nowMs: number,
  client?: SupabaseClient
): Promise<FeedBookingRow[]> {
  const db = client ?? (await createSupabaseServiceClient());
  const horizon = new Date(nowMs + CALENDAR_FEED_HORIZON_DAYS * 86_400_000).toISOString();
  const { data, error } = await db
    .from("calendar_booking_dedupe")
    .select("id,start_at,duration_minutes,attendee_name,booking_source")
    .eq("business_id", businessId)
    // Confirmed bookings only: an in-flight claim has no event_id yet and is
    // reclaimable after its TTL, so rendering it would show subscribers an
    // appointment that may never come to exist.
    .not("event_id", "is", null)
    .gte("start_at", new Date(nowMs).toISOString())
    .lte("start_at", horizon)
    .order("start_at", { ascending: true })
    .limit(CALENDAR_FEED_MAX_EVENTS);
  if (error) throw new Error(`listFeedBookings: ${error.message}`);
  return (data ?? []) as FeedBookingRow[];
}
