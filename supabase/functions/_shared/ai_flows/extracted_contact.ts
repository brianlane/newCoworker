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
 * Clear every extracted field whose value is one of the business's own phone
 * numbers. Non-phone values (names, addresses, emails, "none") are never
 * touched — only a value that PARSES to a phone and MATCHES a self number is
 * discarded, so a legitimate lead phone always survives.
 */
export function scrubSelfPhones(
  values: Record<string, string>,
  selfNumbers: readonly string[]
): ScrubResult {
  const self = new Set(
    selfNumbers
      .map((n) => toE164(n))
      .filter((n): n is string => Boolean(n))
  );
  const out: Record<string, string> = {};
  const cleared: string[] = [];
  for (const [name, value] of Object.entries(values)) {
    const normalized = toE164(value);
    if (normalized && self.has(normalized)) {
      out[name] = "";
      cleared.push(name);
    } else {
      out[name] = value;
    }
  }
  return { values: out, cleared };
}
