/**
 * Voice zone matcher + tenant allowance weight.
 *
 * Implementation lives in `supabase/functions/_shared/voice_zone_rates.ts`
 * so hangup settlement (Deno) and the dashboard (Next.js) cannot drift.
 * This file re-exports the production Next.js surface. Duration-gated
 * weight helpers (`voiceAllowanceWeight`, the short-leg cap, etc.) stay
 * on the _shared module: hangup and SQL own that path, not the dashboard.
 */

export {
  NANP_BASELINE_CENTS_PER_MINUTE,
  VOICE_ALLOWANCE_WEIGHT_STORE_MAX,
  blendedVoiceTerminationRate,
  parseDestinationList,
  telnyxTerminatingLrnFromFields,
  voiceAllowanceRawWeight,
  voiceZoneFor,
  type VoiceZoneDestination
} from "../../../supabase/functions/_shared/voice_zone_rates";
