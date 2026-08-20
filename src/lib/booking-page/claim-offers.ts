/**
 * Broadcast booking claims: the record and the invites.
 *
 * A `broadcast` page books nobody in particular; instead every eligible
 * teammate is texted "Reply 1 to take it" and the first "1" stamps
 * `calendar_booking_dedupe.assignee_member_id`. The bare digit needs
 * something to attach to (the unowned_lead_alerts lesson: a "1" answering
 * an alert with no record resolved against an unrelated older offer), so
 * each broadcast booking parks ONE `booking_claim_offers` row naming the
 * invited phones, and the SMS webhook claims it with a compare-and-swap.
 *
 * Nobody claiming is fine: the booking stays unassigned past `expires_at`
 * and the owner alert already fired at booking time, so there is no
 * fallback ladder here.
 *
 * Everything is best-effort by contract: the booking is already durable and
 * the visitor already has their confirmation, so a failed row write or a
 * dead teammate number is logged and swallowed, never surfaced.
 */

import type { TeamMemberRow } from "@/lib/db/employees";
import { checkSmsOptOut } from "@/lib/sms/opt-outs";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { getTelnyxMessagingForBusiness, sendTelnyxSms } from "@/lib/telnyx/messaging";
import { logger } from "@/lib/logger";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

/** How long a "1" can still take the booking. Mirrors the alerts window. */
export const BOOKING_CLAIM_WINDOW_MS = 24 * 60 * 60 * 1000;

export type BookingClaimNotice = {
  visitorName: string;
  visitorPhone: string | null;
  /** Human-readable business-local start ("Monday, July 27 at 9:00 AM"). */
  startLocal: string;
  summary: string;
};

/**
 * Park the claim row and text the invites. Returns the phones actually
 * texted, so the booking alert's employee leg can skip them (one booking
 * must never text the same teammate twice).
 *
 * The row is written BEFORE the texts: an invite whose row failed would ask
 * for a "1" that can never land anywhere, which is the exact defect the
 * alerts table exists to prevent. If the row cannot be written, no invite
 * goes out and the booking simply stays unassigned.
 */
export async function broadcastBookingClaim(
  businessId: string,
  dedupeClaimId: string,
  invitees: TeamMemberRow[],
  notice: BookingClaimNotice,
  client?: SupabaseClient
): Promise<string[]> {
  try {
    const db = client ?? (await createSupabaseServiceClient());
    const recipients = invitees
      .map((m) => m.phone_e164)
      .filter((p): p is string => Boolean(p));
    /* c8 ignore next 3 -- the guard's implicit else loses its source mapping
       (istanbul records an empty location for it), so a hit can never land;
       both arms ARE exercised: the no-textable test takes the return, and
       every invite test that asserts the insert below takes the else. */
    if (recipients.length === 0) {
      return [];
    }

    const { error } = await db.from("booking_claim_offers").insert({
      business_id: businessId,
      dedupe_claim_id: dedupeClaimId,
      event_summary: notice.summary,
      start_local: notice.startLocal,
      attendee_name: notice.visitorName,
      recipients,
      expires_at: new Date(Date.now() + BOOKING_CLAIM_WINDOW_MS).toISOString()
    });
    if (error) {
      logger.warn("booking-claim: offer row write failed (no invites sent)", {
        businessId,
        error: error.message
      });
      return [];
    }

    const body =
      `New Coworker: new booking, first to reply takes it. ${notice.visitorName}` +
      `${notice.visitorPhone ? ` (${notice.visitorPhone})` : ""}, ${notice.startLocal}. ` +
      `${notice.summary} Reply 1 to take it.`;
    const config = await getTelnyxMessagingForBusiness(businessId, undefined, {
      resolveRcs: true
    });
    const texted: string[] = [];
    for (const member of invitees) {
      const phone = member.phone_e164;
      if (!phone) continue;
      try {
        // A member who texted STOP is off-limits like anyone else.
        const optOut = await checkSmsOptOut(businessId, phone);
        if (!optOut.ok || optOut.optedOut) continue;
        await sendTelnyxSms(config, phone, body, { meterBusinessId: businessId });
        texted.push(phone);
      } catch (err) {
        logger.warn("booking-claim: invite text failed (booking unaffected)", {
          businessId,
          memberId: member.id,
          error: err instanceof Error ? err.message : String(err)
        });
      }
    }
    return texted;
  } catch (err) {
    logger.warn("booking-claim: broadcast failed (booking unaffected)", {
      businessId,
      error: err instanceof Error ? err.message : String(err)
    });
    return [];
  }
}

/**
 * The phones already invited to claim THIS booking, for the resubmit path:
 * a retry cannot know whether the first attempt's invites went out before
 * it died, and the claim rows are the durable record of exactly who was
 * texted. [] on anything unreadable, which degrades to the pre-broadcast
 * alert behavior rather than suppressing it.
 */
export async function findInvitedPhonesForBooking(
  businessId: string,
  attendeeKey: string,
  startIso: string,
  client?: SupabaseClient
): Promise<string[]> {
  try {
    const db = client ?? (await createSupabaseServiceClient());
    const dedupeId = await findDedupeRowId(businessId, attendeeKey, startIso, db);
    if (!dedupeId) return [];
    const { data, error } = await db
      .from("booking_claim_offers")
      .select("recipients")
      .eq("business_id", businessId)
      .eq("dedupe_claim_id", dedupeId);
    if (error) {
      logger.warn("booking-claim: invited-phones lookup failed", {
        businessId,
        error: error.message
      });
      return [];
    }
    const phones = new Set<string>();
    for (const row of (data ?? []) as Array<{ recipients: string[] | null }>) {
      for (const r of row.recipients ?? []) {
        if (r) phones.add(r);
      }
    }
    return [...phones];
  } catch (err) {
    logger.warn("booking-claim: invited-phones lookup threw", {
      businessId,
      error: err instanceof Error ? err.message : String(err)
    });
    return [];
  }
}

/**
 * The dedupe-ledger row a claim assigns, located the way the stamp
 * functions match it (business, attendee key, start).
 */
export async function findDedupeRowId(
  businessId: string,
  attendeeKey: string,
  startIso: string,
  client?: SupabaseClient
): Promise<string | null> {
  try {
    const db = client ?? (await createSupabaseServiceClient());
    const { data, error } = await db
      .from("calendar_booking_dedupe")
      .select("id")
      .eq("business_id", businessId)
      .eq("attendee_key", attendeeKey)
      .eq("start_at", startIso)
      .maybeSingle();
    if (error) {
      logger.warn("booking-claim: dedupe row lookup failed", {
        businessId,
        error: error.message
      });
      return null;
    }
    return (data as { id?: string } | null)?.id ?? null;
  } catch (err) {
    logger.warn("booking-claim: dedupe row lookup threw", {
      businessId,
      error: err instanceof Error ? err.message : String(err)
    });
    return null;
  }
}
