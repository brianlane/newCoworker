/**
 * Node lockstep of supabase/functions/_shared/voice_voicemail_speak.ts.
 *
 * The bridge cannot import Deno `_shared`. Sequence, RPC names, patch keys,
 * and voice are pinned by tests/voice-bridge-voicemail-speak-lockstep.test.ts
 * so a rename on one side cannot silently desync the claim.
 *
 * Used when the uplink beep detector hears a mailbox tone after
 * `voicemail_reached` or a machine-phrase transcript: claim, stop the
 * stream, speak the authored script over Telnyx TTS, stamp started_at.
 */
import { telnyxHangupCall, telnyxSpeak, telnyxStreamingStop } from "./telnyx-call-actions.js";

export type VoicemailSpeakRpc = (
  fn: string,
  args?: Record<string, unknown>
) => PromiseLike<{ data?: unknown; error: { message: string } | null }>;

export type VoicemailSpeakDeps = {
  rpc: VoicemailSpeakRpc;
  apiKey: string;
  fetchImpl: typeof fetch;
  nowIso: () => string;
};

export type VoicemailSpeakOutcome =
  | "claim_failed"
  | "already_claimed"
  | "stream_stop_failed"
  | "speak_failed"
  | "speaking";

export type VoicemailSpeakTrigger = "beep" | "sweep" | "bridge_beep" | "cancelled_retry";

/** Voice name handed to Telnyx `/actions/speak`. Pinned by the lockstep test. */
export const VOICEMAIL_SPEAK_VOICE = "female";

export type VoicemailSpeakOpts = {
  trigger?: VoicemailSpeakTrigger;
  alreadyClaimed?: boolean;
};

export async function speakVoicemailDeterministic(
  deps: VoicemailSpeakDeps,
  callControlId: string,
  script: string,
  opts: VoicemailSpeakOpts = {}
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

  if (opts.alreadyClaimed) {
    const { data: claimed, error: retryErr } = await rpc("voice_claim_voicemail_retry", {
      p_call_control_id: callControlId
    });
    if (retryErr) {
      console.error("voicemail: retry claim failed", retryErr);
      return "claim_failed";
    }
    if (claimed !== true) return "already_claimed";
  } else {
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
      console.error(
        "voicemail: streaming_stop failed",
        callControlId,
        stopped.status,
        (stopped.body ?? "").slice(0, 300)
      );
      await releaseClaim();
      return await giveUpAndHangUp("stream_stop_failed");
    }
  }

  const res = await telnyxSpeak(
    apiKey,
    callControlId,
    script,
    VOICEMAIL_SPEAK_VOICE,
    fetchImpl
  );
  if (!res.ok) {
    console.error(
      "voicemail: speak failed",
      callControlId,
      res.status,
      (res.body ?? "").slice(0, 300)
    );
    await releaseClaim();
    return await giveUpAndHangUp("speak_failed");
  }

  const patch: Record<string, unknown> = {
    voicemail_speak_started_at: deps.nowIso(),
    voicemail_speak_script_chars: script.length
  };
  if (opts.trigger) patch.voicemail_speak_trigger = opts.trigger;
  if (opts.alreadyClaimed) patch.voicemail_speak_restarted = true;
  const { error: markErr } = await rpc("voice_session_context_merge", {
    p_call_control_id: callControlId,
    p_patch: patch
  });
  if (markErr) {
    console.error("voicemail: speak start stamp failed", markErr);
  }
  return "speaking";
}
