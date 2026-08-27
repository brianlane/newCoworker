/**
 * Was a voicemail script PLAUSIBLY delivered before the call ended?
 *
 * `confirmSpoken` stamps `voicemail_spoken` when the model calls `end_call`
 * after being handed a script, and the hangup path turns that stamp into
 * `voicemail_left: true` on the transcript row. The stamp used to be
 * unconditional, and real calls proved it lies (2026-08-26/27, Amy Laidlaw):
 *
 *   - call 06a44d56 hung up 13 seconds after ANSWER, before a ~14-second
 *     script could possibly have played, and still recorded a left voicemail;
 *   - call e71b585d ended while the mailbox GREETING was still playing, so
 *     the mailbox was not even recording yet, and still recorded one.
 *
 * The owner reads `voicemail_left` as "my approved message, with my number,
 * reached this lead". A stamp that cannot be true breaks that trust and
 * hides exactly the calls the call-integrity sweep exists to surface.
 *
 * The check is wall-clock, which works because playout is realtime: audio
 * reaches the far end no faster than one second per second, so if the line
 * was up for only three seconds after the script handover, at most three
 * seconds of script audio can have played, however fast the model generated
 * it. The caller computes that PLAYABLE window itself, as the time from the
 * script handover to the moment the hangup actually fires (the FIRST
 * `end_call` plus the goodbye grace, during which Telnyx keeps playing its
 * buffer). Anchoring on the first `end_call` matters: a duplicate `end_call`
 * arriving after the script handover must not re-credit a grace that is
 * already burning, which was Bugbot's finding on PR #1672.
 *
 * The threshold is deliberately generous (HALF the full read time) because
 * the failure directions are asymmetric: refusing a genuinely delivered
 * message understates once and is visible in the `voice_bridge_voicemail_cut_short`
 * diagnostic, while stamping an undelivered one lies to the owner and, via
 * the follow-up SMS copy ("We just left you a voicemail"), to the lead.
 * Model audio can be generated faster than realtime and buffered ahead, so
 * demanding the full duration would refuse legitimate fast reads.
 *
 * Pure and dependency-free so `tests/voicemail-timing.test.ts` can pin it
 * without the bridge's Telnyx/Gemini scaffolding.
 */

/**
 * Spoken pace for estimating a script's duration: ~150 words per minute and
 * ~6 characters per word comes to 15 characters per second.
 */
export const VOICEMAIL_READ_CHARS_PER_SECOND = 15;

/** Fraction of the full read time that must have been possible. */
export const VOICEMAIL_MIN_DELIVERED_FRACTION = 0.5;

/** Milliseconds a full, unhurried read of the script would take. */
export function voicemailFullReadMs(scriptChars: number): number {
  return Math.max(0, scriptChars) * (1000 / VOICEMAIL_READ_CHARS_PER_SECOND);
}

/**
 * True when the line was up long enough after the script handover for at
 * least `VOICEMAIL_MIN_DELIVERED_FRACTION` of the script to have played.
 */
export function voicemailPlausiblyDelivered(opts: {
  /**
   * Milliseconds the line is/was up after the script handover: the first
   * `end_call`'s hangup moment (its request time plus the goodbye grace)
   * minus the handover time. Negative when the script arrived after the
   * hangup already fired, which naturally fails the check.
   */
  playableMs: number;
  /** Length of the script the model was told to read. */
  scriptChars: number;
}): boolean {
  const required = voicemailFullReadMs(opts.scriptChars) * VOICEMAIL_MIN_DELIVERED_FRACTION;
  return opts.playableMs >= required;
}
