/**
 * Who should actually receive an urgent alert about a specific contact.
 *
 * Urgent alerts ("[Coworker] Follow up with ...") have always resolved their
 * recipient from `notification_preferences`, which is one row per BUSINESS.
 * That is right for billing, plan and system-health alerts, and wrong the
 * moment the alert is about one lead: when a teammate has claimed that lead,
 * the page belongs to them.
 *
 * The failure this fixes (Amy Laidlaw, Jul 31 2026): a Clever lead was
 * claimed by Dave Lane, `contacts.owner_employee_id` was stamped correctly,
 * and hours later the lead texted asking for a callback. All four
 * notification rows went to the business owner. Dave, who owned the lead,
 * was never told.
 *
 * The resolution ladder mirrors the AiFlow `notify_lead_owner` step, which
 * has solved exactly this for flow-authored hand-offs since Jul 2026:
 * contact by alias-aware phone, then `owner_employee_id`, then an ACTIVE
 * roster row with a phone, else the business owner. Every failure falls DOWN
 * the ladder, never out.
 *
 * Eligibility is `active` plus a phone, and is deliberately BLIND to the
 * four per-employee availability flags. Those govern lead DISTRIBUTION and
 * are enforced at the three lead-selection sites through
 * `filterRosterByAvailability`; this is stewardship of a lead already
 * claimed. `routing_enabled = false` means "stop offering me new leads", not
 * "don't tell me my own client is texting", and an urgent page must not be
 * silenced by a weekly schedule. Same reasoning the README gives for staff
 * hand-off sends staying flag-blind.
 *
 * Shared by the Node dispatcher and the Deno notifications function, so both
 * pipelines route identically.
 */
import { normalizeE164 } from "./normalize_e164.ts";
import { telemetryRecord } from "./telemetry.ts";

// Minimal structural client (the _shared convention).
// deno-lint-ignore no-explicit-any
type AnyClient = any;

/**
 * `coworker_logs.task_type` values that are ABOUT one contact and therefore
 * redirect to that contact's owner.
 *
 * Everything absent from this set stays owner-addressed on purpose: billing
 * caps, spend alerts, missed-call spikes, AiFlow run failures, provisioning
 * and VPS health are the business's own concerns, not a lead's.
 */
export const CONTACT_SCOPED_TASK_TYPES: ReadonlySet<string> = new Set([
  "sms_needs_human",
  "sms_customer_reply"
]);

/**
 * Why the alert went where it went. Null only on a clean contact-owner hit
 * where every channel reached the member.
 */
export type OwnerRedirectReason =
  | "no_contact_phone"
  | "contact_not_found"
  | "contact_unowned"
  | "member_missing"
  | "member_inactive"
  | "member_no_phone"
  | "lookup_failed"
  /** Redirected, but the roster row has no address so email stayed with the owner. */
  | "employee_no_email";

export type ContactOwnerTarget = {
  /** Who gets the SMS / WhatsApp page. */
  target: "contact_owner" | "business_owner";
  /**
   * Who gets the email. Falls back to the business owner independently,
   * because roster rows very often have no email address, and dropping the
   * email would leave a redirected alert with a single delivery path.
   */
  emailTarget: "contact_owner" | "business_owner";
  memberId: string | null;
  memberName: string | null;
  /** The member's phone, when redirecting. */
  phone: string | null;
  /** The member's email, when they have one. */
  email: string | null;
  matchedBy: "phone" | null;
  reason: OwnerRedirectReason | null;
};

const TO_OWNER = (reason: OwnerRedirectReason): ContactOwnerTarget => ({
  target: "business_owner",
  emailTarget: "business_owner",
  memberId: null,
  memberName: null,
  phone: null,
  email: null,
  matchedBy: null,
  reason
});

export type OwnerContactRow = {
  id: string;
  owner_employee_id: string | null;
};

export type OwnerMemberRow = {
  id: string;
  name: string | null;
  phone_e164: string | null;
  email: string | null;
  active: boolean | null;
};

/**
 * The pure decision, given whatever the two lookups found. Exhaustively
 * unit-tested; the IO wrapper below is a thin shell over it.
 */
