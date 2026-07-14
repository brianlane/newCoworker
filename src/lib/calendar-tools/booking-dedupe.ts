import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { digitsOf, phoneDigitsMatch } from "@/lib/calendar-tools/phone-match";
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

export type UpcomingBookingClaim = {
  id: string;
  eventId: string;
  startAt: string;
  /**
   * The row's stored attendee key — set by the phone-tolerant lookup, where
   * it can differ from the caller's key (different phone formatting at
   * booking time). Ledger mutations should prefer it when present.
   */
  attendeeKey?: string;
};

/**
 * The attendee's next CONFIRMED upcoming booking (soonest first), from the
 * ledger. This is how reschedule/cancel find the provider event without a
 * provider-side search. Null on no row or any read error (callers fall back
 * to a provider search).
 */
export async function findUpcomingBookingClaim(
  businessId: string,
  attendeeKey: string
): Promise<UpcomingBookingClaim | null> {
  try {
    const supabase = await createSupabaseServiceClient();
    const { data, error } = await supabase
      .from("calendar_booking_dedupe")
      .select("id, event_id, start_at")
      .eq("business_id", businessId)
      .eq("attendee_key", attendeeKey)
      .not("event_id", "is", null)
      .gte("start_at", new Date().toISOString())
      .order("start_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (error || !data) return null;
    const row = data as { id: string; event_id: string; start_at: string };
    return { id: row.id, eventId: row.event_id, startAt: row.start_at };
  } catch (err) {
    logger.warn("booking-dedupe: upcoming lookup threw", {
      businessId,
      error: err instanceof Error ? err.message : String(err)
    });
    return null;
  }
}

/** Upcoming phone-keyed rows scanned by the tolerant lookup. */
const PHONE_LOOKUP_SCAN = 50;

/**
 * Phone-tolerant fallback for findUpcomingBookingClaim: the exact-key lookup
 * misses when the booking stored one phone shape (E.164 from the SMS
 * surface) and the lifecycle call passes another (national/pretty-printed
 * from the model). Scans the business's upcoming phone-keyed rows and
 * matches on digits with country-code tolerance (Bugbot on PR #584). The
 * returned claim carries the ROW's attendee key so ledger mutations target
 * the right row. Null on no match or any read error.
 */
export async function findUpcomingBookingClaimByPhone(
  businessId: string,
  phone: string
): Promise<UpcomingBookingClaim | null> {
  const callerDigits = digitsOf(phone);
  if (!callerDigits) return null;
  try {
    const supabase = await createSupabaseServiceClient();
    const { data, error } = await supabase
      .from("calendar_booking_dedupe")
      .select("id, event_id, start_at, attendee_key")
      .eq("business_id", businessId)
      .like("attendee_key", "phone:%")
      .not("event_id", "is", null)
      .gte("start_at", new Date().toISOString())
      .order("start_at", { ascending: true })
      .limit(PHONE_LOOKUP_SCAN);
    if (error || !data) return null;
    for (const raw of data as Array<{
      id: string;
      event_id: string;
      start_at: string;
      attendee_key: string;
    }>) {
      const rowDigits = digitsOf(raw.attendee_key.slice("phone:".length));
      if (rowDigits.length > 0 && phoneDigitsMatch(rowDigits, callerDigits)) {
        return {
          id: raw.id,
          eventId: raw.event_id,
          startAt: raw.start_at,
          attendeeKey: raw.attendee_key
        };
      }
    }
    return null;
  } catch (err) {
    logger.warn("booking-dedupe: phone-tolerant lookup threw", {
      businessId,
      error: err instanceof Error ? err.message : String(err)
    });
    return null;
  }
}

/**
 * Move a confirmed claim to its rescheduled start so the slot ledger keeps
 * matching the provider event.
 *
 * A unique-index conflict means a DIFFERENT claim already covers the new
 * slot (e.g. the model booked a second event there before rescheduling this
 * one). The provider event behind THIS claim has already moved — its
 * updated invitation is what the attendee just received — so this claim
 * must stay tracked: the conflicting row loses (deleted) and the move is
 * retried once. The displaced event, if real, resolves later through the
 * provider-search fallback (Bugbot on PR #577). Best-effort throughout.
 */
export async function rescheduleBookingClaim(
  businessId: string,
  attendeeKey: string,
  claimId: string,
  newStartIso: string
): Promise<void> {
  try {
    const supabase = await createSupabaseServiceClient();
    const move = () =>
      supabase
        .from("calendar_booking_dedupe")
        .update({ start_at: newStartIso, created_at: new Date().toISOString() })
        .eq("id", claimId);
    const { error } = await move();
    if (!error) return;
    if ((error as { code?: string }).code === "23505") {
      const { error: delErr } = await supabase
        .from("calendar_booking_dedupe")
        .delete()
        .eq("business_id", businessId)
        .eq("attendee_key", attendeeKey)
        .eq("start_at", newStartIso)
        .neq("id", claimId);
      if (delErr) {
        logger.warn("booking-dedupe: reschedule conflict cleanup failed", {
          claimId,
          error: delErr.message
        });
        return;
      }
      const { error: retryErr } = await move();
      if (retryErr) {
        logger.warn("booking-dedupe: reschedule retry failed", {
          claimId,
          error: retryErr.message
        });
      }
      return;
    }
    logger.warn("booking-dedupe: reschedule update failed", { claimId, error: error.message });
  } catch (err) {
    logger.warn("booking-dedupe: reschedule threw", {
      claimId,
      error: err instanceof Error ? err.message : String(err)
    });
  }
}

/** Drop a claim after its provider event was canceled. Best-effort. */
export async function deleteBookingClaim(claimId: string): Promise<void> {
  try {
    const supabase = await createSupabaseServiceClient();
    const { error } = await supabase
      .from("calendar_booking_dedupe")
      .delete()
      .eq("id", claimId);
    if (error) {
      logger.warn("booking-dedupe: claim delete failed", { claimId, error: error.message });
    }
  } catch (err) {
    logger.warn("booking-dedupe: claim delete threw", {
      claimId,
      error: err instanceof Error ? err.message : String(err)
    });
  }
}

/**
 * Drop EVERY claim recorded for a provider event, regardless of attendee
 * key. Used when an event was located via provider search (no ledger hit
 * for the caller's key): the booking may still have a ledger row under a
 * DIFFERENT key (booked by phone, canceled by email), and leaving it would
 * make later duplicate checks treat a canceled/moved slot as still booked
 * (Bugbot High on PR #577). Best-effort.
 */
export async function deleteBookingClaimsByEvent(
  businessId: string,
  eventId: string
): Promise<void> {
  try {
    const supabase = await createSupabaseServiceClient();
    const { error } = await supabase
      .from("calendar_booking_dedupe")
      .delete()
      .eq("business_id", businessId)
      .eq("event_id", eventId);
    if (error) {
      logger.warn("booking-dedupe: by-event delete failed", {
        businessId,
        error: error.message
      });
    }
  } catch (err) {
    logger.warn("booking-dedupe: by-event delete threw", {
      businessId,
      error: err instanceof Error ? err.message : String(err)
    });
  }
}

/**
 * Record a confirmed booking discovered OUTSIDE the ledger (a reschedule of
 * an event booked before the ledger shipped) so future duplicate checks and
 * reschedules resolve without a provider search. Conflicts are ignored — an
 * existing claim for the slot already serves that purpose.
 */
export async function recordExternalBookingClaim(
  businessId: string,
  attendeeKey: string,
  startAtIso: string,
  eventId: string
): Promise<void> {
  try {
    const supabase = await createSupabaseServiceClient();
    const { error } = await supabase.from("calendar_booking_dedupe").insert({
      business_id: businessId,
      attendee_key: attendeeKey,
      start_at: startAtIso,
      event_id: eventId
    });
    if (error && (error as { code?: string }).code !== "23505") {
      logger.warn("booking-dedupe: external claim record failed", {
        businessId,
        error: error.message
      });
    }
  } catch (err) {
    logger.warn("booking-dedupe: external claim record threw", {
      businessId,
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
