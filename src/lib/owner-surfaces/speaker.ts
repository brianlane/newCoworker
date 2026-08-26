/**
 * Who is speaking on an owner-capable coworker surface.
 *
 * Every surface where the business's own people can reach their coworker
 * has to answer this before it picks a persona, and until now each one
 * answered it privately or not at all:
 *
 *  - SMS classifies the sender inside telnyx-sms-inbound (Deno, ~4,500
 *    lines), unreachable from the app.
 *  - Slack derives it from the Slack profile email.
 *  - The dashboard knows it from the session.
 *  - WhatsApp had no answer at all, so the owner messaging their own
 *    business reached the CUSTOMER sales assistant, got pitched, and was
 *    filed as a lead.
 *
 * This is the shared answer. It reads the same owner numbers the dashboard
 * labels threads with (`businessOwnerNumbers`: onboarding phone, Safe Mode
 * forward cell, alert phone) and the same roster the SMS gate reads.
 *
 * THE FAIL DIRECTION IS DELIBERATELY THE OPPOSITE of
 * `_shared/ai_flows/staff_numbers.ts`, and it is the most important
 * property in this file. That module answers "may we text, tag, or dial
 * this person", where guessing STAFF is safe because it only ever WITHHOLDS
 * an action. This module answers "does this person get owner-power tools",
 * where guessing OWNER hands send_sms, roster CRUD, and live flow edits to
 * whoever is on the other end of an unverified channel. So every uncertain
 * answer here resolves to `customer`, and `readFailed` reports that the
 * answer was forced rather than found.
 *
 * For that flag to be worth anything, a failed read has to be VISIBLE. See
 * ownerNumbersOrThrow below: the shared readers swallow PostgREST errors by
 * design, and a swallowed error here would demote the owner to a customer
 * and call it confident.
 */

import { businessOwnerNumbersResult } from "@/lib/db/contact-names";
import { listTeamMembers, type TeamMemberRow } from "@/lib/db/employees";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { logger } from "@/lib/logger";
import { isSelfPhone } from "../../../supabase/functions/_shared/ai_flows/extracted_contact";

/**
 * `owner` and `teammate` are the business's own people; `customer` is
 * everyone else AND every answer we could not establish.
 */
export type SpeakerKind = "owner" | "teammate" | "customer";

export type SurfaceSpeaker = {
  kind: SpeakerKind;
  /** Display name, when one is known. Never invented. */
  name: string | null;
  /** True when a lookup failed, so `kind` is the fail-closed answer. */
  readFailed: boolean;
};

/**
 * The channel identity of whoever just wrote in. A surface supplies
 * whichever it has: WhatsApp and SMS carry a number, Slack and email carry
 * an address.
 */
export type SpeakerIdentity = {
  phoneE164?: string | null;
  email?: string | null;
};

type BusinessIdentityRow = { owner_name: string | null; owner_email: string | null };

export type ResolveSpeakerDeps = {
  fetchOwnerNumbers?: (businessId: string) => Promise<string[]>;
  fetchRoster?: (businessId: string) => Promise<TeamMemberRow[]>;
  fetchBusiness?: (businessId: string) => Promise<BusinessIdentityRow | null>;
};

/**
 * The two fail-closed answers. Built fresh per call rather than shared
 * constants: a caller that annotates the returned speaker would otherwise
 * mutate every later "unknown" answer in the process.
 */
const unknownSpeaker = (): SurfaceSpeaker => ({
  kind: "customer",
  name: null,
  readFailed: false
});
const unresolvedSpeaker = (): SurfaceSpeaker => ({
  kind: "customer",
  name: null,
  readFailed: true
});

/**
 * The two production readers, both LOUD about a failed read.
 *
 * This is the half Bugbot caught on PR #1629, and it is worth spelling out.
 * The fail-closed promise in the header only held when a reader THREW.
 * `businessOwnerNumbers` and a plain `businesses` read both swallow a
 * PostgREST error and hand back an empty list or a null row, which is
 * indistinguishable from "this business has no owner number on file". The
 * owner would then be classified `customer` with `readFailed: false`: not
 * merely a wrong answer, but one that tells the caller it was a confident
 * one, sending the owner down the customer path. That IS the WhatsApp
 * incident this module exists to prevent.
 *
 * So both readers below turn a failed read into a throw, and the catch in
 * resolveSurfaceSpeaker turns that into the honest fail-closed answer.
 */
