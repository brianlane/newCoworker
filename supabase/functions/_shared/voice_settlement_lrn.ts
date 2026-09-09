/**
 * LRN + zone-weight fields to stamp on a voice settlement at hangup.
 *
 * Hangup payloads usually omit Terminating LRN. When they do carry it
 * (or a term prefix), we store it and the allowance weight so finalize
 * can bill 14x for Payson Zone 5 instead of guessing from the dialed
 * NPA. `from` / `to` are never treated as LRN.
 */

import {
  telnyxTerminatingLrnFromFields,
  voiceAllowanceWeight
} from "./voice_zone_rates.ts";

export type VoiceSettlementLrnFields = {
  terminatingLrn: string | null;
  zoneWeight: number;
  callLegId: string | null;
};

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Read LRN, weight, and call_leg_id off a Telnyx hangup / MDR-shaped
 * payload. Missing LRN yields weight 1 (today's behavior).
 */
export function settlementMeteringFromHangupPayload(
  payload: Record<string, unknown> | null | undefined
): VoiceSettlementLrnFields {
  const terminatingLrn = telnyxTerminatingLrnFromFields(payload);
  const zoneWeight = terminatingLrn
    ? voiceAllowanceWeight(null, { lrn: terminatingLrn })
    : 1;
  const callLegId = payload ? nonEmptyString(payload["call_leg_id"]) : null;
  return { terminatingLrn, zoneWeight, callLegId };
}
