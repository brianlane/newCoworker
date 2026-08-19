/**
 * Who owns a contact when nobody has explicitly claimed it: the pure rules.
 *
 * A one-person business has no unowned contacts. HQ's roster is a single row
 * (Brian, the owner himself), so the contacts page offered "Nobody (unowned)"
 * as the default answer to a question with exactly one possible answer, the
 * Task Center called every lead "unassigned", and a booking alert told the
 * owner to "assign the contact to a teammate" who does not exist.
 *
 * So a NULL `contacts.owner_employee_id` RESOLVES AT READ TIME to the sole
 * roster member, and only when that member is provably the business owner:
 * their roster phone matches one of the three owner numbers that
 * `businessOwnerNumbers` already defines (the Safe Mode forward cell, the
 * alert phone, the onboarding phone), the same recognition the Employees page
 * uses to badge the owner's own roster row. A solo business whose one roster
 * row is an assistant keeps its unowned contacts: there the owner really can
 * hand a lead over, so "nobody holds this yet" is still news.
 *
 * Nothing is WRITTEN. The column stays null, which is what keeps this safe:
 * hiring a second teammate changes the answer with no backfill, the AiFlow
 * claim path's compare-and-swap (`.is("owner_employee_id", null)`) still
 * fires, and no stored row can disagree with the roster. The flip side is
 * that anything reading the raw column keeps seeing null, so surfaces opt in
 * by calling this.
 *
 * Deliberately NOT applied to `src/lib/analytics/lead-sources.ts`: its
 * `claimed` counter measures whether a claim EVENT happened, not who is
 * responsible, and counting a solo tenant at 100% claimed would answer a
 * different question than the card asks.
 *
 * Import-free on purpose, so the pure consumers (`src/lib/leads/data-view.ts`,
 * whose shapes the client grid imports) never pull a Supabase client into the
 * browser bundle. The database side lives in
 * `src/lib/db/implicit-contact-owner.ts`.
 */

/** The roster member every unclaimed contact falls to. */
export type ImplicitContactOwner = { id: string; name: string };

/** The roster fields the rule needs, so callers can pass rows they hold. */
export type ImplicitOwnerCandidate = {
  id: string;
  name: string | null;
  phone_e164: string;
  active: boolean;
};

/**
 * The rule: exactly one ACTIVE roster member, and that member is the owner.
 *
 * Inactive rows are ignored on purpose. A business that hired one person and
 * offboarded them is back to one-person, and the offboarded row must never
 * become the implicit owner of every contact.
 */
export function pickImplicitContactOwner(
  members: readonly ImplicitOwnerCandidate[],
  ownerNumbers: readonly string[]
): ImplicitContactOwner | null {
  const active = members.filter((m) => m.active);
  if (active.length !== 1) return null;
  const sole = active[0];
  // Both sides are E.164 (`phone_e164` by schema, owner numbers coerced by
  // `businessOwnerNumbers`), the same direct comparison the Employees page
  // makes to badge the owner's own roster row.
  if (!ownerNumbers.includes(sole.phone_e164)) return null;
  return { id: sole.id, name: sole.name?.trim() || "Owner" };
}

/**
 * The owner a surface should SHOW for one contact: the explicit stamp first,
 * the implicit owner when the column is null, else nobody.
 *
 * `nameById` is the roster's id → name map the caller already builds; a
 * stamped id missing from it (a deleted roster row) keeps its null name, same
 * as before.
 */
export function effectiveContactOwner(
  storedId: string | null | undefined,
  implicit: ImplicitContactOwner | null,
  nameById?: ReadonlyMap<string, string>
): { id: string; name: string | null } | null {
  if (storedId) return { id: storedId, name: nameById?.get(storedId) ?? null };
  return implicit ? { id: implicit.id, name: implicit.name } : null;
}
