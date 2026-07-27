/**
 * Tell the assigned teammate a page booking just landed on them.
 *
 * Round robin's whole point is that a booking belongs to a PERSON, and a
 * person who must show up should hear about it where they actually look:
 * their texts. Without this, the assignee learned from the calendar invite
 * (provider mode only) or by checking the dashboard.
 *
 * Best-effort by contract: the booking is already durable and the visitor
 * already has their confirmation, so a failed text here is logged and
 * swallowed, never surfaced to the visitor.
 */

import { getTeamMember } from "@/lib/db/employees";
import { getTelnyxMessagingForBusiness, sendTelnyxSms } from "@/lib/telnyx/messaging";
import { checkSmsOptOut } from "@/lib/sms/opt-outs";
import { logger } from "@/lib/logger";

export type AssigneeBookingNotice = {
  visitorName: string;
  visitorPhone: string;
  /** Human-readable business-local start ("Monday, July 27 at 9:00 AM"). */
  startLocal: string;
  durationMinutes: number;
  /** The event title the calendar carries. */
  summary: string;
};

/** True when the text went out; false on every skip or failure. */
export async function notifyAssigneeOfBooking(
  businessId: string,
  memberId: string,
  notice: AssigneeBookingNotice
): Promise<boolean> {
  try {
    const member = await getTeamMember(businessId, memberId);
    if (!member || !member.phone_e164) return false;

    // A member who texted STOP to the business line is off-limits like
    // anyone else; carriers would drop the send regardless.
    const optOut = await checkSmsOptOut(businessId, member.phone_e164);
    if (!optOut.ok || optOut.optedOut) return false;

    const body =
      `New Coworker: you have a new booking. ${notice.visitorName} ` +
      `(${notice.visitorPhone}), ${notice.startLocal}, ${notice.durationMinutes} min. ` +
      `${notice.summary}`;

    const config = await getTelnyxMessagingForBusiness(businessId, undefined, {
      resolveRcs: true
    });
    await sendTelnyxSms(config, member.phone_e164, body, { meterBusinessId: businessId });
    return true;
  } catch (err) {
    logger.warn("booking-page: assignee notification failed (booking unaffected)", {
      businessId,
      memberId,
      error: err instanceof Error ? err.message : String(err)
    });
    return false;
  }
}
