import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { logger } from "@/lib/logger";

/**
 * Idempotency ledger for calendar_book_appointment (table
 * `calendar_booking_dedupe`, service-role-only).
 *
 * Why: the SMS worker retries a whole Rowboat turn when the model call fails
 * AFTER tool calls already ran (2026-07-13: Gemini 503s after a successful
 * booking tool call re-booked the same appointment on every retry — four
 * identical Outlook events). The provider APIs have no create-idempotency,
 * so the shared booking core claims a (business, attendee, start time) row
 * here before creating, and a repeat attempt inside the dedupe window gets
 * the already-created event back instead of a new one.
 *
 * Fail-open by design: any ledger error returns null and the booking
 * proceeds un-deduped — a missed dedupe is a nuisance, a blocked booking is
 * a lost customer.
 */

/** A confirmed booking blocks re-booking the same slot for this long. */
export const BOOKING_DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * An unconfirmed claim (event_id still null) blocks a rival claim for this
 * long. Covers the tiny crash window between the provider create and the
 * confirm write; after it, the claim is presumed dead and is reclaimed.
 */
export const BOOKING_IN_FLIGHT_TTL_MS = 10 * 60 * 1000;

export type BookingDedupeClaim =
  | { kind: "claimed"; id: string }
  | { kind: "duplicate"; eventId: string }
  | { kind: "in_flight" };

/**
 * Attendee identity for the dedupe key: phone (already E.164 on every
 * surface) wins, then email, then name. Falls back to a constant so a
 * fully-anonymous booking still dedupes against itself per slot.
 */
export function bookingAttendeeKey(
  phone: string | null | undefined,
  email: string | null | undefined,
  name: string | null | undefined
): string {
  const p = phone?.trim();
  if (p) return `phone:${p}`;
  const e = email?.trim().toLowerCase();
  if (e) return `email:${e}`;
  const n = name?.trim().toLowerCase();
  if (n) return `name:${n}`;
  return "anonymous";
}

type LedgerRow = { id: string; event_id: string | null; created_at: string };

/**
 * Claim the (business, attendee, start) slot. Outcomes:
 *  - `claimed`   → proceed to book; then confirm (success) or release (failure).
 *  - `duplicate` → a booking for this exact slot was already confirmed inside
 *                  the window; return its eventId to the model instead of
 *                  creating another provider event.
 *  - `in_flight` → another attempt claimed the slot moments ago and hasn't
 *                  confirmed yet; do not book (it will, or its claim expires).
 *  - `null`      → ledger unavailable; book without dedupe (fail-open).
 */
export async function claimBookingDedupe(
  businessId: string,
  attendeeKey: string,
  startAtIso: string
): Promise<BookingDedupeClaim | null> {
  try {
    const supabase = await createSupabaseServiceClient();
    const { data: inserted, error: insertErr } = await supabase
      .from("calendar_booking_dedupe")
      .insert({ business_id: businessId, attendee_key: attendeeKey, start_at: startAtIso })
      .select("id")
      .maybeSingle();

    if (!insertErr) {
      const id = (inserted as { id?: string } | null)?.id;
      /* c8 ignore next -- a successful insert always returns the row */
      if (!id) return null;
      return { kind: "claimed", id };
    }

    if ((insertErr as { code?: string }).code !== "23505") {
      logger.warn("booking-dedupe: claim insert failed (fail-open)", {
        businessId,
        error: insertErr.message
      });
      return null;
    }

    // Unique-violation: someone already holds this slot. Read the row to
    // decide duplicate vs in-flight vs expired-and-reclaimable.
    const { data: existingRaw, error: readErr } = await supabase
      .from("calendar_booking_dedupe")
      .select("id, event_id, created_at")
      .eq("business_id", businessId)
      .eq("attendee_key", attendeeKey)
      .eq("start_at", startAtIso)
      .maybeSingle();
    if (readErr || !existingRaw) {
      logger.warn("booking-dedupe: conflict row read failed (fail-open)", {
        businessId,
        error: readErr?.message ?? "row_missing"
      });
      return null;
    }
    const existing = existingRaw as LedgerRow;
    const ageMs = Date.now() - new Date(existing.created_at).getTime();

    if (existing.event_id && ageMs < BOOKING_DEDUPE_WINDOW_MS) {
      return { kind: "duplicate", eventId: existing.event_id };
    }
    if (!existing.event_id && ageMs < BOOKING_IN_FLIGHT_TTL_MS) {
      return { kind: "in_flight" };
    }

    // Expired row (old confirmed booking, or a claimant that died without
    // confirming): reclaim it in place.
    const { error: reclaimErr } = await supabase
      .from("calendar_booking_dedupe")
      .update({ event_id: null, created_at: new Date().toISOString() })
      .eq("id", existing.id);
    if (reclaimErr) {
      logger.warn("booking-dedupe: reclaim failed (fail-open)", {
        businessId,
        error: reclaimErr.message
      });
      return null;
    }
    return { kind: "claimed", id: existing.id };
  } catch (err) {
    logger.warn("booking-dedupe: claim threw (fail-open)", {
      businessId,
      error: err instanceof Error ? err.message : String(err)
    });
    return null;
  }
}

/** Stamp the provider event id on a confirmed booking. Best-effort. */
export async function confirmBookingDedupe(claimId: string, eventId: string): Promise<void> {
  try {
    const supabase = await createSupabaseServiceClient();
    const { error } = await supabase
      .from("calendar_booking_dedupe")
      .update({ event_id: eventId })
      .eq("id", claimId);
    if (error) {
      logger.warn("booking-dedupe: confirm failed", { claimId, error: error.message });
    }
  } catch (err) {
    logger.warn("booking-dedupe: confirm threw", {
      claimId,
      error: err instanceof Error ? err.message : String(err)
    });
  }
}

/**
 * Release a claim whose booking did NOT produce a confirmed event, so the
 * next attempt can book cleanly. Best-effort: an unreleased claim only
 * blocks its slot for BOOKING_IN_FLIGHT_TTL_MS.
 */
export async function releaseBookingDedupe(claimId: string): Promise<void> {
  try {
    const supabase = await createSupabaseServiceClient();
    const { error } = await supabase
      .from("calendar_booking_dedupe")
      .delete()
      .eq("id", claimId)
      .is("event_id", null);
    if (error) {
      logger.warn("booking-dedupe: release failed", { claimId, error: error.message });
    }
  } catch (err) {
    logger.warn("booking-dedupe: release threw", {
      claimId,
      error: err instanceof Error ? err.message : String(err)
    });
  }
}
