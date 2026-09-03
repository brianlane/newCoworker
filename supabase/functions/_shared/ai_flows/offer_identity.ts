/**
 * Which lead is an offer about, and which lead did a teammate just name?
 *
 * The problem this solves. A teammate holding two live offers who replies a
 * bare "1" claims whichever run row was touched most recently
 * (`findLiveOfferRunFor` orders by `updated_at desc limit 1`). "Most recently
 * touched" is usually the newest offer but not always: an escalation re-park
 * or a quiet-hours deferral updates an OLDER run and moves it to the front.
 * Nothing is texted back on a claim, so the teammate cannot tell which lead
 * they took. The pre-existing heads-up line told them to "reply 1 twice to
 * take both", which is a workaround for the ambiguity, not a fix.
 *
 * The fix is to let them SAY which lead: "1, Daniel". That text shares its
 * slot with the claim ETA ("1, 20 min"), which is why matching is tried
 * against the teammate's own live leads FIRST and only falls through to the
 * ETA parser when nothing matches. No lead is named "20 min", so every
 * existing reply keeps its meaning.
 *
 * Uses the shared E.164 helper so 10-digit NANP and +1 forms are one lead.
 */

import { e164CollapseKey } from "../normalize_e164.ts";

/**
 * Var names a flow may keep the lead's display name under, most specific
 * first. Every current lead flow uses `lead_name`; the rest are here so a
 * flow authored to a different convention still gets a usable label instead
 * of silently falling back to the phone number.
 *
 * The first-name-only vars come LAST so a run carrying both still labels
 * itself with the full name. They are not optional extras: HomeLight Referral
 * captures nothing but `lead_first_name`, so until it was listed here that
 * flow's leads had no label at all, which made them unnameable in a
 * "1, <name>" reply and invisible in the "which one?" list. A teammate typed
 * "1, Nancy" for exactly such a lead and claimed a different one (Amy
 * Laidlaw, Aug 2026).
 */
export const LEAD_NAME_VARS = [
  "lead_name",
  "customer_name",
  "contact_name",
  "client_name",
  "seller_name",
  "buyer_name",
  "name",
  "lead_first_name",
  "first_name"
] as const;

/** Var names a flow may keep the lead's phone under, most specific first. */
export const LEAD_PHONE_VARS = ["lead_phone", "customer_phone", "contact_phone", "phone"] as const;

/** Placeholder values extraction steps emit when a field was not found. */
const EMPTY_VALUES = new Set(["", "none", "not given", "unknown", "n/a", "na", "null"]);

function firstUsableVar(
  vars: Record<string, unknown> | undefined,
  names: readonly string[]
): string {
  if (!vars) return "";
  for (const name of names) {
    const raw = vars[name];
    if (typeof raw !== "string") continue;
    const value = raw.trim();
    if (!value || EMPTY_VALUES.has(value.toLowerCase())) continue;
    return value;
  }
  return "";
}

/** The lead's display name for this run, or "" when the flow never captured one. */
export function leadLabelFromVars(vars: Record<string, unknown> | undefined): string {
  return firstUsableVar(vars, LEAD_NAME_VARS);
}

/** The lead's phone for this run, or "" when the flow never captured one. */
export function leadPhoneFromVars(vars: Record<string, unknown> | undefined): string {
  return firstUsableVar(vars, LEAD_PHONE_VARS);
}

/**
 * The shortest thing a teammate would actually type: the lead's first name.
 * Used only to SUGGEST a reply ("Reply 1, Daniel"); matching accepts far more
 * than this, so a teammate who types the surname or the full name is fine.
 */
export function leadShortLabel(label: string): string {
  const trimmed = label.trim();
  const space = trimmed.search(/\s/);
  return space === -1 ? trimmed : trimmed.slice(0, space);
}

/**
 * Fold a name to its comparable form: lowercase, accents removed, punctuation
 * flattened to spaces. Accents matter here because a lead entered as "Muñoz"
 * gets typed back as "Munoz" by a teammate on a phone keyboard.
 */