export async function ownerNumbersOrThrow(businessId: string): Promise<string[]> {
  const { numbers, readFailed } = await businessOwnerNumbersResult(businessId);
  if (readFailed) throw new Error(`owner number lookup failed for ${businessId}`);
  return numbers;
}

export async function businessIdentityOrThrow(
  businessId: string
): Promise<BusinessIdentityRow | null> {
  const db = await createSupabaseServiceClient();
  const { data, error } = await db
    .from("businesses")
    .select("owner_name, owner_email")
    .eq("id", businessId)
    .maybeSingle();
  if (error) throw new Error(`business identity lookup failed: ${error.message}`);
  // A genuinely absent row is a real answer (no owner email on record), not
  // a failure: it costs a label, never a classification.
  return (data as BusinessIdentityRow | null) ?? null;
}

export async function resolveSurfaceSpeaker(
  businessId: string,
  identity: SpeakerIdentity,
  deps: ResolveSpeakerDeps = {}
): Promise<SurfaceSpeaker> {
  const phone = (identity.phoneE164 ?? "").trim();
  const email = (identity.email ?? "").trim().toLowerCase();
  // No identity is not a failure, it is simply an anonymous speaker. Return
  // before spending any reads on it.
  if (!phone && !email) return unknownSpeaker();

  /* c8 ignore start -- production defaults; tests inject */
  const fetchOwnerNumbers = deps.fetchOwnerNumbers ?? ownerNumbersOrThrow;
  const fetchRoster = deps.fetchRoster ?? listTeamMembers;
  const fetchBusiness = deps.fetchBusiness ?? businessIdentityOrThrow;
  /* c8 ignore stop */

  let ownerNumbers: string[];
  let roster: TeamMemberRow[];
  let business: BusinessIdentityRow | null;
  try {
    [ownerNumbers, roster, business] = await Promise.all([
      // Only the phone arm can use these, so an email-only surface skips
      // the three reads behind them.
      phone ? fetchOwnerNumbers(businessId) : Promise.resolve<string[]>([]),
      fetchRoster(businessId),
      fetchBusiness(businessId)
    ]);
  } catch (err) {
    // Fail CLOSED. See the file header: an unreadable roster must not
    // promote a stranger, it must demote everyone.
    logger.warn("owner surfaces: speaker lookup failed; treating as customer", {
      businessId,
      error: err instanceof Error ? err.message : String(err)
    });
    return unresolvedSpeaker();
  }

  // Only ACTIVE roster rows count, which is deliberately stricter than
  // staff_numbers.ts (where a deactivated broker still counts as staff so
  // no cadence ever dials them). Withholding a sales script from a former
  // employee is harmless; handing them the roster and flow-edit tools is
  // not.
  const rosterMatch =
    roster.find((m) => {
      if (!m.active) return false;
      if (phone && m.phone_e164 && isSelfPhone(phone, [m.phone_e164])) return true;
      const memberEmail = (m.email ?? "").trim().toLowerCase();
      return Boolean(email && memberEmail && memberEmail === email);
    }) ?? null;

  const ownerEmail = (business?.owner_email ?? "").trim().toLowerCase();
  const isOwner =
    (phone && isSelfPhone(phone, ownerNumbers)) ||
    Boolean(email && ownerEmail && ownerEmail === email);

  if (isOwner) {
    // Owner WINS the kind, because the kind is what declares the tools. The
    // roster name still wins the label when there is one: it is usually
    // more specific than the generic businesses.owner_name. This is the
    // same precedence telnyx-sms-inbound already applies.
    const name = rosterMatch?.name?.trim() || business?.owner_name?.trim() || null;
    return { kind: "owner", name, readFailed: false };
  }
  if (rosterMatch) {
    return { kind: "teammate", name: rosterMatch.name?.trim() || null, readFailed: false };
  }
  return unknownSpeaker();
}
