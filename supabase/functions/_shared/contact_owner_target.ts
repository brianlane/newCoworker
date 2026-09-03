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
import { pickSoloOwner, soloOwnerNumbers } from "./solo_owner.ts";
import { telemetryRecord } from "./telemetry.ts";
import {
  selectBroadcastTeam,
  type BroadcastMember,
  type BroadcastMemberRow
} from "./team_broadcast.ts";

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
 * where every channel reached the member; informative reasons can also ride
 * a `contact_owner` verdict (`employee_no_email`, `solo_owner`).
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
  | "employee_no_email"
  /**
   * Nobody stamped an owner, but the roster is exactly one ACTIVE member who
   * is provably the business owner (solo_owner.ts), so the alert goes to
   * them as a plain informational page: no team broadcast, no "Reply 1"
   * claim invite, no unowned_lead_alerts row. Read-time only; the contact's
   * owner_employee_id stays null.
   */
  | "solo_owner"
  /**
   * A keep-for-owner ($1M+) park is live for this lead, so the team must
   * not be offered it (Amy Laidlaw, Robert Braid, 2026-09-02). Pages the
   * business owner. The contact stays unowned; once the park ends the
   * team-broadcast rung returns.
   */
  | "owner_direct_live";

export type ContactOwnerTarget = {
  /**
   * Who gets the SMS / WhatsApp page.
   *
   * `team_broadcast` means nobody owns the lead and the lead-type-tagged
   * roster is alerted instead of the owner. It is an ALERT, not a claim
   * offer: nobody is asked to reply and nothing waits on a response.
   */
  target: "contact_owner" | "team_broadcast" | "business_owner";
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
  /**
   * The tagged roster to alert. Populated only on `team_broadcast`; every
   * other verdict carries an empty array so callers never branch on
   * null-vs-empty.
   */
  team: BroadcastMember[];
};

const TO_OWNER = (reason: OwnerRedirectReason): ContactOwnerTarget => ({
  target: "business_owner",
  emailTarget: "business_owner",
  memberId: null,
  memberName: null,
  phone: null,
  email: null,
  matchedBy: null,
  reason,
  team: []
});

/**
 * Nobody owns this lead, so the lead-type-tagged team hears about it instead.
 *
 * The EMAIL deliberately stays with the business owner: roster rows very
 * often have no address (all four of Amy's are null), so redirecting it would
 * usually mean no email at all, and the owner still wants the paper trail for
 * a lead nobody has claimed.
 */
