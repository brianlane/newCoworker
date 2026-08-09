/**
 * The contact-ownership claim gate.
 *
 * Why (Austin Happ, Amy Laidlaw, 2026-08-08): RealEstateAgents sent the same
 * person as TWO leads two seconds apart, a seller and a buyer. The seller
 * broadcast was claimed by Dave in 53 seconds; the buyer offer had already
 * gone out on the unpinned rotation before that claim existed, and 28
 * minutes AFTER Dave owned the contact, Gabrielle claimed the buyer run.
 * Two teammates each believed they owned one person, and
 * assignContactOwnerOnClaim never steals, so the CONTACT said Dave while
 * the buyer run's vars said Gabrielle.
 *
 * The rule this module encodes: once a contact has an ACTIVE owning
 * teammate, their later leads belong to that owner. A different teammate's
 * claim is answered with a courteous no instead of silently splitting the
 * person in two.
 *
 * Pure decisions only (the webhook and worker do their own lookups), so the
 * policy and the wording pin at 100% coverage like every `_shared` module.
 */

/** The resolved owner of the lead's contact, or null when unowned. */
export type ContactOwnerForClaim = {
  phone: string;
  name: string;
  /** Roster row still active? An ex-teammate's ownership never blocks. */
  active: boolean;
};

/**
 * Should this claim be refused because the contact already belongs to a
 * DIFFERENT active teammate? The owner's own claim always passes (their
 * contact, their lead), as does anything on an unowned contact or one owned
 * by someone who has left the roster.
 */
export function claimBlockedByOwner(
  owner: ContactOwnerForClaim | null,
  claimerPhone: string
): boolean {
  if (!owner || !owner.active || !owner.phone) return false;
  return owner.phone !== claimerPhone;
}

/**
 * The reply the refused claimer receives. Names the owner so the teammate
 * knows who has it (and can coordinate instead of wondering), and says
 * plainly that nothing is needed from them.
 */
export function ownerConflictReplyText(ownerName: string, leadLabel: string): string {
  const who = ownerName.trim() || "another teammate";
  const lead = leadLabel.trim() || "This lead";
  return `Thanks, ${lead} is already with ${who}: they own this contact from an earlier lead, so this one is theirs too. Nothing needed from you.`;
}
