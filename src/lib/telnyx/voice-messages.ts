/** Re-export IVR strings from Edge _shared (canonical copy for bundling). */
import {
  VOICE_MSG_BRIDGE_DEGRADED as _BRIDGE,
  VOICE_MSG_CONCURRENT_LIMIT as _CONC,
  VOICE_MSG_QUOTA_EXHAUSTED as _QUOTA,
  VOICE_MSG_STREAM_ROLLOUT_DISABLED as _ROLL,
  VOICE_MSG_SYSTEM_ERROR as _SYS,
  VOICE_MSG_UNCONFIGURED_NUMBER as _UNCONF
} from "../../../supabase/functions/_shared/voice_messages";

export const VOICE_MSG_UNCONFIGURED_NUMBER = _UNCONF;
export const VOICE_MSG_QUOTA_EXHAUSTED = _QUOTA;
export const VOICE_MSG_BRIDGE_DEGRADED = _BRIDGE;
export const VOICE_MSG_SYSTEM_ERROR = _SYS;
export const VOICE_MSG_CONCURRENT_LIMIT = _CONC;
export const VOICE_MSG_STREAM_ROLLOUT_DISABLED = _ROLL;
