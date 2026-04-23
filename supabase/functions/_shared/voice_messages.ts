/** Short IVR copy for §6 failure paths (MIN_GRANT = 60s in plan). Single source for Edge + app. */
export const VOICE_MSG_UNCONFIGURED_NUMBER =
  "This number is not configured for AI assistant service. Goodbye.";

export const VOICE_MSG_QUOTA_EXHAUSTED =
  "Sorry, included voice time for this billing period is used up. You can add more from your dashboard or reply by text message. Goodbye.";

export const VOICE_MSG_BRIDGE_DEGRADED =
  "Our voice assistant is temporarily unavailable. Please try again later or send a text message. Goodbye.";

export const VOICE_MSG_SYSTEM_ERROR =
  "We could not connect your call. Please try again later. Goodbye.";

/** §6: concurrent call cap — answer + speak (same class as quota UX). */
export const VOICE_MSG_CONCURRENT_LIMIT =
  "All of our lines are busy right now. Please try again in a few minutes or send a text message. Goodbye.";

/**
 * Rollout guard: VOICE_AI_STREAM_ENABLED=false on Edge skips Gemini stream and plays this instead.
 */
export const VOICE_MSG_STREAM_ROLLOUT_DISABLED =
  "AI voice is not available for this call right now. Please send a text message or try again later. Goodbye.";

/** Kill switch (is_paused): hard stop, no forwarding. */
export const VOICE_MSG_PAUSED =
  "This line is temporarily unavailable. Please try again later. Goodbye.";

/** Safe mode: about to transfer to the owner's forwarding number. */
export const VOICE_MSG_SAFE_MODE_CONNECTING = "Connecting you now.";