export function normalizeLeadName(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** One live offer a reply could be answering. */
export type OfferCandidate = {
  runId: string;
  /** Display name of the lead this offer is about; "" when unknown. */
  leadLabel: string;
  /** Lead phone, used only to tell two identically-named leads apart. */
  leadPhone?: string;
};

export type OfferNameMatch =
  | { kind: "one"; runId: string; label: string }
  /** Two or more leads answer to what they typed; `labels` is display-ready. */
  | { kind: "ambiguous"; labels: string[] }
  | { kind: "none" };

/** Last four digits, for telling two leads with the same name apart. */
function last4(phone: string | undefined): string {
  const digits = (phone ?? "").replace(/\D/g, "");
  return digits.length >= 4 ? digits.slice(-4) : "";
}

/**
 * Display labels for an ambiguous set. Identical names are suffixed with the
 * last four digits of the phone, because otherwise the question we text back
 * ("Daniel Villanueva or Daniel Villanueva?") is unanswerable.
 */
function displayLabels(candidates: OfferCandidate[]): string[] {
  const seen = new Set<string>();
  const duplicated = new Set<string>();
  for (const c of candidates) {
    const key = normalizeLeadName(c.leadLabel);
    if (seen.has(key)) duplicated.add(key);
    else seen.add(key);
  }
  return candidates.map((c) => {
    const tail = last4(c.leadPhone);
    // No phone to disambiguate with: the bare name is still the most useful
    // thing we can say, even though it will read as a repeat.
    return duplicated.has(normalizeLeadName(c.leadLabel)) && tail
      ? `${c.leadLabel} (...${tail})`
      : c.leadLabel;
  });
}

function phoneKey(phone: string | undefined): string {
  return e164CollapseKey(phone);
}

/**
 * One row per phone, keeping the first (callers pass newest-first, offers
 * before alerts before bookings).
 *
 * Unowned-lead alerts stack: each `notify_team` ping inserts a new 24h
 * row for the same number, so a teammate who replies "1" sees
 * "Christopher Ackermann or Christopher Ackermann" (Jason Lane, 2026-09-02).
 * Claiming already retires sibling rows; the ask-back and the named matcher
 * did not. Same-phone offer + alert is the other shape of the same miss.
 *
 * Phoneless rows are left as-is. Two bookings for the same attendee are
 * different appointments and must both stay listable.
 */
export function collapseOfferCandidates(
  candidates: readonly OfferCandidate[]
): OfferCandidate[] {
  const kept: OfferCandidate[] = [];
  const seenPhone = new Set<string>();
  for (const c of candidates) {
    const phone = phoneKey(c.leadPhone);
    if (phone) {
      if (seenPhone.has(phone)) continue;
      seenPhone.add(phone);
    }
    kept.push(c);
  }
  return kept;
}

/**
 * Labels for a "which one?" SMS. Blank names get a placeholder; identical
 * names that survived collapse (two people, two phones) get last-four digits.
 */
export function askBackLabels(candidates: readonly OfferCandidate[]): string[] {
  return displayLabels([...candidates]).map(
    (label, i) => label.trim() || `lead ${i + 1} (no name on file)`
  );
}

/**
 * Resolve what a teammate typed after "1," against their own live offers.
 *
 * Two passes, exact before partial, so a lead named "Dan" is reachable even
 * while "Daniel" is also pending: typing "Dan" hits the exact rung and never
 * reaches the partial rung where both would match. Partial accepts either a
 * substring of the whole name ("villanueva", "daniel v") or any name part
 * starting with the query ("dan" matches "Daniel"), which is what makes
 * first-name and surname replies both work.
 *
 * Candidates whose lead name was never captured are skipped rather than
 * matched loosely: an offer with no name cannot be the one they meant by
 * name.
 */
export function matchOfferByLeadName(
  candidates: readonly OfferCandidate[],
  query: string
): OfferNameMatch {
  const q = normalizeLeadName(query);
  if (!q) return { kind: "none" };
  const scored = candidates
    .map((c) => ({ c, n: normalizeLeadName(c.leadLabel) }))
    .filter((x) => x.n.length > 0);
  if (scored.length === 0) return { kind: "none" };

  const exact = scored.filter((x) => x.n === q);
  if (exact.length === 1) return { kind: "one", runId: exact[0].c.runId, label: exact[0].c.leadLabel };
  if (exact.length > 1) return { kind: "ambiguous", labels: displayLabels(exact.map((x) => x.c)) };

  const partial = scored.filter(
    (x) => x.n.includes(q) || x.n.split(" ").some((token) => token.startsWith(q))
  );
  if (partial.length === 1) {
    return { kind: "one", runId: partial[0].c.runId, label: partial[0].c.leadLabel };
  }
  if (partial.length > 1) return { kind: "ambiguous", labels: displayLabels(partial.map((x) => x.c)) };
  return { kind: "none" };
}

/** Join display labels for a question: "A, B or C". */
export function joinLabels(labels: readonly string[]): string {
  if (labels.length <= 1) return labels[0] ?? "";
  return `${labels.slice(0, -1).join(", ")} or ${labels[labels.length - 1]}`;
}

/**
 * Texted back when a reply could mean more than one of the teammate's leads.
 * Nothing is claimed: assigning the wrong seller to the wrong agent is the
 * failure this whole change exists to prevent, so we ask instead of guess.
 */
export function ambiguousClaimText(labels: readonly string[]): string {
  return (
    `Which one? ${joinLabels(labels)}. ` +
    'Reply "1, <name>" with a bit more of the name and it is yours.'
  );
}

/**
 * Texted back when a BARE "1" arrives while several leads are pending. Same
 * reasoning as above: with more than one live offer, a lone digit does not
 * say which lead, and the old behavior silently picked one.
 */
export function bareDigitAmbiguityText(labels: readonly string[]): string {
  return (
    `You have ${labels.length} unclaimed leads: ${joinLabels(labels)}. ` +
    'Reply "1, <name>" to say which one you are taking.'
  );
}

/**
 * Confirmation after a claim that involved more than one candidate. Sent only
 * in that case: a teammate with a single offer already knows what they took,
 * and acking every claim fleet-wide would be a new text per lead per tenant.
 */
export function claimAckText(label: string): string {
  return `Got it, ${label} is yours.`;
}

/**
 * Texted back when a teammate named a lead we cannot find among the ones they
 * could still claim. Nothing is claimed: the whole point of the named form is
 * that it says WHICH lead, so failing to find it means we know less than a
 * bare "1" would have told us, not more.
 *
 * `claimedElsewhere` turns the most common cause into a straight answer: they
 * replied a few minutes after a teammate took that exact lead.
 */
export function unmatchedClaimText(
  query: string,
  labels: readonly string[],
  claimedElsewhere?: { label: string; claimedName: string }
): string {
  const taken = claimedElsewhere
    ? `${claimedElsewhere.label} was already claimed by ${claimedElsewhere.claimedName || "another teammate"}. `
    : `I could not find "${query}" in your unclaimed leads. `;
  if (labels.length === 0) {
    return `${taken}You have nothing else waiting right now.`;
  }
  const still = claimedElsewhere ? "You still have" : "You have";
  // With one lead left there is no "which one" to answer, so name it in the
  // instruction and make the reply a copy-paste.
  if (labels.length === 1) {
    return `${taken}${still} ${labels[0]}. Reply "1, ${leadShortLabel(labels[0])}" to take it.`;
  }
  return (
    `${taken}${still} ${labels.length} unclaimed leads: ${joinLabels(labels)}. ` +
    `Reply "1, <name>" to say which one you are taking.`
  );
}
