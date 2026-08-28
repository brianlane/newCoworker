/**
 * Who counts as OUR side of the business, as one answer every guard shares.
 *
 * Three guards ask this question and must never disagree: update_contact's tag
 * protection, customer filing, and (since PR #1304) the "F" follow-up reply,
 * which decides whether a contact may be put into an AI calling cadence.
 *
 * Lifted out of ai-flow-worker/index.ts unchanged when the third caller
 * arrived. Reimplementing the rule per call site is exactly how a teammate
 * ends up filed as a lead, which this account has already lived through.
 *
 * The subtle half is that owner numbers are usually DERIVED rather than stored
 * as an owner-typed contact: the business phone, the forward cell, the
 * coworker's own DID. An owner's row is very often typed "customer", so a
 * type check alone would leave the owner eligible to be called by their own
 * follow-up cadence.
 */
import { isSelfPhone } from "./extracted_contact.ts";
import { contactKeyEmail } from "../contact_key.ts";
import { normalizeE164 } from "../normalize_e164.ts";

// Minimal structural client (matches the _shared convention).
// deno-lint-ignore no-explicit-any
type AnyClient = any;

/**
 * Every number that IS the business: its SMS sender, its forward cell, and the
 * owner's listed phone.
 */
export async function businessSelfNumbers(
  supabase: AnyClient,
  businessId: string
): Promise<string[]> {
  const out: string[] = [];
  const { data: settings } = await supabase
    .from("business_telnyx_settings")
    .select("telnyx_sms_from_e164, forward_to_e164")
    .eq("business_id", businessId)
    .maybeSingle();
  const s = settings as
    | { telnyx_sms_from_e164?: string | null; forward_to_e164?: string | null }
    | null;
  if (s?.telnyx_sms_from_e164) out.push(s.telnyx_sms_from_e164);
  if (s?.forward_to_e164) out.push(s.forward_to_e164);
  const { data: biz } = await supabase
    .from("businesses")
    .select("phone")
    .eq("id", businessId)
    .maybeSingle();
  const phone = (biz as { phone?: string | null } | null)?.phone;
  if (phone) out.push(phone);
  return out;
}

/**
 * The staff rule with its lookups already done: roster phones and the
 * business's own derived numbers, read ONCE.
 *
 * staffNumberCheck answers for a single contact and re-reads both on every
 * call, which is right for a guard that fires once per step and wrong for a
 * caller sifting a page of contacts: fifty candidates became a hundred and
 * fifty round trips on the SMS webhook path (Bugbot, PR #1304). Load the
 * matcher once, then ask it as often as you like.
 */
export type StaffMatcher = {
  /** True when this number is our own side of the business. */
  isStaff(phone: string, storedType: string | null | undefined): boolean;
  /** A lookup errored, so every answer above is the fail-safe one. */
  readFailed: boolean;
};

export async function loadStaffMatcher(
  supabase: AnyClient,
  businessId: string
): Promise<StaffMatcher> {
  const { data: members, error } = await supabase
    .from("ai_flow_team_members")
    .select("phone_e164")
    .eq("business_id", businessId);
  if (error) {
    console.error("staff roster load", error);
    // Fail SAFE: everything is staff until we can prove otherwise.
    return { isStaff: () => true, readFailed: true };
  }
  const roster = new Set(
    ((members ?? []) as Array<{ phone_e164?: string | null }>)
      .map((m) => (m.phone_e164 ?? "").trim())
      .filter(Boolean)
  );
  const selfNumbers = await businessSelfNumbers(supabase, businessId);
  return {
    readFailed: false,
    isStaff(phone, storedType) {
      const type = (storedType ?? "").trim().toLowerCase();
      if (type === "owner" || type === "employee") return true;
      const p = phone.trim();
      // No number is not a lead: there is nothing to call, and treating it as
      // callable is the direction that goes wrong.
      if (!p) return true;
      if (roster.has(p)) return true;
      return isSelfPhone(p, selfNumbers);
    }
  };
}

/**
 * Do any of these contact keys belong to our side of the business? True when
 * the stored contact row is typed owner/employee, or any number sits on the
 * ai_flow_team_members roster (active or not: a deactivated broker is still
 * staff), or an `email:` key's ADDRESS sits on that roster, or a number matches
 * the business's own derived numbers.
 *
 * `readFailed` reports that a lookup errored so the answer is not trustworthy.
 * Every caller treats that as staff (fail SAFE: better to decline than to
 * text, tag, or dial our own people), but they differ in what they do next, so
 * the flag is returned rather than collapsed into `staff`.
 */
