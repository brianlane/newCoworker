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

/**
 * Nothing to tag: say so rather than leaving the teammate wondering.
 *
 * The wording matters more than it looks. The first version read "No recent
 * lead here matches X", which a teammate reads as WE HAVE NEVER HEARD OF X,
 * and Amy hit exactly that on a HomeLight referral we knew all about and had
 * texted her about four minutes earlier (Rhonda J., Aug 28 2026). The lead was
 * real; it simply had no contact row yet. So this text now says what was
 * actually searched (contacts on file) and what to do about it, and the
 * "we know them, their details just have not landed" case has its own text
 * below rather than sharing this one.
 */
export function followUpNoLeadText(name: string): string {
  return name.trim()
    ? `I don't have a contact on file for "${name.trim()}" yet, so there's nothing to ` +
        "mark for follow-up. If they came from a referral site, their details may " +
        "not have been released to us yet. Try again once you see them on the dashboard."
    : "I don't have a recent contact on file to mark for follow-up.";
}

/**
 * We KNOW this lead, we just do not have their contact details yet.
 *
 * The referral networks withhold a lead's phone and email until the claim is
 * confirmed on their side, so there is a window, minutes to hours, where the
 * lead exists to us only as a live flow run. Answering "no lead matches" in
 * that window is technically true and completely useless, so the request is
 * parked on the run instead and applied the moment the details land.
 */
export function followUpPendingText(name: string): string {
  return `${name} is claimed but the referral site hasn't released their contact ` +
    "details to us yet, so there's no one to call yet. I've noted the request: the " +
    "moment their details land they go straight into follow-up, and I'll text you " +
    "to confirm. Nothing else for you to do.";
}

/**
 * The parked request just fired: the details landed and the lead is enrolled.
 *
 * Sent to the teammate who asked, not the owner. They asked minutes or hours
 * ago and have no other way to learn that the thing they asked for happened.
 */
