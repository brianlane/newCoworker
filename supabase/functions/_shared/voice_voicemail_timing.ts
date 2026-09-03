/**
 * Was the EDGE-spoken voicemail plausibly delivered before the leg ended?
 *
 * The Edge `speakVoicemail` path stamps `voicemail_speak_started_at` when
 * Telnyx ACCEPTS the speak command (2xx), which proves the command was
 * issued, not that the audio played. `call.speak.ended` is the completion
 * signal, but Telnyx has demonstrably dropped whole webhook classes since
 * 2026-08-25 (see memory project_telnyx_premium_amd_event_collapse), so the
 * honest `voicemail_spoken` stamp cannot depend on that event alone: a
 * message that fully played with the event lost would read "no message" and
 * the follow-up ladder would redial a lead who already heard it.
 *
 * So the hangup path falls back to the same wall-clock plausibility rule the
 * bridge uses: playout is realtime, audio reaches the far end no faster than
 * one second per second, so if the leg stayed up for at least half the
 * script's unhurried read time after the speak started, the message
 * plausibly went out.
 *
 * The constants deliberately MIRROR `vps/voice-bridge/src/voicemail-timing.ts`
 * (PR #1672), which owns the same judgement for the model-spoken path.
 * `tests/voice-voicemail-timing.test.ts` imports both modules and fails if
 * they drift, so the two sides cannot quietly disagree about what
 * "delivered" means.
 */

/** Spoken pace for estimating a script's duration (~150 wpm, ~6 chars/word). */
export const EDGE_VOICEMAIL_READ_CHARS_PER_SECOND = 15;

/** Fraction of the full read time that must have been possible. */
export const EDGE_VOICEMAIL_MIN_DELIVERED_FRACTION = 0.5;

/** Milliseconds a full, unhurried read of the script would take. */
export function edgeVoicemailFullReadMs(scriptChars: number): number {
  return Math.max(0, scriptChars) * (1000 / EDGE_VOICEMAIL_READ_CHARS_PER_SECOND);
}

/**
 * True when the leg stayed up long enough after the speak command for at
 * least the minimum fraction of the script to have played.
 *
 * `startedAtIso` is the `voicemail_speak_started_at` stamp; `endedAtIso` is
 * the hangup webhook's `end_time` (wall clock backstop chosen by the
 * caller). Unparseable timestamps fail the check: an unprovable delivery is
 * reported as none, which understates once instead of lying to the owner.
 */
export function edgeVoicemailPlausiblyDelivered(opts: {
  startedAtIso: unknown;
  endedAtIso: unknown;
  scriptChars: number;
}): boolean {
  const started = Date.parse(typeof opts.startedAtIso === "string" ? opts.startedAtIso : "");
  const ended = Date.parse(typeof opts.endedAtIso === "string" ? opts.endedAtIso : "");
  if (!Number.isFinite(started) || !Number.isFinite(ended)) return false;
  const playableMs = ended - started;
  const requiredMs = edgeVoicemailFullReadMs(opts.scriptChars) * EDGE_VOICEMAIL_MIN_DELIVERED_FRACTION;
  return playableMs >= requiredMs;
}

/**
 * What `call.speak.ended` should do to a voicemail we issued.
 *
 * Extracted from the Deno handler so the status matrix is unit-tested. The
 * handler used to hang up on every speak.ended, including `cancelled_amd`,
 * which is Telnyx cutting an early speak because it just heard the beep:
 * hanging up then is how five late-Aug voicemails recorded nothing.
 *
 *  - `stamp_and_hangup`: playout finished and the wall clock agrees.
 *  - `retry_speak`: Telnyx cancelled an early speak, or reported completed
 *    faster than half the script could have played. Re-issue once.
 *  - `record_only`: the leg is already ending (`call_hangup`) or a retry
 *    already happened. Stamp the status, do not hang up, do not loop.
 */
