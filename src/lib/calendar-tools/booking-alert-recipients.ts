/**
 * Who hears about a confirmed booking, beyond the business owner.
 *
 * `maybeAlertUnassignedBooking` has always addressed the owner and only the
 * owner (see the note on its dispatch call: "this alert is addressed to the
 * business owner on every branch"). Amy Laidlaw Real Estate asked for the
 * booking alert to reach her agents too, so the audience is now a preference
 * with two independent parts:
 *
 *   booking_alert_audience    "owner" | "employees" | "both"
 *   booking_alert_member_ids  null = every active member, else just these
 *
 * Kept as pure functions on purpose: picking recipients is the part with real
 * branching (audience x id list x roster state), and the alert itself is
 * best-effort-by-contract, so the decision needs to be testable without a
 * Supabase client or a Telnyx key anywhere near it.
 */

/** The audience settings as stored on notification_preferences. */
export type BookingAlertAudience = "owner" | "employees" | "both";

/** The roster fields this module needs. A subset of TeamMemberRow. */
export type BookingAlertMember = {
  id: string;
  name: string;
  phone_e164: string;
  active: boolean;
};

export type BookingAlertRecipients = {
  /** Send the existing owner dispatch (email + SMS + dashboard row). */
  owner: boolean;
  /** Roster members to text, de-duplicated by phone number. */
  members: BookingAlertMember[];
};

/**
 * Anything other than the three known values reads as "owner".
 *
 * The column has a CHECK constraint, so an unknown value should be
 * impossible, but this runs on a best-effort alert path where throwing would
 * suppress a real booking notice, and "owner" is both the default and the
 * behavior every tenant had before the column existed. Failing back to the
 * old behavior is the only failure mode here that cannot surprise anyone.
 */
export function parseBookingAlertAudience(raw: unknown): BookingAlertAudience {
  return raw === "employees" || raw === "both" ? raw : "owner";
}

/**
 * Resolve the employee half of the audience.
 *
 * Rules, in order:
 *  - "owner" selects nobody, and never reads the roster.
 *  - A member with no usable phone is dropped: this is an SMS-only leg, and a
 *    row with a blank number would otherwise look delivered.
 *  - An inactive member is dropped even when named explicitly. Someone who
 *    left the roster does not start receiving alerts again because their id
 *    is still sitting in a preference nobody edited.
 *  - `memberIds` null (or empty) means every active member. Empty is treated
 *    as null rather than as "nobody" because a UI that clears the list means
 *    "stop narrowing", and "employees + nobody" is a setting that can only
 *    ever mean a mistake.
 *  - Two roster rows sharing a phone (the same person entered twice) get one
 *    message, not two.
 *  - On "both", a member whose number IS the owner's alert number is dropped:
 *    they are already getting this booking as the owner alert, and a second
 *    copy as an employee is the same news twice. This is not hypothetical.
 *    Amy Laidlaw is an active row on her own roster carrying the same number
 *    her notification_preferences.phone_number holds. On "employees" the
 *    owner alert is not sent at all, so the same person SHOULD be texted, and
 *    is.
 */
export function resolveBookingAlertRecipients(
  audience: BookingAlertAudience,
  memberIds: readonly string[] | null | undefined,
  roster: readonly BookingAlertMember[],
  ownerPhone?: string | null
): BookingAlertRecipients {
  const owner = audience === "owner" || audience === "both";
  if (audience === "owner") return { owner, members: [] };

  const wanted = memberIds && memberIds.length > 0 ? new Set(memberIds) : null;
  const seenPhones = new Set<string>();
  // Only when the owner leg actually runs. Seeded into the same set the
  // roster de-dupe uses, so there is one rule and one place it is applied.
  const ownerNumber = ownerPhone?.trim() ?? "";
  if (owner && ownerNumber.length > 0) seenPhones.add(ownerNumber);
  const members: BookingAlertMember[] = [];
  for (const m of roster) {
    if (!m.active) continue;
    const phone = m.phone_e164?.trim() ?? "";
    if (phone.length === 0) continue;
    if (wanted && !wanted.has(m.id)) continue;
    if (seenPhones.has(phone)) continue;
    seenPhones.add(phone);
    members.push({ ...m, phone_e164: phone });
  }
  return { owner, members };
}

/**
 * The text an employee gets. Deliberately shorter than the owner's email: it
 * answers "is this mine, and when", and the dashboard link carries the rest.
 *
 * `assigneeName` is whoever holds the appointment, which the caller has
 * already resolved (booking assignee first, then the contact's owner). When
 * nobody holds it, the alert says so plainly, since that is the case somebody
 * has to act on.
 */
export function buildBookingAlertSms(input: {
  attendeeName: string;
  startLocal: string;
  summary: string;
  assigneeName: string | null;
  attendeePhone: string | null;
}): string {
  const who = input.assigneeName
    ? `Assigned to ${input.assigneeName}.`
    : "NOT assigned to anyone yet.";
  const phone = input.attendeePhone ? ` ${input.attendeePhone}` : "";
  return (
    `New booking: ${input.attendeeName}${phone}\n` +
    `${input.summary}\n` +
    `${input.startLocal}\n` +
    who
  );
}