export async function staffNumberCheck(
  supabase: AnyClient,
  businessId: string,
  contactNumbers: string[],
  storedType: string | null | undefined
): Promise<{ staff: boolean; readFailed: boolean }> {
  if (storedType === "owner" || storedType === "employee") {
    return { staff: true, readFailed: false };
  }
  // Spans EVERY number attached to the contact row (primary + merged aliases +
  // the targeted number): the contact lookup is alias-aware, so protection
  // must be too. A flow targeting an alias of a broker's row is still
  // targeting the broker.
  const { data: member, error } = await supabase
    .from("ai_flow_team_members")
    .select("id")
    .eq("business_id", businessId)
    .in("phone_e164", contactNumbers)
    .limit(1)
    .maybeSingle();
  if (error) {
    console.error("staff roster check", error);
    return { staff: true, readFailed: true };
  }
  if (member != null) return { staff: true, readFailed: false };

  // An email-keyed contact carries no number the roster could match, so the
  // number arm above always misses and the whole protection would evaporate
  // for exactly the contacts it was added for. Compare the ADDRESS against the
  // roster's emails instead. Same doctrine, same fail-safe: a read error means
  // staff, because filing (or tagging) a teammate under a lead's name is worse
  // than a missing contact row.
  const addresses = new Set(
    contactNumbers.map((n) => contactKeyEmail(n)).filter((a): a is string => a !== null)
  );
  if (addresses.size > 0) {
    // Compared in JS, lowercased on BOTH sides. contactKeyEmail lowercases (an
    // address is one identity however it was typed) while roster emails keep
    // whatever casing the dashboard or a CSV import stored, so a database-side
    // equality would miss `Dave@Example.com` and the protection would quietly
    // not apply. A roster is a handful of rows, so reading it whole is cheap.
    const { data: roster, error: emailErr } = await supabase
      .from("ai_flow_team_members")
      .select("email")
      .eq("business_id", businessId)
      .not("email", "is", null);
    if (emailErr) {
      console.error("staff roster email check", emailErr);
      return { staff: true, readFailed: true };
    }
    const rosterEmails = ((roster ?? []) as Array<{ email?: string | null }>)
      .map((m) => (m.email ?? "").trim().toLowerCase())
      .filter(Boolean);
    if (rosterEmails.some((e) => addresses.has(e))) {
      return { staff: true, readFailed: false };
    }
  }
  // isSelfPhone is the SHARED both-sides-normalized comparator (the same one
  // the extraction scrub and the send_sms self-send guard use), so the guards
  // can never disagree on what counts as "ourselves".
  const selfNumbers = await businessSelfNumbers(supabase, businessId);
  return {
    staff: contactNumbers.some((n) => isSelfPhone(n, selfNumbers)),
    readFailed: false
  };
}

/**
 * The OWNER's own numbers, as one answer the owner-only gates share.
 *
 * An owner is not a row anywhere. They are recognized by number, and the
 * numbers are spread over three tables: the Safe Mode forward cell, the
 * notification alert phone, and the onboarding phone on the business itself.
 * That is the same set `resolveContactNames` labels "owner" on the dashboard
 * and the same set the SMS webhook's staff gate uses, so gate behavior and
 * labeling cannot disagree.
 *
 * This exists because the "F" follow-up reply invented its OWN owner rule
 * instead: it filtered `businesses` on an `owner_alert_e164` column, which has
 * never existed on that table. PostgREST answered 400, the error was
 * destructured away, and the owner arm of the gate was dead from the day it
 * shipped, silently, for every tenant whose owner is not also on the roster
 * (Amy Laidlaw, found Aug 28 2026). Hence one shared function with tests,
 * rather than a fourth hand-rolled copy.
 *
 * `readFailed` is reported rather than collapsed into an empty list: "this
 * person is not the owner" and "we could not find out" are different answers,
 * and conflating them is precisely what hid the original bug.
 */
export async function ownerAlertNumbers(
  supabase: AnyClient,
  businessId: string
): Promise<{ numbers: string[]; readFailed: boolean }> {
  const [fwdRes, prefsRes, bizRes] = await Promise.all([
    supabase
      .from("business_telnyx_settings")
      .select("forward_to_e164")
      .eq("business_id", businessId)
      .maybeSingle(),
    supabase
      .from("notification_preferences")
      .select("phone_number")
      .eq("business_id", businessId)
      .maybeSingle(),
    supabase.from("businesses").select("phone").eq("id", businessId).maybeSingle()
  ]);
  if (fwdRes.error || prefsRes.error || bizRes.error) {
    console.error("owner number lookup", fwdRes.error ?? prefsRes.error ?? bizRes.error);
    return { numbers: [], readFailed: true };
  }
  const raw = [
    (fwdRes.data as { forward_to_e164?: string | null } | null)?.forward_to_e164,
    (prefsRes.data as { phone_number?: string | null } | null)?.phone_number,
    (bizRes.data as { phone?: string | null } | null)?.phone
  ];
  // Normalized on the way out: two of the three are free-form owner-typed
  // fields, so "(602) 695-1142" and "+16026951142" are the same person and a
  // raw string compare would say otherwise.
  const numbers = [...new Set(raw.map((n) => normalizeE164(n ?? "")).filter((n): n is string => Boolean(n)))];
  return { numbers, readFailed: false };
}

/**
 * Is this number the business owner's? Normalizes BOTH sides, so a caller
 * holding a webhook's E.164 and a business holding a hand-typed phone still
 * agree.
 */
export async function isBusinessOwnerPhone(
  supabase: AnyClient,
  businessId: string,
  phone: string
): Promise<{ owner: boolean; readFailed: boolean }> {
  const normalized = normalizeE164(phone);
  const { numbers, readFailed } = await ownerAlertNumbers(supabase, businessId);
  if (readFailed) return { owner: false, readFailed: true };
  return { owner: normalized != null && numbers.includes(normalized), readFailed: false };
}
