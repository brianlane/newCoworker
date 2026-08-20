/**
 * The AI door of "Who bookings go to".
 *
 * Until the broadcast change, only the public booking page consulted
 * `booking_pages.assignment_mode`; every appointment the AI coworker booked
 * in conversation (voice, SMS, web chat) landed assigned to nobody
 * regardless of the setting. This module runs the SAME resolution for
 * those bookings, right after the booking is durable:
 *
 * - `any`: unchanged, no assignee.
 * - `round_robin` / `fixed`: pick via the shared fairness rule and stamp
 *   the dedupe row (compare-and-swap on null, so a duplicate turn can
 *   never reassign), then the usual assignee text.
 * - `broadcast`: park a claim row and text the invites; first "1" wins.
 *   A one-person owner-only roster collapses to a direct owner stamp with
 *   no text (the owner alert already reaches them).
 *
 * Best-effort by contract, like everything after the booking write: the
 * appointment is already durable and the caller's tool result must not
 * change because assignment bookkeeping hiccupped. Every failure logs and
 * returns unassigned, which is exactly yesterday's behavior.
 *
 * AI bookings carry no meeting type, so the page-level settings apply (the
 * per-meeting overrides belong to the page's own meeting picker).
 */

import {
  chooseAssignee,
  parseAssignmentMode,
  resolveBroadcastAssignment
} from "@/lib/booking-page/assignment";
import { notifyAssigneeOfBooking } from "@/lib/booking-page/assignee-notify";
import { broadcastBookingClaim } from "@/lib/booking-page/claim-offers";
import {
  countUpcomingByAssignee,
  getBookingPageForBusiness,
  stampAssigneeByClaimId
} from "@/lib/booking-page/db";
import { businessOwnerNumbers } from "@/lib/db/contact-names";
import { listTeamMembers, listTimeOff, markMemberOffered } from "@/lib/db/employees";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { logger } from "@/lib/logger";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export type AiBookingAssignmentInput = {
  /** The dedupe-ledger row this booking claimed; null skips assignment. */
  dedupeClaimId: string | null;
  attendeeName: string;
  attendeePhone: string | null;
  startIso: string;
  /** Human-readable business-local start, already computed by the caller. */
  startLocal: string;
  summary: string;
  durationMinutes: number;
};

export type AiBookingAssignmentResult = {
  assigneeMemberId: string | null;
  /** Broadcast invites actually texted, for the owner alert's dedupe. */
  invitedPhones: string[];
};

const UNASSIGNED: AiBookingAssignmentResult = { assigneeMemberId: null, invitedPhones: [] };

export async function applyAiBookingAssignment(
  businessId: string,
  input: AiBookingAssignmentInput,
  client?: SupabaseClient
): Promise<AiBookingAssignmentResult> {
  try {
    if (!input.dedupeClaimId) return UNASSIGNED;
    const db = client ?? (await createSupabaseServiceClient());
    const page = await getBookingPageForBusiness(businessId, db);
    if (!page) return UNASSIGNED;
    const mode = parseAssignmentMode(page.assignment_mode);
    if (mode === "any") return UNASSIGNED;

    if (mode === "broadcast") {
      const [roster, ownerNumbers] = await Promise.all([
        listTeamMembers(businessId, db),
        businessOwnerNumbers(businessId, db)
      ]);
      const verdict = resolveBroadcastAssignment(roster, ownerNumbers, input.attendeePhone);
      if (verdict.kind === "solo_owner") {
        // Direct owner stamp, no text: the assignee IS the owner and the
        // owner alert already reaches them.
        await stampAssigneeByClaimId(input.dedupeClaimId, verdict.memberId, db);
        return { assigneeMemberId: verdict.memberId, invitedPhones: [] };
      }
      if (verdict.kind === "invite") {
        const invitedPhones = await broadcastBookingClaim(
          businessId,
          input.dedupeClaimId,
          verdict.invitees,
          {
            visitorName: input.attendeeName,
            visitorPhone: input.attendeePhone,
            startLocal: input.startLocal,
            summary: input.summary
          },
          db
        );
        return { assigneeMemberId: null, invitedPhones };
      }
      return UNASSIGNED;
    }

    // round_robin / fixed: the page door's fairness rule, verbatim inputs.
    const [roster, timeOff, upcomingCounts, timezone] = await Promise.all([
      listTeamMembers(businessId, db),
      listTimeOff(businessId, db),
      countUpcomingByAssignee(businessId, db),
      businessTimezone(businessId, db)
    ]);
    const choice = chooseAssignee({
      mode,
      employeeId: page.employee_id ?? null,
      roster,
      timeOff,
      startIso: input.startIso,
      timezone,
      upcomingCounts
    });
    if (!choice.memberId) {
      logger.warn("ai-booking: booking left unassigned", { businessId, reason: choice.reason });
      return UNASSIGNED;
    }
    const stamped = await stampAssigneeByClaimId(input.dedupeClaimId, choice.memberId, db);
    if (!stamped) return UNASSIGNED;
    // Same follow-through as the page door: advance the fairness tiebreak,
    // then tell the person who must show up, where they look.
    await markMemberOffered(choice.memberId, db).catch(() => {});
    if (page.notify_assignee) {
      await notifyAssigneeOfBooking(businessId, choice.memberId, {
        visitorName: input.attendeeName,
        visitorPhone: input.attendeePhone ?? "",
        startLocal: input.startLocal,
        durationMinutes: input.durationMinutes,
        summary: input.summary
      });
    }
    return { assigneeMemberId: choice.memberId, invitedPhones: [] };
  } catch (err) {
    logger.warn("ai-booking: assignment failed (booking unaffected)", {
      businessId,
      error: err instanceof Error ? err.message : String(err)
    });
    return UNASSIGNED;
  }
}

/** The business's IANA timezone, UTC when unset or unreadable. */
async function businessTimezone(businessId: string, db: SupabaseClient): Promise<string> {
  try {
    const { data } = await db
      .from("businesses")
      .select("timezone")
      .eq("id", businessId)
      .maybeSingle();
    const zone = ((data as { timezone?: string | null } | null)?.timezone ?? "").trim();
    return zone || "UTC";
  } catch {
    return "UTC";
  }
}
