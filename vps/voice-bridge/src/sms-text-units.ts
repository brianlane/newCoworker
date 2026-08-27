/**
 * Billable text units for one outbound message (voice-bridge lockstep copy).
 *
 * Third copy of `smsTextUnits`, after `src/lib/sms/segment-info.ts` and the
 * Deno mirror in `supabase/functions/_shared/sms_text_units.ts`: the bridge
 * is its own package and can import neither. The three-way boundary matrix
 * in `tests/sms-segment-info.test.ts` keeps all copies in agreement.
 *
 * Why the bridge needs it at all: #1189 re-denominated the enforced SMS
 * ledger in carrier PARTS (GSM-7 160/153 chars per part, UCS-2 70/67, MMS
 * flat 2.2), and every sender passes its own part count to the meter RPC.
 * The bridge was the last sender still metering a flat 1 per send, so a
 * 3000-char intake-summary SMS (about 20 GSM parts, or ~45 UCS-2 parts for
 * a Spanish transcript) recorded as one unit against the cap and consumed
 * one purchased bonus text instead of twenty.
 *
 * Compute on the FINAL body handed to Telnyx and pass the same value to the
 * meter RPC.
 */

const GSM_SINGLE_SEGMENT = 160;
const GSM_MULTI_SEGMENT = 153;
const UCS2_SINGLE_SEGMENT = 70;
const UCS2_MULTI_SEGMENT = 67;

/** Flat units per MMS; see MMS_TEXT_UNITS in src/lib/sms/segment-info.ts. */
export const MMS_TEXT_UNITS = 2.2;

/** Carrier part count for an SMS body (0 for an empty string). */
export function smsSegmentCount(text: string): number {
  const length = text.length;
  if (length === 0) return 0;
  // Same conservative test as gsmSafeSmsText: any non-ASCII char forces
  // UCS-2 encoding for the whole message.
  const hasNonGsmChars = /[^\x00-\x7F]/.test(text);
  const single = hasNonGsmChars ? UCS2_SINGLE_SEGMENT : GSM_SINGLE_SEGMENT;
  const multi = hasNonGsmChars ? UCS2_MULTI_SEGMENT : GSM_MULTI_SEGMENT;
  return length <= single ? 1 : Math.ceil(length / multi);
}

/**
 * Units the meter charges for one outbound message: parts for SMS (min 1),
 * MMS_TEXT_UNITS when any media is attached (caption adds nothing; Telnyx
 * bills the whole MMS as one message).
 */
export function smsTextUnits(text: string, opts?: { mediaCount?: number }): number {
  if ((opts?.mediaCount ?? 0) > 0) return MMS_TEXT_UNITS;
  return Math.max(1, smsSegmentCount(text));
}