export function followUpAppliedText(name: string): string {
  return `${name}'s contact details just came through, so they're now marked for ` +
    "follow-up as you asked. The AI will call every 3 days, leave a voicemail and " +
    "text if there's no answer, and stop the moment they reply.";
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

/**
 * ---------------------------------------------------------------------------
 * Leads that exist only as a live run
 * ---------------------------------------------------------------------------
 *
 * A referral network withholds the lead's phone and email until the claim is
 * confirmed on ITS side, so between "we told you about Rhonda" and "we have a
 * contact row for Rhonda" there is a gap. Amy's gap on Aug 28 2026 was 38
 * minutes, and both of her "F, Rhonda" texts landed inside it. The contacts
 * table genuinely had no Rhonda, so the reply was true and useless.
 *
 * During that gap the lead DOES exist to us: it is `vars.lead_name` on a live
 * ai_flow_run. So a follow-up request that matches no contact is matched
 * against those runs instead and PARKED on the winning run, as a var. The
 * worker's upsert_customer step, the step that finally files the contact,
 * reads the marker and applies the tag then.
 *
 * Parking on the run rather than in a table of its own is deliberate: the
 * request is only meaningful while that run is alive, a run's context is
 * already the durable place its facts live, and it needs no sweep to expire.
 */

/** Var names the parked request rides in. Read by the worker, written by SMS. */
export const FOLLOW_UP_PENDING_BY_VAR = "__follow_up_requested_by";
export const FOLLOW_UP_PENDING_NAME_VAR = "__follow_up_requested_name";
/** Set once the parked request has been applied, so it can never fire twice. */
export const FOLLOW_UP_PENDING_DONE_VAR = "__follow_up_requested_applied";

/** A live run as the pending-follow-up lookup reads it. */
export type FollowUpRunRow = {
  id: string;
  revision: number;
  context?: { vars?: Record<string, unknown> | null } | null;
};

/** A live run a follow-up request could be about. */
export type FollowUpRunCandidate = {
  runId: string;
  revision: number;
  /** The lead's name as the run knows it, never "". */
  leadName: string;
  /** A request is already parked on this run. */
  alreadyPending: boolean;
};

/**
 * Which live runs name a lead we could park a follow-up request on.
 *
 * A run only qualifies when it names a lead AND has not already filed one: a
 * run whose `lead_phone` is a real number has, or is about to have, a contact
 * row, and the contact path is the correct one for it. Parking on a run that
 * already knows the number would make the request wait for a step that has
 * already run.
 *
 * "none" is the flows' spelling of "not known yet" (an extraction that found
 * nothing writes the literal string), so it is read as absent, not as a name.
 * Order is preserved so the caller's newest-first query stays newest-first.
 */
export function followUpRunCandidatesFrom(
  rows: readonly FollowUpRunRow[]
): FollowUpRunCandidate[] {
  const out: FollowUpRunCandidate[] = [];
  for (const r of rows) {
    const vars = r.context?.vars ?? {};
    const leadName = flowVarText(vars.lead_name) || flowVarText(vars.lead_first_name);
    if (!leadName) continue;
    // Already has a number: its contact row exists or is one step away, so the
    // ordinary contact match is the right path and this one would only delay.
    if (flowVarText(vars.lead_phone)) continue;
    out.push({
      runId: r.id,
      revision: r.revision,
      leadName,
      alreadyPending: flowVarText(vars[FOLLOW_UP_PENDING_BY_VAR]) !== ""
    });
  }
  return out;
}

/**
 * A flow var as text, with the flows' own "absent" spellings folded to "".
 *
 * Extraction steps write the literal string "none" (and occasionally "unknown"
 * or "n/a") when they find nothing, so a raw truthiness check would read
 * `lead_phone: "none"` as "we have their number" and skip a lead we can
 * genuinely help. Same trap the phone-named-field rule exists for.
 */
function flowVarText(value: unknown): string {
  if (typeof value !== "string") return "";
  const t = value.trim();
  if (!t) return "";
  const lowered = t.toLowerCase();
  if (lowered === "none" || lowered === "unknown" || lowered === "n/a") return "";
  return t;
}

export type FollowUpRunMatch =
  | { kind: "none" }
  | { kind: "one"; run: FollowUpRunCandidate }
  | { kind: "ambiguous"; runs: FollowUpRunCandidate[] };

/**
 * Pick which live run a follow-up request meant.
 *
 * Same name rule as the contact matcher (accents folded, whole first name or
 * surname), for the same reason: a teammate should not have to learn which of
 * two lookups their text is about to hit. With no name the newest live run
 * wins, which is only reachable when no contact matched either, so it means
 * "the lead you just told me about".
 */
export function matchFollowUpRun(
  candidates: readonly FollowUpRunCandidate[],
  name: string
): FollowUpRunMatch {
  if (candidates.length === 0) return { kind: "none" };
  const needle = normalizeLeadName(name);
  if (!needle) return { kind: "one", run: candidates[0]! };
  const hits = candidates.filter((c) => {
    const full = normalizeLeadName(c.leadName);
    if (!full) return false;
    if (full === needle) return true;
    return full.split(" ").some((part) => part === needle);
  });
  if (hits.length === 0) return { kind: "none" };
  if (hits.length === 1) return { kind: "one", run: hits[0]! };
  return { kind: "ambiguous", runs: hits };
}

/** The run context with a follow-up request parked on it. */
export function withPendingFollowUp(
  context: Record<string, unknown> | null | undefined,
  args: { requestedBy: string; leadName: string }
): Record<string, unknown> {
  const base = context && typeof context === "object" ? { ...context } : {};
  const vars =
    base.vars && typeof base.vars === "object"
      ? { ...(base.vars as Record<string, unknown>) }
      : {};
  vars[FOLLOW_UP_PENDING_BY_VAR] = args.requestedBy;
  vars[FOLLOW_UP_PENDING_NAME_VAR] = args.leadName;
  base.vars = vars;
  return base;
}

/**
 * A request parked on this run that has not been applied yet, if any.
 *
 * Read by the worker at the moment it files the contact. The done-marker is
 * checked here rather than at the call site so a re-claimed or retried
 * upsert_customer step can never enroll the same lead twice, which would mean
 * two cadences calling one person.
 */
export function pendingFollowUpFrom(
  vars: Record<string, unknown> | null | undefined
): { requestedBy: string; leadName: string } | null {
  const v = vars ?? {};
  if (v[FOLLOW_UP_PENDING_DONE_VAR] === true) return null;
  const requestedBy = flowVarText(v[FOLLOW_UP_PENDING_BY_VAR]);
  if (!requestedBy) return null;
  return { requestedBy, leadName: flowVarText(v[FOLLOW_UP_PENDING_NAME_VAR]) };
}

/** Ask which live lead when a name fit more than one. */
export function followUpRunAmbiguityText(names: readonly string[]): string {
  return `Which one needs follow-up? Reply with the full name and F, e.g. "${names[0]}, F". Matching: ${names.join("; ")}`;
}
