/**
 * The solo-owner rule, Deno side: a business whose roster is exactly one
 * ACTIVE member, where that member is provably the business owner, has
 * nobody to race for a lead. Routing surfaces use this to skip the
 * offer-and-claim dance (a "Reply 1" text the owner would send to
 * themselves) and deliver one informational notice instead.
 *
 * LOCKSTEP twin of the Next-side pair, kept import-free of it because this
 * file must run under Deno:
 * - `src/lib/contacts/owner-attribution.ts` (`pickImplicitContactOwner`):
 *   the same accept/reject rule, pinned by `tests/solo-owner-rule.test.ts`.
 * - `src/lib/db/contact-names.ts` (`businessOwnerNumbers`): the same three
 *   owner-number sources in the same order, pinned by the same test.
 *
 * Same doctrine as that pair (see PR #1500): this is a READ-time answer.
 * Nothing here writes `contacts.owner_employee_id`; hiring a second
 * teammate changes every answer with no backfill, and the claim
 * compare-and-swap on a null owner keeps firing. Every helper fails toward
 * "no solo owner" (null / empty), which callers must treat as "run today's
 * machinery", so an unreadable roster can never invent a shortcut.
 */

import { normalizeE164 } from "./normalize_e164.ts";

// Minimal structural client, the _shared convention (see
// contact_owner_target.ts): the Deno and Node supabase-js clients differ
// only in types we do not rely on.
// deno-lint-ignore no-explicit-any
type AnyClient = any;

/** The roster fields the rule needs; callers may pass rows they hold. */
export type SoloRosterRow = {
  id: string;
  name?: string | null;
  phone_e164?: string | null;
  email?: string | null;
  active?: boolean | null;
};

/** The sole active roster member, proven to be the business owner. */
export type SoloOwner = {
  memberId: string;
  /** Trimmed roster name; "Owner" when the row has none (lockstep). */
  name: string;
  /** The roster row's E.164 phone, the one that matched an owner number. */
  phone: string;
  email: string | null;
};

/**
 * The rule: exactly one ACTIVE roster member, and that member is the owner
 * (their `phone_e164` appears in `ownerNumbers`). Inactive rows are ignored
 * on purpose: a business that hired one person and offboarded them is back
 * to one-person, and the offboarded row must never become the answer.
 */
export function pickSoloOwner(
  members: readonly SoloRosterRow[],
  ownerNumbers: readonly string[]
): SoloOwner | null {
  const active = members.filter((m) => m.active === true);
  if (active.length !== 1) return null;
  const sole = active[0];
  const phone = sole.phone_e164 ?? "";
  if (!phone || !ownerNumbers.includes(phone)) return null;
  return {
    memberId: sole.id,
    name: sole.name?.trim() || "Owner",
    phone,
    email: sole.email?.trim() || null
  };
}

/**
 * The business's own owner numbers, E.164-coerced: the Safe Mode forward
 * cell, the notification alert phone, and the onboarding phone, in that
 * order (the `businessOwnerNumbers` order). Returns [] on any read error:
 * an unreadable owner list must read as "cannot prove the owner", never as
 * a match.
 */
export async function soloOwnerNumbers(
  supabase: AnyClient,
  businessId: string
): Promise<string[]> {
  try {
    const [telnyxRes, prefsRes, bizRes] = await Promise.all([
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
    // A failed source contributes nothing (its data is null), the same
    // per-source posture as businessOwnerNumbers on the Node side.
    return [
      normalizeE164((telnyxRes.data as { forward_to_e164?: string | null } | null)?.forward_to_e164 ?? undefined),
      normalizeE164((prefsRes.data as { phone_number?: string | null } | null)?.phone_number ?? undefined),
      normalizeE164((bizRes.data as { phone?: string | null } | null)?.phone ?? undefined)
    ].filter((n): n is string => Boolean(n));
  } catch (e) {
    console.error("solo_owner: owner-number lookup threw", e);
    return [];
  }
}

/**
 * Resolve the solo owner for a business, or null when the rule does not
 * apply OR anything was unreadable. Never throws. The owner-number reads
 * happen only after the active count comes back as exactly one, so a
 * business with a real team pays a single roster query (or none when the
 * caller passes `members` it already holds).
 */
export async function resolveSoloOwner(
  supabase: AnyClient,
  businessId: string,
  members?: readonly SoloRosterRow[]
): Promise<SoloOwner | null> {
  try {
    let roster = members;
    if (!roster) {
      const { data, error } = await supabase
        .from("ai_flow_team_members")
        .select("id, name, phone_e164, email, active")
        .eq("business_id", businessId);
      if (error) {
        console.error("solo_owner: roster lookup", error);
        return null;
      }
      roster = (data ?? []) as SoloRosterRow[];
    }
    if (roster.filter((m) => m.active === true).length !== 1) return null;
    const ownerNumbers = await soloOwnerNumbers(supabase, businessId);
    return pickSoloOwner(roster, ownerNumbers);
  } catch (e) {
    console.error("solo_owner: resolve threw", e);
    return null;
  }
}
