/**
 * Voice zone matcher + tenant allowance weight.
 *
 * Implementation lives in `supabase/functions/_shared/voice_zone_rates.ts`
 * so hangup settlement (Deno) and the dashboard (Next.js) cannot drift.
 * This file re-exports that copy. See the _shared module for the rationale
 * (LRN vs dialed NPA, weighted units like SMS, cap 20).
 */

export {
  NANP_BASELINE_CENTS_PER_MINUTE,
  VOICE_ALLOWANCE_WEIGHT_CAP,
  blendedVoiceTerminationRate,
  parseDestinationList,
  telnyxTerminatingLrnFromFields,
  voiceAllowanceWeight,
  voiceZoneFor,
  type VoiceZoneDestination
} from "../../../supabase/functions/_shared/voice_zone_rates";