export type SpeakEndedAction = "stamp_and_hangup" | "retry_speak" | "record_only";

/** Status values that mean the message did not finish playing. */
const INTERRUPTED_SPEAK_STATUSES = new Set(["cancelled_amd", "call_hangup"]);

export function classifySpeakEnded(opts: {
  status: unknown;
  alreadyRestarted: boolean;
  plausible: boolean;
}): SpeakEndedAction {
  const status = typeof opts.status === "string" ? opts.status.trim().toLowerCase() : "";
  if (status === "completed") {
    if (opts.plausible) return "stamp_and_hangup";
    return opts.alreadyRestarted ? "record_only" : "retry_speak";
  }
  if (status === "cancelled_amd") {
    return opts.alreadyRestarted ? "record_only" : "retry_speak";
  }
  return "record_only";
}

/**
 * True when a speak.ended status means the audio was cut, so the hangup
 * path must not promote `voicemail_spoken` from the wall clock. A restart
 * that later completed is a different speak; the caller passes the LATEST
 * status, and a completed restart is not interrupted.
 */
export function speakEndedWasInterrupted(status: unknown): boolean {
  const value = typeof status === "string" ? status.trim().toLowerCase() : "";
  return INTERRUPTED_SPEAK_STATUSES.has(value);
}

/**
 * The hangup path's single question: did a voicemail message actually go
 * out on this leg?
 *
 * True when the direct stamp landed (`call.speak.ended` confirmed playout,
 * or the bridge's own gated confirmSpoken wrote it), else when the Edge
 * speak's wall-clock window says the script plausibly played. The stored
 * `voicemail_speak_script_chars` is preferred over re-measuring the script
 * because it is the length of what was actually handed to /actions/speak;
 * the configured script is the fallback for a context where the merge half
 * failed. No speak start stamp means no Edge speak was ever issued, so only
 * the direct stamp can answer.
 *
 * An interrupted speak (`cancelled_amd` / `call_hangup`) that was never
 * retried cannot have delivered, no matter how long the leg stayed up:
 * Telnyx kept listening for the beep, it did not play our message.
 */
export function resolveEdgeVoicemailSpoken(opts: {
  voicemailSpoken: unknown;
  startedAtIso: unknown;
  storedScriptChars: unknown;
  fallbackScript: unknown;
  endedAtIso: unknown;
  /**
   * Latest `call.speak.ended` status written onto the session. When this is
   * `cancelled_amd` or `call_hangup` and no restart completed, the wall-clock
   * promote is a lie: the leg stayed up while Telnyx kept listening for the
   * beep, not while our message played (four of five cancelled_amd calls in
   * late Aug / early Sep 2026 were stamped delivered this way).
   */
  speakEndedStatus?: unknown;
  /** True when a cancelled/short speak was re-issued and that retry is the latest speak. */
  restarted?: unknown;
}): boolean {
  if (opts.voicemailSpoken === true) return true;
  // An interrupted speak that was never retried cannot have delivered, no
  // matter how long the leg stayed up afterwards.
  if (speakEndedWasInterrupted(opts.speakEndedStatus) && opts.restarted !== true) {
    return false;
  }
  if (typeof opts.startedAtIso !== "string") return false;
  const stored =
    typeof opts.storedScriptChars === "number" && Number.isFinite(opts.storedScriptChars)
      ? opts.storedScriptChars
      : 0;
  const scriptChars =
    stored > 0
      ? stored
      : typeof opts.fallbackScript === "string"
        ? opts.fallbackScript.trim().length
        : 0;
  // A speak was issued but nothing measurable was spoken? Corrupt context;
  // an unprovable delivery reports as none rather than lying to the owner.
  if (scriptChars <= 0) return false;
  return edgeVoicemailPlausiblyDelivered({
    startedAtIso: opts.startedAtIso,
    endedAtIso: opts.endedAtIso,
    scriptChars
  });
}
