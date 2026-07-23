/**
 * Sanity filter for AI-extracted contact fields.
 *
 * Why: a page/email extraction can grab the BUSINESS'S OWN contact info
 * instead of the lead's — the Jul 7 HomeLight failure re-opened a claim
 * landing page with no lead card, and the extractor answered with Amy's name
 * and her Coworker DID. Downstream that junk became a bogus contact row, a
 * useless "lead is yours" text, and a lead_sms addressed to our own number
 * (Telnyx 40310, source == destination) that burned every retry.
 *
 * A lead's phone can never legitimately equal the business's own numbers, so
 * any extracted value that normalizes to one of them is treated as NOT
 * extracted (cleared to "") — which also re-opens the field for
 * email_extract's fillOnlyEmpty backfill.
 *
 * Pure (callers fetch the self-number list) so it unit-tests under the
 * shared 100% coverage gate.
 */
import { isE164, normalizeNanpToE164 } from "./engine.ts";

/** Normalize anything phone-ish to E.164, else null (non-phone values pass through). */
function toE164(value: string): string | null {
  const v = value.trim();
  if (!v) return null;
  return isE164(v) ? v : normalizeNanpToE164(v);
}

export type ScrubResult = {
  /** The field map with self-number values cleared to "". */
  values: Record<string, string>;
  /** Names of the fields that were cleared (for the actions_taken note). */
  cleared: string[];
};

/**
 * Does `value` parse to a phone that matches one of the business's own
 * numbers? BOTH sides are normalized to E.164 first — self numbers can be
 * stored in free-form shapes (businesses.phone is captured verbatim at
 * onboarding), and the compared value may arrive in page formatting. Shared
 * by the extraction scrub AND the worker's send_sms self-send guard so the
 * two can never disagree on what counts as "ourselves".
 */
export function isSelfPhone(value: string, selfNumbers: readonly string[]): boolean {
  const normalized = toE164(value);
  if (!normalized) return false;
  return selfNumbers.some((n) => toE164(n) === normalized);
}

/**
 * Clear every extracted field whose value is one of the business's own phone
 * numbers. Non-phone values (names, addresses, emails, "none") are never
 * touched — only a value that PARSES to a phone and MATCHES a self number is
 * discarded, so a legitimate lead phone always survives.
 */
export function scrubSelfPhones(
  values: Record<string, string>,
  selfNumbers: readonly string[]
): ScrubResult {
  const out: Record<string, string> = {};
  const cleared: string[] = [];
  for (const [name, value] of Object.entries(values)) {
    if (isSelfPhone(value, selfNumbers)) {
      out[name] = "";
      cleared.push(name);
    } else {
      out[name] = value;
    }
  }
  return { values: out, cleared };
}

/**
 * Self-NAME guard (Jul 22 2026 "Hi Amy" regression): the Clever group intro
 * mentions the tenant's own agent four times and the seller twice, and the
 * extractor answered "Amy" (our agent) for "the seller's first name" — the
 * canned greeting then addressed the seller by our own agent's name. Unlike
 * a self PHONE (never legitimate), a lead CAN genuinely share a name with
 * the owner or a roster member, so a match here doesn't clear the value —
 * it triggers ONE extraction retry with an explicit "that is our own
 * agent" hint (see the worker's extract_text step), and the retry's answer
 * wins only when it names someone else.
 */

/**
 * Is this extraction field asking for a PERSON's name (a lead, seller,
 * customer)? Fields that ask about OUR side (agent/owner/team) or about an
 * organization are excluded — retry-hinting those with "never our agent"
 * would push the model away from the correct answer.
 */
export function isPersonNameField(fieldName: string): boolean {
  const n = fieldName.toLowerCase();
  if (!/name/.test(n)) return false;
  return !/(agent|owner|team|employee|staff|business|company|office)/.test(n);
}

/**
 * Does `value` read as one of the business's own people? Matches the full
 * self name or its first name (case-insensitive, whitespace-collapsed) —
 * "Amy" and "Amy Laidlaw" both match self name "Amy Laidlaw"; "Amy Smith"
 * (a different person) does not.
 */
export function isSelfNameValue(value: string, selfNames: readonly string[]): boolean {
  const v = value.trim().replace(/\s+/g, " ").toLowerCase();
  if (!v) return false;
  for (const self of selfNames) {
    const full = self.trim().replace(/\s+/g, " ").toLowerCase();
    if (!full) continue;
    const first = full.split(" ")[0];
    if (v === full || v === first) return true;
  }
  return false;
}

/**
 * Should the retry's answer REPLACE the first-pass answer for a suspect
 * field? Only when it actually names someone else: non-empty, different from
 * the first answer, and not ITSELF one of our own names (a retry that
 * "corrects" "Amy" to "Amy Laidlaw" — or to another roster member — is
 * still the wrong party, so the first answer is kept and the telemetry
 * records the field as confirmed rather than corrected).
 */
export function acceptSelfNameRetryValue(
  first: string,
  second: string,
  selfNames: readonly string[]
): boolean {
  const s = second.trim();
  return s !== "" && s !== first.trim() && !isSelfNameValue(s, selfNames);
}

/**
 * Rebuild an extraction field list with the self-name retry hint appended to
 * the SUSPECT fields' descriptions (the ones whose first-pass answer matched
 * a self name). Other fields pass through untouched. Pure, so the exact
 * retry-prompt shape stays under unit test.
 */
export function withSelfNameRetryHint<F extends { name: string; description?: string }>(
  fields: readonly F[],
  suspectFieldNames: readonly string[],
  selfNames: readonly string[]
): F[] {
  const suspects = new Set(suspectFieldNames);
  const hint =
    `IMPORTANT: ${selfNames.join(", ")} is our own agent/business owner, ` +
    "NOT the subject of this field. Only answer with that name if the text " +
    "clearly shows the subject genuinely has the same name; otherwise " +
    "answer the actual subject's name.";
  return fields.map((f) =>
    suspects.has(f.name)
      ? { ...f, description: f.description ? `${f.description}. ${hint}` : hint }
      : f
  );
}
