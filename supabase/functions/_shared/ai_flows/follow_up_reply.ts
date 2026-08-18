/**
 * "F", a teammate marking a lead as needing AI follow-up, by text.
 *
 * Amy's team works leads from their phones, so the shortest thing they can
 * type has to be the thing that works. `F` (or "needs follow up", or any of the
 * wordings people actually use) tags the lead, and the tag is what starts the
 * follow-up cadence.
 *
 * TWO THINGS MAKE THIS DIFFERENT FROM THE "1"/"2" OFFER REPLIES, and both are
 * why this is its own module rather than another digit in that block:
 *
 *   1. It resolves against RECENT LEADS, not live offers. A claim reply only
 *      makes sense while an offer is parked awaiting an answer, roughly a
 *      15-minute window. "This lead needs following up" is something a teammate
 *      realizes after a call that went nowhere, days later. Matching only live
 *      offers would make the feature useless in its main case.
 *   2. It is not a digit, so it has to be recognized from prose. "F" is the
 *      short form, but people will type "needs follow up", "follow up",
 *      "f/u" and "needs f/u", and a reply that means the same thing should not
 *      depend on which one they reached for.
 *
 * The `<name>, F` form mirrors the existing `1, <name>` picker so there is one
 * convention to learn: the text before the comma names the lead.
 *
 * Pure and dependency-free (bar the shared name normalizer) so vitest can pin
 * it without booting Deno.
 */
import { normalizeLeadName } from "./offer_identity.ts";

/**
 * Wordings that mean "the AI should follow up with this lead".
 *
 * Anchored to whole words so an ordinary sentence cannot trip them: a lead
 * texting "I'd like to follow up on the offer" is a CUSTOMER message, and this
 * only ever runs against texts from a known roster number, but the narrower
 * the match the less there is to go wrong.
 */
const FOLLOW_UP_PHRASES = [
  "needs follow up",
  "needs followup",
  "needs follow-up",
  "need follow up",
  "needs f/u",
  "need f/u",
  "follow up",
  "followup",
  "follow-up",
  "f/u",
  "fu"
] as const;

/** Strip punctuation people add without thinking ("F.", "F!", "- F"). */
function tidy(raw: string): string {
  return raw.trim().replace(/^[\s\-–—:;,.]+/, "").replace(/[\s!.?]+$/, "").trim();
}

/**
 * Does this text, on its own, mean "needs AI follow-up"?
 *
 * A bare "F" counts; a longer sentence containing an f-word does not, because
 * the whole text has to BE the instruction. "F" is a single letter and the
 * cheapest thing in the world to type by accident, so it is only honored when
 * it is the entire message.
 */
export function meansFollowUp(text: string): boolean {
  const t = tidy(text).toLowerCase();
  if (!t) return false;
  if (t === "f") return true;
  return FOLLOW_UP_PHRASES.includes(t as (typeof FOLLOW_UP_PHRASES)[number]);
}

export type FollowUpReply = {
  /** The lead the teammate named, "" when they named none. */
  name: string;
};

/**
 * Read a teammate's follow-up instruction.
 *
 * Returns null when the text does not mean follow-up at all, so the caller
 * falls through to every other reply path unchanged.
 *
 * Accepted shapes:
 *   "F"                     -> most recent lead
 *   "needs follow up"       -> most recent lead
 *   "Daniel, F"             -> the lead named Daniel
 *   "F, Daniel"             -> same, because people type it both ways
 *
 * The name may sit on EITHER side of the comma. The existing claim picker only
 * accepts `1, <name>` because a leading "1" is unambiguous; here both halves
 * are prose, so whichever half is the instruction leaves the other as the name.
 */
export function parseFollowUpReply(text: string): FollowUpReply | null {
  const whole = tidy(text);
  if (!whole) return null;
  if (meansFollowUp(whole)) return { name: "" };

  const comma = whole.indexOf(",");
  if (comma === -1) return null;
  const left = tidy(whole.slice(0, comma));
  const right = tidy(whole.slice(comma + 1));
  if (!left || !right) return null;
  // Exactly one side must be the instruction. Both sides matching ("f, f/u")
  // names no lead and is not worth guessing at.
  if (meansFollowUp(right) && !meansFollowUp(left)) return { name: left };
  if (meansFollowUp(left) && !meansFollowUp(right)) return { name: right };
  return null;
}

