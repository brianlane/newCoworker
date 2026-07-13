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
    // confirming): reclaim it in place. Compare-and-swap on created_at so two
    // concurrent claimants can't both win — the reclaim always bumps
    // created_at, so a rival's reclaim invalidates our snapshot and this
    // update matches zero rows (Bugbot Medium on PR #566).
    const { data: reclaimed, error: reclaimErr } = await supabase
      .from("calendar_booking_dedupe")
      .update({ event_id: null, created_at: new Date().toISOString() })
      .eq("id", existing.id)
      .eq("created_at", existing.created_at)
      .select("id")
      .maybeSingle();
    if (reclaimErr) {
      logger.warn("booking-dedupe: reclaim failed (fail-open)", {
        businessId,
        error: reclaimErr.message
      });
      return null;
    }
    if (!reclaimed) {
      // Lost the CAS: a rival claimant reclaimed (and is booking) this slot
      // between our read and our update. Refuse instead of failing open —
      // failing open here would book in parallel with the winner, which is
      // exactly the duplicate this ledger exists to prevent.
      return { kind: "in_flight" };
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

/** Confirm write attempts before giving up (see confirmBookingDedupe). */
export const CONFIRM_MAX_ATTEMPTS = 3;
const CONFIRM_RETRY_DELAY_MS = 250;

/**
 * Stamp the provider event id on a confirmed booking.
 *
 * Retried, because this write is what stops a FUTURE attempt from re-booking
 * an event that already exists: an unconfirmed row is reclaimable after
 * BOOKING_IN_FLIGHT_TTL_MS, so a lost confirm re-opens the duplicate window
 * (Bugbot High on PR #566). After the retries the failure is logged at error
 * level — the residual exposure is a sustained DB outage bracketed by two
 * working moments, at which point duplicate suppression is best-effort by
 * the module's fail-open contract.
 */
export async function confirmBookingDedupe(claimId: string, eventId: string): Promise<void> {
  for (let attempt = 1; attempt <= CONFIRM_MAX_ATTEMPTS; attempt += 1) {
    try {
      const supabase = await createSupabaseServiceClient();
      const { error } = await supabase
        .from("calendar_booking_dedupe")
        .update({ event_id: eventId })
        .eq("id", claimId);
      if (!error) return;
      logger.warn("booking-dedupe: confirm attempt failed", {
        claimId,
        attempt,
        error: error.message
      });
    } catch (err) {
      logger.warn("booking-dedupe: confirm attempt threw", {
        claimId,
        attempt,
        error: err instanceof Error ? err.message : String(err)
      });
    }
    if (attempt < CONFIRM_MAX_ATTEMPTS) {
      await new Promise((r) => setTimeout(r, CONFIRM_RETRY_DELAY_MS));
    }
  }
  logger.error("booking-dedupe: confirm exhausted retries — slot re-opens after in-flight TTL", {
    claimId,
    eventId
  });
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