const TO_TEAM = (team: BroadcastMember[]): ContactOwnerTarget => ({
  target: "team_broadcast",
  emailTarget: "business_owner",
  memberId: null,
  memberName: null,
  phone: null,
  email: null,
  matchedBy: null,
  reason: "contact_unowned",
  team
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
    reason: email ? null : "employee_no_email",
    team: []
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
      reason: verdict.reason,
      team_size: verdict.team.length
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
  contactE164: string | null | undefined,
  /**
   * Lead type ("seller" / "buyer") used to narrow the unowned-lead broadcast
   * to the teammates who cover it. Omitted, or a tag nobody carries, alerts
   * every eligible member: the filter degrades to noise, never to silence.
   */
  leadTag?: string | null
): Promise<ContactOwnerTarget> {
  const phone = normalizeE164((contactE164 ?? "").trim() || undefined);
  // No telemetry here on purpose: this path touches no database at all (the
  // caller simply had nothing to route on), and an rpc would be the only IO
  // the whole call makes.
  if (!phone) return TO_OWNER("no_contact_phone");

  const verdict = await resolveVerdict(supabase, businessId, phone, leadTag);
  await recordRoutingTelemetry(supabase, businessId, verdict);
  return verdict;
}

/**
 * The ACTIVE roster behind the unowned branch: the solo-owner rung counts
 * it, and `selectBroadcastTeam` narrows it by lead type at the call site.
 *
 * Never throws: a roster read that fails returns an empty list, which the
 * caller reads as "fall back to the owner". Losing the broadcast is
 * acceptable; losing the alert is not.
 */
type ActiveRosterRow = BroadcastMemberRow & { email?: string | null };

async function readActiveRoster(
  supabase: AnyClient,
  businessId: string
): Promise<ActiveRosterRow[]> {
  try {
    const { data, error } = await supabase
      .from("ai_flow_team_members")
      .select("id, name, phone_e164, email, team_broadcast_enabled, tags")
      .eq("business_id", businessId)
      .eq("active", true);
    if (error) {
      console.error("contact_owner_target: roster lookup", error);
      return [];
    }
    return (data ?? []) as ActiveRosterRow[];
  } catch (e) {
    console.error("contact_owner_target: roster lookup threw", e);
    return [];
  }
}

/**
 * The solo-owner rung of the unowned branch: when the active roster is
 * exactly one member and that member is provably the business owner, the
 * "unowned" state is a fiction (there is nobody else to claim), so the
 * alert goes to them as a plain contact-owner page instead of a
 * team-broadcast claim invite.
 *
 * Never throws, and null on ANY doubt (roster not exactly one, owner
 * numbers unreadable, no phone match): callers then run today's
 * team-broadcast rung, which is the required fail direction.
 */
async function soloOwnerVerdict(
  supabase: AnyClient,
  businessId: string,
  roster: ActiveRosterRow[]
): Promise<ContactOwnerTarget | null> {
  if (roster.length !== 1) return null;
  // No try/catch here on purpose: soloOwnerNumbers and pickSoloOwner are
  // never-throw by contract (their own tests pin it), and the enclosing
  // resolveVerdict catch is the module's final backstop.
  const ownerNumbers = await soloOwnerNumbers(supabase, businessId);
  const solo = pickSoloOwner(
    roster.map((m) => ({
      id: m.id,
      name: m.name,
      phone_e164: m.phone_e164,
      email: m.email ?? null,
      active: true
    })),
    ownerNumbers
  );
  if (!solo) return null;
  return {
    target: "contact_owner",
    // Same posture as decideOwnerRedirect: a roster row with no address
    // keeps the email (the paper trail) with the business owner.
    emailTarget: solo.email ? "contact_owner" : "business_owner",
    memberId: solo.memberId,
    memberName: solo.name,
    phone: solo.phone,
    email: solo.email,
    matchedBy: "phone",
    reason: "solo_owner",
    team: []
  };
}

/** The lookups and the decision, without the telemetry wrapper. */
async function resolveVerdict(
  supabase: AnyClient,
  businessId: string,
  phone: string,
  leadTag: string | null | undefined
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
    if (!contact?.owner_employee_id) {
      const verdict = decideOwnerRedirect(contact, null);
      // An UNOWNED contact goes to the tagged team before the owner. A
      // contact we could not find at all keeps the old owner-direct
      // behavior: without a contact row there is no lead to speak of, and
      // broadcasting to the whole team on a lookup miss is noise, not rescue.
      if (verdict.reason !== "contact_unowned") return verdict;
      // Keep-for-owner window: a live $1M+ park on this phone means the
      // owner was told the team would not be offered it. Broadcasting a
      // claimable "Needs Human" alert here is how Gabby claimed Robert
      // Braid three minutes after Amy was told KEPT FOR YOU (2026-09-02).
      const park = await findLiveOwnerDirectPark(supabase, businessId, phone);
      if (park === "error") return TO_OWNER("lookup_failed");
      if (park) return TO_OWNER("owner_direct_live");
      const roster = await readActiveRoster(supabase, businessId);
      // Solo-owner rung: a one-person owner-only roster has nobody to
      // broadcast to but the owner themselves, so skip the claim framing.
      const solo = await soloOwnerVerdict(supabase, businessId, roster);
      if (solo) return solo;
      const team = selectBroadcastTeam(roster, leadTag);
      return team.length > 0 ? TO_TEAM(team) : verdict;
    }

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

/**
 * Is there a live keep-for-owner park for this lead phone?
 *
 * Uses `.limit(1)` and takes the first row, never `maybeSingle()`: a
 * multi-row match is an error on maybeSingle, and treating that error as
 * "no park" would re-offer the team (the exact failure this rung exists
 * to prevent). `owner_direct_done` is filtered in code because a just-
 * exhausted park can sit in `queued` for one worker tick with the flag
 * already set.
 *
 * "error" is distinct from "no park" so a down query cannot silently
 * become a team broadcast.
 */
async function findLiveOwnerDirectPark(
  supabase: AnyClient,
  businessId: string,
  phone: string
): Promise<boolean | "error"> {
  try {
    const { data, error } = await supabase
      .from("ai_flow_runs")
      .select("id, context")
      .eq("business_id", businessId)
      .in("status", ["awaiting_agent", "queued"])
      .eq("context->routing->>owner_direct", "true")
      .eq("context->vars->>lead_phone", phone)
      .order("updated_at", { ascending: false })
      .limit(1);
    if (error) {
      console.error("contact_owner_target: owner_direct park lookup", error);
      return "error";
    }
    const rows = Array.isArray(data) ? data : [];
    for (const row of rows) {
      const routing = (row as { context?: { routing?: { owner_direct_done?: boolean } } } | null)
        ?.context?.routing;
      if (routing?.owner_direct_done !== true) return true;
    }
    return false;
  } catch (e) {
    console.error("contact_owner_target: owner_direct park lookup threw", e);
    return "error";
  }
}