/** A lead this teammate could plausibly have meant. */
export type FollowUpCandidate = {
  contactId: string;
  name: string;
  phone: string;
};

export type FollowUpTargetMatch =
  | { kind: "none" }
  | { kind: "one"; candidate: FollowUpCandidate }
  | { kind: "ambiguous"; candidates: FollowUpCandidate[] };

/**
 * Pick which recent lead a follow-up reply meant.
 *
 * With no name, the newest lead wins: that is what "F" replying to the thing
 * you were just looking at means. With a name, it matches the same way the
 * claim picker does (accents folded, first name or surname), and an ambiguous
 * name asks rather than guessing, because tagging the wrong lead starts a
 * three-day calling cadence at somebody who never asked for one.
 */
export function matchFollowUpTarget(
  candidates: readonly FollowUpCandidate[],
  name: string
): FollowUpTargetMatch {
  if (candidates.length === 0) return { kind: "none" };
  const needle = normalizeLeadName(name);
  if (!needle) return { kind: "one", candidate: candidates[0]! };

  const hits = candidates.filter((c) => {
    const full = normalizeLeadName(c.name);
    if (!full) return false;
    if (full === needle) return true;
    // Any whole word of the lead's name: "Daniel" and "Villanueva" both reach
    // Daniel Villanueva, which is how people refer to a lead in practice.
    return full.split(" ").some((part) => part === needle);
  });
  if (hits.length === 0) return { kind: "none" };
  if (hits.length === 1) return { kind: "one", candidate: hits[0]! };
  return { kind: "ambiguous", candidates: hits };
}

/** Confirmation text: which lead the teammate just put into follow-up. */
export function followUpAckText(name: string): string {
  const who = name.trim() || "that lead";
  return `Got it, ${who} is marked for follow-up. The AI will call every 3 days, leave a voicemail and text if there's no answer, and stop the moment they reply.`;
}

/** Ask which lead when a name fit more than one. */
export function followUpAmbiguityText(names: readonly string[]): string {
  return `Which one needs follow-up? Reply with the full name and F, e.g. "${names[0]}, F". Matching: ${names.join("; ")}`;
}

/** Nothing to tag: say so rather than leaving the teammate wondering. */
export function followUpNoLeadText(name: string): string {
  return name.trim()
    ? `No recent lead here matches "${name.trim()}", so nothing was marked for follow-up.`
    : "No recent lead to mark for follow-up.";
}

/** A contact row as the follow-up lookup reads it. */
export type FollowUpContactRow = {
  id: string;
  display_name?: string | null;
  customer_e164?: string | null;
  tags?: string[] | null;
  type?: string | null;
};

/**
 * Which recent contacts a follow-up reply may target.
 *
 * Shape only: drops rows with no number and the sender's own row, and carries
 * `type` through so the caller can hand it to staffNumberCheck. Deciding who
 * is staff is deliberately NOT done here, because that rule lives in one place
 * and three guards depend on it agreeing.
 *
 * Order is preserved, so the caller's newest-first query stays newest-first and
 * a bare "F" means the most recent lead.
 */
export function followUpCandidatesFrom(
  rows: readonly FollowUpContactRow[],
  opts: { senderE164: string }
): Array<FollowUpCandidate & { tags: string[]; type: string }> {
  const out: Array<FollowUpCandidate & { tags: string[]; type: string }> = [];
  for (const r of rows) {
    const phone = (r.customer_e164 ?? "").trim();
    // No number means nothing to call, and the sender can never enrol
    // themselves. Everything else about who counts as staff is decided by
    // staffNumberCheck, which reads the roster and the business's own derived
    // numbers; duplicating any of that here is how the two would drift apart.
    if (!phone || phone === opts.senderE164) continue;
    out.push({
      contactId: r.id,
      name: (r.display_name ?? "").trim(),
      phone,
      type: (r.type ?? "").trim().toLowerCase(),
      tags: Array.isArray(r.tags) ? r.tags : []
    });
  }
  return out;
}
