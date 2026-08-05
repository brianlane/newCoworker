/**
 * Billable text units for one outbound message (Deno lockstep copy).
 *
 * Mirror of `smsTextUnits` in `src/lib/sms/segment-info.ts`; edge functions
 * cannot import src/, so the segment math is duplicated here and the fixture
 * matrix in tests/worker-integration keeps the two in agreement. Rationale
 * lives with the `weighted_sms_metering` migration: Telnyx bills SMS per
 * PART (GSM-7 160/153 chars, UCS-2 70/67) and an MMS as one flat message at
 * ~2.2x the blended per-part cost, so the monthly cap charges
 * parts-per-message for SMS and MMS_TEXT_UNITS for anything carrying media.
 *
 * Compute on the FINAL body handed to Telnyx (after gsmSafeSmsText or any
 * other normalization), matching what the carrier actually bills. Pass the
 * same value to the reserve/meter RPC and to any matching release.
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