export function decideOwnerRedirect(
  contact: OwnerContactRow | null,
  member: OwnerMemberRow | null
): ContactOwnerTarget {
  if (!contact) return TO_OWNER("contact_not_found");
  if (!contact.owner_employee_id) return TO_OWNER("contact_unowned");
  if (!member) return TO_OWNER("member_missing");
  // The one real off-switch: the person left the roster.
  if (member.active !== true) return TO_OWNER("member_inactive");
  const phone = (member.phone_e164 ?? "").trim();
  if (!phone) return TO_OWNER("member_no_phone");
  const email = (member.email ?? "").trim();
  return {
    target: "contact_owner",
    emailTarget: email ? "contact_owner" : "business_owner",
    memberId: member.id,
    memberName: (member.name ?? "").trim() || null,
    phone,
    email: email || null,
    matchedBy: "phone",
    // A redirected page whose EMAIL still went to the owner says so, so the
    // dashboard row is not silently confusing.
    reason: email ? null : "employee_no_email"
  };
}

/**
 * Record which way an alert was routed, so "how often does redirection
 * actually fire, and why does it fall back?" is a query rather than a
 * re-audit. Mirrors the `ai_flow_notify_lead_owner` event the AiFlow step
 * already emits, so the two routing paths are comparable.
 *
 * Never throws: telemetry must not be able to break an alert.
 */
async function recordRoutingTelemetry(
  supabase: AnyClient,
  businessId: string,
  verdict: ContactOwnerTarget
): Promise<void> {
  try {
    await telemetryRecord(supabase, "notification_contact_owner_routed", {
      business_id: businessId,
      target: verdict.target,
      email_target: verdict.emailTarget,
      matched_by: verdict.matchedBy,
      reason: verdict.reason
    });
  } catch (e) {
    console.error("contact_owner_target: telemetry", e);
  }
}

/**
 * Resolve the recipient for an alert about `contactE164`. Never throws: any
 * failure returns a business-owner verdict, because an alert must never be
 * dropped because a lookup hiccupped.
 */
export async function resolveContactOwnerTarget(
  supabase: AnyClient,
  businessId: string,
  contactE164: string | null | undefined
): Promise<ContactOwnerTarget> {
  const phone = normalizeE164((contactE164 ?? "").trim() || undefined);
  // No telemetry here on purpose: this path touches no database at all (the
  // caller simply had nothing to route on), and an rpc would be the only IO
  // the whole call makes.
  if (!phone) return TO_OWNER("no_contact_phone");

  const verdict = await resolveVerdict(supabase, businessId, phone);
  await recordRoutingTelemetry(supabase, businessId, verdict);
  return verdict;
}

/** The two lookups and the decision, without the telemetry wrapper. */
async function resolveVerdict(
  supabase: AnyClient,
  businessId: string,
  phone: string
): Promise<ContactOwnerTarget> {
  try {
    const { data: contactData, error: contactErr } = await supabase
      .from("contacts")
      .select("id, owner_employee_id")
      .eq("business_id", businessId)
      .or(`customer_e164.eq.${phone},alias_e164s.cs.{${phone}}`)
      .maybeSingle();
    if (contactErr) {
      console.error("contact_owner_target: contact lookup", contactErr);
      return TO_OWNER("lookup_failed");
    }
    const contact = (contactData as OwnerContactRow | null) ?? null;
    if (!contact?.owner_employee_id) return decideOwnerRedirect(contact, null);

    const { data: memberData, error: memberErr } = await supabase
      .from("ai_flow_team_members")
      .select("id, name, phone_e164, email, active")
      .eq("business_id", businessId)
      .eq("id", contact.owner_employee_id)
      .maybeSingle();
    if (memberErr) {
      console.error("contact_owner_target: member lookup", memberErr);
      return TO_OWNER("lookup_failed");
    }
    return decideOwnerRedirect(contact, memberData as OwnerMemberRow | null);
  } catch (e) {
    console.error("contact_owner_target: lookup", e);
    return TO_OWNER("lookup_failed");
  }
}
