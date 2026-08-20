/**
 * Claimable broadcast-booking offers.
 *
 * A `broadcast` booking page texts every eligible teammate "Reply 1 to take
 * it". The bare digit needs a record to attach to (the unowned_lead_alerts
 * lesson: a "1" with no record resolved against an unrelated older offer),
 * so the Node booking door writes one `booking_claim_offers` row per
 * broadcast booking, and this module is how the Deno SMS-inbound function
 * reads and claims it.
 *
 * Winning the claim does TWO writes: the offer row's compare-and-swap
 * settles the race, then the booking's own `assignee_member_id` is stamped
 * (also guarded on null, so a manual assignment made in the meantime is
 * never overwritten; the race outcome stands either way).
 *
 * Mirror of _shared/unowned_lead_alerts.ts in shape and posture; keep the
 * two aligned when either changes.
 */

// Minimal structural client (the _shared convention).
// deno-lint-ignore no-explicit-any
type AnyClient = any;

export type BookingClaimRow = {
  id: string;
  dedupe_claim_id: string;
  event_summary: string | null;
  start_local: string | null;
  attendee_name: string | null;
  recipients: string[] | null;
  claimed_at: string | null;
  expires_at: string;
};

/** A live booking offer this sender could have meant. */
export type BookingClaimCandidate = {
  offerId: string;
  dedupeClaimId: string;
  summary: string | null;
  startLocal: string | null;
  attendeeName: string | null;
};

/** Bounded like the other candidate lists: the ask-back must stay one SMS. */
export const MAX_BOOKING_CLAIM_CANDIDATES = 10;

/** Every live booking offer this sender could be answering, newest first. */
export async function findLiveBookingClaimsFor(
  supabase: AnyClient,
  businessId: string,
  from: string,
  nowIso: string
): Promise<BookingClaimCandidate[]> {
  try {
    const { data, error } = await supabase
      .from("booking_claim_offers")
      .select("id, dedupe_claim_id, event_summary, start_local, attendee_name, recipients, claimed_at, expires_at")
      .eq("business_id", businessId)
      .is("claimed_at", null)
      .gt("expires_at", nowIso)
      .contains("recipients", [from])
      .order("created_at", { ascending: false })
      .limit(MAX_BOOKING_CLAIM_CANDIDATES);
    if (error) {
      console.error("findLiveBookingClaimsFor", error);
      return [];
    }
    return ((data ?? []) as BookingClaimRow[]).map((r) => ({
      offerId: r.id,
      dedupeClaimId: r.dedupe_claim_id,
      summary: (r.event_summary ?? "").trim() || null,
      startLocal: (r.start_local ?? "").trim() || null,
      attendeeName: (r.attendee_name ?? "").trim() || null
    }));
  } catch (e) {
    console.error("findLiveBookingClaimsFor threw", e);
    return [];
  }
}

/** What a booking-claim attempt produced. */
export type BookingClaimOutcome =
  | {
      ok: true;
      summary: string | null;
      startLocal: string | null;
      attendeeName: string | null;
      /** Everyone invited, so the winner's ack can stand the others down. */
      recipients: string[];
    }
  /** Somebody else got there first; `by` is their number when known. */
  | { ok: false; reason: "already_claimed"; by: string | null }
  | { ok: false; reason: "gone" };

/**
 * Claim a broadcast booking for this teammate. The offer row's
 * compare-and-swap on `claimed_at is null` is the race arbiter; PostgREST
 * reports the loser's update as matching zero rows, which is why the result
 * is read back with `.select()` rather than trusting the absence of an
 * error (the repo's zero-rows lesson).
 */
export async function claimBookingOffer(
  supabase: AnyClient,
  args: {
    businessId: string;
    offerId: string;
    memberId: string | null;
    claimedByE164: string;
    nowIso: string;
  }
): Promise<BookingClaimOutcome> {
  const { data, error } = await supabase
    .from("booking_claim_offers")
    .update({
      claimed_at: args.nowIso,
      claimed_by_e164: args.claimedByE164,
      claimed_by_member_id: args.memberId
    })
    .eq("id", args.offerId)
    .eq("business_id", args.businessId)
    .is("claimed_at", null)
    .select("dedupe_claim_id, event_summary, start_local, attendee_name, recipients");
  if (error) {
    console.error("claimBookingOffer", error);
    return { ok: false, reason: "gone" };
  }
  const rows = (data ?? []) as Array<{
    dedupe_claim_id: string;
    event_summary: string | null;
    start_local: string | null;
    attendee_name: string | null;
    recipients: string[] | null;
  }>;
  if (rows.length === 1) {
    // The booking itself: stamped only while still unheld, so a manual
    // assignment made between invite and claim is never overwritten.
    if (args.memberId) {
      try {
        const { error: stampErr } = await supabase
          .from("calendar_booking_dedupe")
          .update({ assignee_member_id: args.memberId })
          .eq("id", rows[0].dedupe_claim_id)
          .is("assignee_member_id", null);
        if (stampErr) console.error("claimBookingOffer stamp", stampErr);
      } catch (e) {
        console.error("claimBookingOffer stamp threw", e);
      }
    }
    return {
      ok: true,
      summary: (rows[0].event_summary ?? "").trim() || null,
      startLocal: (rows[0].start_local ?? "").trim() || null,
      attendeeName: (rows[0].attendee_name ?? "").trim() || null,
      recipients: (rows[0].recipients ?? []).filter((r): r is string => Boolean(r))
    };
  }
  // Zero rows: raced or expired. Re-read to tell the teammate which.
  const { data: after } = await supabase
    .from("booking_claim_offers")
    .select("claimed_by_e164, claimed_at")
    .eq("id", args.offerId)
    .eq("business_id", args.businessId)
    .maybeSingle();
  const row = (after as { claimed_by_e164?: string | null; claimed_at?: string | null } | null) ?? null;
  if (row?.claimed_at) {
    return { ok: false, reason: "already_claimed", by: row.claimed_by_e164 ?? null };
  }
  return { ok: false, reason: "gone" };
}
