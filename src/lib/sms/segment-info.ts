/**
 * SMS length/encoding introspection for composer UIs.
 *
 * Mirrors the carrier constraints encoded in
 * `supabase/functions/_shared/ai_flows/compliance.ts`: one non-GSM character
 * (an emoji, a smart quote, any non-ASCII symbol) forces UCS-2 encoding for
 * the WHOLE message, 70/67 chars per segment instead of 160/153, and Telnyx
 * hard-rejects anything over 10 segments. 10 × 67 = 670 is therefore the
 * longest message containing an emoji that can be sent at all.
 *
 * The AiFlow worker reacts by downgrading emoji to ASCII emoticons (or
 * stripping them) so the text still sends; dashboard sends go to Telnyx
 * verbatim and would simply fail. This helper lets both UIs warn BEFORE the
 * user hits that wall.
 */

/**
 * Invisible characters that silently force UCS-2, replaced with a plain
 * space. The one that matters in practice is U+202F, the NARROW NO-BREAK
 * SPACE modern ICU puts before AM/PM: `Intl.DateTimeFormat` produces it in
 * every formatted clock time, so any message quoting a time carries it, and
 * one character outside GSM-7 re-encodes the WHOLE message, cutting the
 * per-segment budget from 153 to 67. Nothing looks wrong, the bill just
 * doubles (measured at $3.99/month on one tenant\'s offer sends).
 *
 * Use this on any time label that will be read back to a customer in a text.
 * It is deliberately narrow: emoji are NOT stripped here, because keeping
 * them is a deliverability policy the AiFlow sender owns.
 */
export function gsmSafeSpaces(text: string): string {
  return text.replace(/[\u202f\u00a0]/g, " ");
}

/** Longest UCS-2 message Telnyx will send (10 segments × 67 chars). */
export const UCS2_MAX_SENDABLE_CHARS = 670;

/**
 * Telnyx caps the RCS `sms_fallback.text` leg at 3072 characters; our senders
 * slice to this, so an over-long fallback is TRUNCATED (never rejected).
 */
export const RCS_SMS_FALLBACK_MAX_CHARS = 3072;

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
   * non-ASCII chars are smart punctuation is correctly reported as GSM,
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

/**
 * Billable text units an MMS consumes against the monthly cap.
 *
 * Telnyx bills an MMS as ONE message regardless of media size or caption
 * length (every outbound MMS MDR carries `parts: 1`), at ~2.2x the blended
 * per-part SMS cost measured Aug 2026 ($0.0192/MMS vs $0.008787/part). The
 * weight makes an all-MMS month cost the same dollars as an all-SMS month,
 * so media is never the cheap way past the cap. Keep in lockstep with
 * `supabase/functions/_shared/sms_text_units.ts` and the rationale in the
 * `weighted_sms_metering` migration.
 */
export const MMS_TEXT_UNITS = 2.2;

/**
 * Billable text units for one outbound message: the number the SMS meter
 * (`try_reserve_sms_outbound_slot` / `meter_sms_operational_send`) charges
 * against the tenant's monthly cap, and the number a matching release must
 * refund.
 *
 * SMS: one unit per carrier part (GSM-7 160/153, UCS-2 70/67), minimum 1 so
 * an empty or whitespace body still costs a slot like it always has.
 * MMS (any media attached): flat MMS_TEXT_UNITS; the caption does not add
 * parts because Telnyx bills the whole MMS as one message.
 *
 * Compute this on the FINAL body handed to Telnyx (after any worker-side
 * emoji/punctuation normalization), matching what the carrier actually
 * bills. Mirror of `smsTextUnits` in
 * `supabase/functions/_shared/sms_text_units.ts` (edge functions cannot
 * import src/).
 */
export function smsTextUnits(text: string, opts?: { mediaCount?: number }): number {
  if ((opts?.mediaCount ?? 0) > 0) return MMS_TEXT_UNITS;
  return Math.max(1, smsSegmentInfo(text).segments);
}
