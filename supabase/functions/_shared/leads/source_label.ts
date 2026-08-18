/**
 * Where a lead came from, as a short label for the Tasks Data view's SOURCE
 * column.
 *
 * Webhook leads carry an upstream label already (`lead_submissions.source` =
 * "facebook_lead_ads", "zapier", ...). Leads that arrive as SMS, voice or a
 * referral-network text do not, but the AiFlow that filed them names the
 * source perfectly well: "Clever Lead - Accept", "HomeLight Referral",
 * "ReferralExchange Lead", "Realtor.com Lead + Reply forward". So the flow
 * name IS the signal, and this trims it down to the vendor.
 *
 * Deliberately conservative, one cut and at most one stripped word, so a
 * flow the heuristic does not recognize degrades to its own name rather than
 * to something wrong. "New Lead Intake" stays "New Lead Intake" instead of
 * collapsing to "New".
 */

/** Matches the clamp `recordLeadSubmission` applies to its own source. */
export const MAX_LEAD_SOURCE_LENGTH = 120;

/**
 * Separators that mark where the vendor name ends and the flow's own
 * purpose begins: "Clever Lead - Accept", "Realtor.com Lead + Reply
 * forward", "Voice routing (Clever Jake)".
 */
const SEPARATORS = [" - ", " + ", " ("];

/**
 * Generic words a flow name appends to the vendor. Stripped from the END
 * only, and only one of them, so "HomeLight Referral" becomes "HomeLight"
 * while "New Lead Intake" is untouched (its trailing word is "Intake").
 */
const GENERIC_TRAILING = new Set(["lead", "leads", "referral", "referrals"]);

export function leadSourceLabel(input: {
  /** Name of the AiFlow that filed the lead. */
  flowName: string;
  /** An explicit label, when a caller knows better than the flow name. */
  explicit?: string | null;
}): string | null {
  const explicit = (input.explicit ?? "").trim();
  if (explicit) return explicit.slice(0, MAX_LEAD_SOURCE_LENGTH);

  const flowName = (input.flowName ?? "").trim();
  if (!flowName) return null;

  // Cut at the earliest separator present.
  let head = flowName;
  for (const sep of SEPARATORS) {
    const at = head.indexOf(sep);
    if (at > 0) head = head.slice(0, at);
  }

  // Strip at most one generic trailing word.
  const words = head.trim().split(/\s+/).filter((w) => w.length > 0);
  if (words.length > 1 && GENERIC_TRAILING.has(words[words.length - 1].toLowerCase())) {
    words.pop();
  }

  // `words` is never empty here: `head` starts non-empty (separators only cut
  // at index > 0) and the generic-word pop only runs when more than one word
  // remains, which is what keeps "Lead" and "Referral" intact.
  return words.join(" ").slice(0, MAX_LEAD_SOURCE_LENGTH);
}
