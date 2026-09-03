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
  return `Thanks, ${lead} is already with ${who}: they own this contact, so this one is theirs too. Nothing needed from you.`;
}

/**
 * Should the inbound claim-ownership gate skip this run entirely?
 *
 * An owner-direct park (`routing.owner_direct`) is the OWNER acknowledging a
 * keep-for-owner alert, never a teammate claim (the worker's
 * `ownerDirectResume` says so in so many words). Running the gate on it is
 * how Amy Laidlaw's "1" on Robert Braid (2026-09-02) was refused because
 * Gabrielle had claimed the same contact through a different door ten
 * minutes earlier. A real offer (`owner_direct` absent/false) still claims.
 *
 * Pure: callers pass already-parsed routing.
 */
export function claimGateSkipsRun(routing: { owner_direct?: boolean } | null | undefined): boolean {
  return routing?.owner_direct === true;
}

/** The var this module is about. Substring match, see flowDealsInLeadPhone. */
const LEAD_PHONE_TOKEN = "lead_phone";

/**
 * Does this flow deal in lead phone numbers at all?
 *
 * Read from the flow DEFINITION, which is why this exists. The Danfar guard
 * below originally asked the same question of the run's variable bag ("is
 * there a lead_phone key yet?"), and a variable bag only fills up as steps
 * execute. On Amy Laidlaw's HomeLight flow, route_to_team is step 5 and the
 * extraction that declares lead_phone is step 6, so at route time the bag
 * looked exactly like a customer-texts-in flow's, the sender fallback fired,
 * and ownership bound to HomeLight's own alert line (Amy C., 2026-08-14).
 *
 * The definition cannot drift that way: whether a flow handles lead phones
 * is settled before step 0 and answers the same at every step.
 *
 * Deliberately a plain substring scan over every key and string value rather
 * than an enumeration of the var-declaring schema keys (`fields[].name`,
 * `saveAs`, `set.to`, ...). Those keys grow with every new step type, and a
 * scan that silently misses one re-opens this exact bug. A flow that so much
 * as mentions the var is dealing in lead phones; the cost of that being too
 * eager is one unnecessary team race, against a lead silently assigned to
 * the wrong teammate.
 *
 * Pure, and total: any non-object input is "no".
 */
export function flowDealsInLeadPhone(definition: unknown): boolean {
  if (!definition || typeof definition !== "object") return false;
  const stack: unknown[] = [definition];
  while (stack.length > 0) {
    const node = stack.pop();
    if (typeof node === "string") {
      if (node.includes(LEAD_PHONE_TOKEN)) return true;
      continue;
    }
    if (!node || typeof node !== "object") continue;
    if (Array.isArray(node)) {
      stack.push(...node);
      continue;
    }
    for (const [key, value] of Object.entries(node)) {
      if (key.includes(LEAD_PHONE_TOKEN)) return true;
      stack.push(value);
    }
  }
  return false;
}

/**
 * Which phone may OWNERSHIP bind to for this run?
 *
 * The rule, learned from Danfar (HomeLight, 2026-08-10) and hardened after
 * Amy C. (2026-08-14): when the flow deals in lead phone numbers at all, the
 * lead's number is whatever extraction found, and anything else (not yet
 * extracted, or extracted empty) means "the lead's number is unknown", never
 * "the sender is the lead". HomeLight withholds the real number until after
 * claiming, so the sender is HomeLight's own alert line; binding ownership
 * to it made Dave the "owner" of the HomeLight partner contact on Friday's
 * claim, and the next referral was then owner-assigned to him without the
 * three-way race.
 *
 * Only a flow that never deals in lead_phone at all may treat the triggering
 * sender as the lead, which is the customer-texts-in case where that is
 * literally true. Callers decide that with `flowDealsInLeadPhone` over the
 * flow definition, OR'd with the runtime key check so a run whose definition
 * is unavailable still gets the older, narrower protection.
 *
 * Pure: callers pass their own normalized values.
 */
export function ownershipLeadPhone(
  dealsInLeadPhone: boolean,
  extractedE164: string | null,
  triggerE164: string | null
): string | null {
  if (dealsInLeadPhone) return extractedE164;
  return extractedE164 ?? triggerE164;
}
