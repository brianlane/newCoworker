/**
 * SMS length/encoding introspection for composer UIs.
 *
 * Mirrors the carrier constraints encoded in
 * `supabase/functions/_shared/ai_flows/compliance.ts`: one non-GSM character
 * (an emoji, a smart quote, any non-ASCII symbol) forces UCS-2 encoding for
 * the WHOLE message — 70/67 chars per segment instead of 160/153 — and Telnyx
 * hard-rejects anything over 10 segments. 10 × 67 = 670 is therefore the
 * longest message containing an emoji that can be sent at all.
 *
 * The AiFlow worker reacts by downgrading emoji to ASCII emoticons (or
 * stripping them) so the text still sends; dashboard sends go to Telnyx
 * verbatim and would simply fail. This helper lets both UIs warn BEFORE the
 * user hits that wall.
 */

/** Longest UCS-2 message Telnyx will send (10 segments × 67 chars). */
export const UCS2_MAX_SENDABLE_CHARS = 670;

const GSM_SINGLE_SEGMENT = 160;
const GSM_MULTI_SEGMENT = 153;
const UCS2_SINGLE_SEGMENT = 70;
const UCS2_MULTI_SEGMENT = 67;

export type SmsSegmentInfo = {
  /** Character count as typed (JS string length, matching the worker's check). */
  length: number;
  /** Encoding the message forces at the carrier. */
  encoding: "gsm" | "ucs2";
  /** Approximate billable segment count (0 for an empty message). */
  segments: number;
  /** True when any character forces UCS-2 (emoji, smart quotes, symbols). */
  hasNonGsmChars: boolean;
  /**
   * True when the message needs UCS-2 AND is over the 670-char sendable cap:
   * verbatim sends will be rejected by Telnyx; AiFlow sends will have their
   * emoji converted to ASCII emoticons or stripped.
   */
  exceedsUcs2SendableLimit: boolean;
};

export type SmsSegmentInfoOptions = {
  /**
   * Apply the same smart-punctuation → ASCII normalization the AiFlow
   * worker's `gsmSafeSmsText` runs BEFORE its encoding check (curly quotes,
   * en/em dashes, ellipsis, nbsp). With it, a long message whose only
   * non-ASCII chars are smart punctuation is correctly reported as GSM —
   * the worker will normalize it and nothing gets stripped. Leave off for
   * verbatim sends, where those characters really do force UCS-2.
   */
  normalizeSmartPunctuation?: boolean;
};

/** Mirrors the normalization table in `_shared/ai_flows/compliance.ts`. */
function normalizeSmartPunctuation(text: string): string {
  return text
    .replace(/[\u2018\u2019\u02BC]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\u2026/g, "...")
    .replace(/\u00A0/g, " ");
}

export function smsSegmentInfo(text: string, opts: SmsSegmentInfoOptions = {}): SmsSegmentInfo {
  const effective = opts.normalizeSmartPunctuation ? normalizeSmartPunctuation(text) : text;
  const length = effective.length;
  // Same test the worker uses (`gsmSafeSmsText`): any non-ASCII char forces
  // UCS-2. Slightly conservative vs. the full GSM-7 alphabet (which includes
  // a few non-ASCII chars like é/ñ), which errs on the warning side.
  const hasNonGsmChars = /[^\x00-\x7F]/.test(effective);
  const single = hasNonGsmChars ? UCS2_SINGLE_SEGMENT : GSM_SINGLE_SEGMENT;
  const multi = hasNonGsmChars ? UCS2_MULTI_SEGMENT : GSM_MULTI_SEGMENT;
  const segments = length === 0 ? 0 : length <= single ? 1 : Math.ceil(length / multi);
  return {
    length,
    encoding: hasNonGsmChars ? "ucs2" : "gsm",
    segments,
    hasNonGsmChars,
    exceedsUcs2SendableLimit: hasNonGsmChars && length > UCS2_MAX_SENDABLE_CHARS
  };
}
