/**
 * Who hears about a lead that NOBODY owns.
 *
 * Amy Laidlaw, 2026-08-15: "leads asking for a call means serious / asking for
 * a human, and unowned/unclaimed should go to all employees respective to
 * seller vs buyer employees before Amy broadcasted."
 *
 * The AiFlow `notify_lead_owner` step has answered that since Jul 2026 via
 * `unownedFallback: "team"`, and the urgent-alert dispatcher had no such rung:
 * an unowned contact resolved straight to the business owner. Both paths now
 * share this one selector rather than keeping two copies of a rule that is
 * mostly edge cases.
 *
 * The failure that forced it (Amy Laidlaw, Aug 14-15 2026): a Clever seller
 * texted "I'm available now", then the next day "I have not heard anything
 * from anyone". The AI's `notify_team` tool fired both times and both alerts
 * went to Amy alone, because the contact had no `owner_employee_id`. Neither
 * of the two teammates who cover sellers was ever told.
 *
 * Two rules, both of which exist to prevent silence:
 *
 * 1. `team_broadcast_enabled === false` excludes, and only an explicit false
 *    does. That flag is how a person is deliberately kept out of team traffic
 *    (on Amy's account it is Amy herself, who is the BACKSTOP for an unowned
 *    lead, not part of its audience). An unset column means available, which
 *    matches how the roster's other availability flags are read.
 *
 * 2. The tag filter FAILS SAFE. Tags are free text with nothing validating
 *    them, so a tag matching nobody widens back to every eligible member
 *    instead of collapsing to an empty send. A typo costs noise; the
 *    alternative costs a lead.
 */

/** The roster columns this selector reads. */
export type BroadcastMemberRow = {
  id: string;
  name?: string | null;
  phone_e164?: string | null;
  team_broadcast_enabled?: boolean | null;
  tags?: string[] | null;
};

/** A resolved recipient: always has a usable phone. */
export type BroadcastMember = {
  id: string;
  name: string | null;
  phone: string;
};

/**
 * Narrow an ACTIVE roster to the people who should receive an unowned-lead
 * alert, optionally scoped to one lead-type tag ("seller", "buyer").
 *
 * Callers are responsible for passing only active rows: `active` is a
 * database filter everywhere this is used, and duplicating it here would let
 * a caller forget it and still look correct.
 *
 * Returns an empty array only when nobody at all is eligible, which is the
 * caller's signal to fall back to the business owner.
 */
export function selectBroadcastTeam(
  rows: readonly BroadcastMemberRow[],
  tag?: string | null
): BroadcastMember[] {
  // Tags ride along with each member rather than living in a side map: a
  // lookup keyed on id would need an unreachable "member with no entry"
  // fallback, and an unreachable branch is a branch nobody can ever test.
  const eligible: Array<BroadcastMember & { normalizedTags: string[] }> = [];
  for (const row of rows) {
    if (row.team_broadcast_enabled === false) continue;
    const phone = (row.phone_e164 ?? "").trim();
    if (!phone) continue;
    eligible.push({
      id: row.id,
      name: (row.name ?? "").trim() || null,
      phone,
      normalizedTags: (row.tags ?? [])
        .map((t) => String(t).trim().toLowerCase())
        .filter((t) => t.length > 0)
    });
  }
  const strip = (m: BroadcastMember & { normalizedTags: string[] }): BroadcastMember => ({
    id: m.id,
    name: m.name,
    phone: m.phone
  });
  const want = normalizeTag(tag);
  if (!want) return eligible.map(strip);
  const tagged = eligible.filter((m) => m.normalizedTags.includes(want));
  return (tagged.length > 0 ? tagged : eligible).map(strip);
}

/** One normalization, so a filter and its diagnostic cannot disagree. */
function normalizeTag(tag?: string | null): string {
  return (tag ?? "").trim().toLowerCase();
}

/**
 * Did the tag narrow the audience, or did the fail-safe widen it back out?
 *
 * Reported alongside a broadcast so "the whole team got a seller alert" is
 * distinguishable from "the seller tag matched nobody, so everyone did". The
 * two look identical in the send log and mean very different things: the
 * second one says the roster's tags need fixing.
 */
export function broadcastTagMatched(
  rows: readonly BroadcastMemberRow[],
  tag?: string | null
): boolean {
  const want = normalizeTag(tag);
  if (!want) return false;
  // Asked of the ELIGIBLE rows only, and asked directly rather than by
  // comparing audience sizes: a tag every teammate carries narrows nothing
  // and still matched, which a size comparison would report as a miss.
  return rows.some(
    (r) =>
      r.team_broadcast_enabled !== false &&
      (r.phone_e164 ?? "").trim().length > 0 &&
      (r.tags ?? []).some((t) => normalizeTag(String(t)) === want)
  );
}
