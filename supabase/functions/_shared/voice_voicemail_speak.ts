/**
 * Speak the configured voicemail message on a machine-answered outbound leg,
 * exactly once, deterministically.
 *
 * Extracted from `telnyx-voice-call-end` (where it ran on `greeting.ended`)
 * so the AMD resolution sweep can run the SAME sequence when Telnyx never
 * delivers a greeting event (the platform stopped sending them on
 * 2026-08-25; see memory project_telnyx_premium_amd_event_collapse). One
 * implementation, one claim, whoever gets there first speaks.
 *
 * Sequence, and why each step is ordered this way:
 *
 *   1. CLAIM (`voice_claim_voicemail_speak`) in one compare-and-set. Both the
 *      greeting handler and the sweep can fire for the same leg, plus Telnyx
 *      redelivers webhooks at-least-once; check-then-speak would let two
 *      callers talk over each other into one recording.
 *   2. STOP THE STREAM. The Gemini bridge was attached on call.answered,
 *      before anyone knew a machine picked up. Speaking under it would record
 *      the script beneath the assistant's chatter.
 *   3. SPEAK, then stamp `voicemail_speak_started_at` (+ script length).
 *      Deliberately NOT `voicemail_spoken`: a 2xx from /actions/speak means
 *      Telnyx ACCEPTED the command, not that the audio played.
 *      `voicemail_spoken` is written later by `call.speak.ended` (playout
 *      finished) or by the hangup path's wall-clock plausibility fallback
 *      (voice_voicemail_timing.ts), the same accepted-vs-delivered honesty
 *      PR #1672 gave the bridge-spoken path.
 *
 * A leg that cannot be spoken to (claim error, stream stop refused, speak
 * refused) is hung up: the machine verdict is already stamped, the bridge
 * would otherwise keep talking into the recording, and ending the leg is
 * what the pre-voicemail AMD path always did.
 *
 * Does NOT hang up on success. `call.speak.ended` ends the leg when the
 * message finishes; if that event never arrives, the voicemail system's own
 * recording limit ends the call, the same bound a human caller would hit.
 */
import {
  telnyxHangupCall,
  telnyxSpeak,
  telnyxStreamingStop
} from "./telnyx_call_actions.ts";

/** Narrow supabase surface: the two claim RPCs plus the context merge. */
export type VoicemailSpeakRpc = (
  fn: string,
  args?: Record<string, unknown>
) => PromiseLike<{ data?: unknown; error: { message: string } | null }>;

export type VoicemailSpeakDeps = {
  rpc: VoicemailSpeakRpc;
  apiKey: string;
  /** Injected for tests; Edge glue passes the global fetch. */
  fetchImpl: typeof fetch;
  /** Injected clock so tests can pin the started_at stamp. */
  nowIso: () => string;
};

export type VoicemailSpeakOutcome =
  /** RPC error while claiming: leg hung up, nothing spoken. */
  | "claim_failed"
  /** Another caller holds the claim; they own the leg's ending. Left alone. */
  | "already_claimed"
  /** streaming_stop refused: claim released, leg hung up, nothing spoken. */
  | "stream_stop_failed"
  /** /actions/speak refused: claim released, leg hung up, nothing spoken. */
  | "speak_failed"
  /** Speak ACCEPTED; started_at stamped. Playout confirmation comes later. */
  | "speaking";

export async function speakVoicemailDeterministic(
  deps: VoicemailSpeakDeps,
  callControlId: string,
  script: string
): Promise<VoicemailSpeakOutcome> {
  const { rpc, apiKey, fetchImpl } = deps;

  const giveUpAndHangUp = async (outcome: VoicemailSpeakOutcome) => {
    await telnyxStreamingStop(apiKey, callControlId, fetchImpl);
    await telnyxHangupCall(apiKey, callControlId, fetchImpl);
    return outcome;
  };

  const releaseClaim = async () => {
    const { error } = await rpc("voice_release_voicemail_claim", {
      p_call_control_id: callControlId
    });
    if (error) console.error("voicemail: claim release failed", error);
  };

  const { data: claimed, error: claimErr } = await rpc("voice_claim_voicemail_speak", {
    p_call_control_id: callControlId
  });
  if (claimErr) {
    console.error("voicemail: claim failed", claimErr);
    return await giveUpAndHangUp("claim_failed");
  }
  if (claimed !== true) return "already_claimed";

  const stopped = await telnyxStreamingStop(apiKey, callControlId, fetchImpl);
  if (!stopped.ok) {
    // Speaking now would record our message UNDER the assistant's chatter.
    // A clean "no message" beats an unintelligible one.
    console.error(
      "voicemail: streaming_stop failed",
      callControlId,
      stopped.status,
      (await stopped.text()).slice(0, 300)
    );
    await releaseClaim();
    return await giveUpAndHangUp("stream_stop_failed");
  }

  const res = await telnyxSpeak(apiKey, callControlId, script, "female", fetchImpl);
  if (!res.ok) {
    console.error(
      "voicemail: speak failed",
      callControlId,
      res.status,
      (await res.text()).slice(0, 300)
    );
    await releaseClaim();
    return await giveUpAndHangUp("speak_failed");
  }

  // The command is accepted and playout is starting. Stamp WHEN it started
  // and HOW LONG the script is, so completion can be judged honestly later
  // (call.speak.ended, or the hangup path's plausibility fallback).
  const { error: markErr } = await rpc("voice_session_context_merge", {
    p_call_control_id: callControlId,
    p_patch: {
      voicemail_speak_started_at: deps.nowIso(),
      voicemail_speak_script_chars: script.length
    }
  });
  if (markErr) {
    // The message IS going out; a lost stamp only understates it.
    console.error("voicemail: speak start stamp failed", markErr);
  }
  return "speaking";
}
