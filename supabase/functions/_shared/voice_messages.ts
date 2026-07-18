/** Short IVR copy for §6 failure paths (MIN_GRANT = 60s in plan). Single source for Edge + app. */
import { edgeMessage, type EdgeLocale } from "./edge_messages.ts";

export const VOICE_MSG_UNCONFIGURED_NUMBER = edgeMessage("VOICE_MSG_UNCONFIGURED_NUMBER");
export const VOICE_MSG_QUOTA_EXHAUSTED = edgeMessage("VOICE_MSG_QUOTA_EXHAUSTED");
export const VOICE_MSG_AI_BUDGET_EXHAUSTED = edgeMessage("VOICE_MSG_AI_BUDGET_EXHAUSTED");
export const VOICE_MSG_BRIDGE_DEGRADED = edgeMessage("VOICE_MSG_BRIDGE_DEGRADED");
export const VOICE_MSG_SYSTEM_ERROR = edgeMessage("VOICE_MSG_SYSTEM_ERROR");
export const VOICE_MSG_CONCURRENT_LIMIT = edgeMessage("VOICE_MSG_CONCURRENT_LIMIT");
export const VOICE_MSG_STREAM_ROLLOUT_DISABLED = edgeMessage("VOICE_MSG_STREAM_ROLLOUT_DISABLED");
export const VOICE_MSG_PAUSED = edgeMessage("VOICE_MSG_PAUSED");
export const VOICE_MSG_SAFE_MODE_CONNECTING = edgeMessage("VOICE_MSG_SAFE_MODE_CONNECTING");
export const VOICE_MSG_SAFE_MODE_FORWARD_FAILED = edgeMessage("VOICE_MSG_SAFE_MODE_FORWARD_FAILED");

/** Localized IVR copy for system speak paths (uses business default when live detection unavailable). */
export function voiceMessageForLocale(
  key:
    | "VOICE_MSG_UNCONFIGURED_NUMBER"
    | "VOICE_MSG_QUOTA_EXHAUSTED"
    | "VOICE_MSG_AI_BUDGET_EXHAUSTED"
    | "VOICE_MSG_BRIDGE_DEGRADED"
    | "VOICE_MSG_SYSTEM_ERROR"
    | "VOICE_MSG_CONCURRENT_LIMIT"
    | "VOICE_MSG_STREAM_ROLLOUT_DISABLED"
    | "VOICE_MSG_PAUSED"
    | "VOICE_MSG_SAFE_MODE_CONNECTING"
    | "VOICE_MSG_SAFE_MODE_FORWARD_FAILED",
  locale: "en" | "es" = "en"
): string {
  return edgeMessage(key, locale);
}
