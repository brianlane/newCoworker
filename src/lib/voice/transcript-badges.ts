/**
 * Presentation decisions for the call view's answering-machine badges.
 *
 * Deliberately NOT in src/lib/db/voice-transcripts.ts, where these started.
 * That module reaches the database and therefore imports the server-only
 * Supabase client, so a client component pulling one function out of it drags
 * server code into the browser bundle and fails the build. Pure view logic
 * belongs somewhere a client component can import freely.
 */
import { VERBATIM_ALERT_THRESHOLD } from "../../../supabase/functions/_shared/voice_verbatim";
import type { VoiceAnsweringMachineResult } from "@/lib/db/voice-transcripts";

/**
 * What the answering-machine pill should say, or null to render nothing.
 *
 * Nothing renders for a human answer or when detection was not requested,
 * which is the overwhelming majority of calls: a badge on every ordinary row
 * would be noise, and the interesting fact here is always the exception.
 *
 * The two machine labels are deliberately different. Reaching a voicemail and
 * hanging up is a different thing to have happened to the person on the other
 * end than being left a message, and an owner reviewing what their assistant
 * did on their behalf has to be able to tell those apart.
 */
export function answeringMachineBadgeLabel(
  result: VoiceAnsweringMachineResult | null | undefined,
  voicemailLeft: boolean | null | undefined
): string | null {
  if (result !== "machine") return null;
  return voicemailLeft === true ? "Voicemail" : "No answer, machine";
}

/**
 * How to present a voicemail's verbatim score, or null to render nothing.
 *
 * Coloured only when the read drifted from the approved script: a close read
 * is the expected case and does not need attention drawn to it, while a low
 * score is the owner's cue to go read what was actually said on their behalf.
 */
export function verbatimBadgeState(
  score: number | string | null | undefined
): { percent: number; drifted: boolean } | null {
  // A string is accepted deliberately. The column is double precision so
  // PostgREST hands back a real JSON number, but `numeric` columns come back
  // as STRINGS to preserve precision, and a reader that only accepted numbers
  // would respond to that by silently never rendering, which is the hardest
  // kind of bug to notice in a badge.
  // An empty or blank string is "no score", NOT zero. Number("") is 0, so a
  // naive coercion would render "script 0%" and claim the assistant read none
  // of its script, which is a worse lie than showing nothing.
  const n =
    typeof score === "string" ? (score.trim() === "" ? NaN : Number(score)) : score;
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  return {
    percent: Math.round(Math.max(0, Math.min(1, n)) * 100),
    drifted: n < VERBATIM_ALERT_THRESHOLD
  };
}

/**
 * Which notice the call view should show above a forwarded call's transcript,
 * or null for a call that was never forwarded. The caller maps these to copy;
 * the decision lives here so it is testable and so the two claims below cannot
 * drift apart again.
 *
 * `transferred` is the ordinary warm transfer: the AI handed the call over and
 * removed its media fork, so the transcript genuinely stops at the handover.
 *
 * `interpreted` is the case that made the old single message a lie. With
 * translator mode the AI stays on the bridged call, so the conversation AFTER
 * the transfer is transcribed too, and the owner is reading turns their
 * assistant was still part of.
 */
export function forwardedCallNotice(input: {
  callKind: string | null | undefined;
  status: string;
  turnCount: number;
  interpretedFromTurnIndex?: number | null;
}): "missed" | "noTranscript" | "transferred" | "interpreted" | null {
  if (input.callKind !== "forwarded") return null;
  if (input.status === "missed") return "missed";
  if (input.turnCount === 0) return "noTranscript";
  // Explicit null check, not truthiness: turn 0 is a legitimate index, and a
  // falsy test would report the earliest possible interpretation as an
  // ordinary transfer.
  return input.interpretedFromTurnIndex === null || input.interpretedFromTurnIndex === undefined
    ? "transferred"
    : "interpreted";
}

/**
 * Who a transcript turn should be attributed to.
 *
 * Before a bridge there are only two parties and the roles are exact. Once the
 * AI is interpreting there are three, and the platform can no longer tell the
 * two humans apart: Telnyx's `both_tracks` fork carries the caller's leg and
 * the bridged leg, the voice bridge forwards both into ONE Gemini input stream
 * (it reads `media.payload` and ignores `media.track`), and Gemini returns a
 * single undifferentiated `inputTranscription`. Distinguishing them would need
 * per-track diarization that does not exist today.
 *
 * So from that point on an inbound turn is labelled as either party. On call
 * 5634b7f0 the confident "Caller" label put the teammate's words in the lead's
 * mouth, which is worse than admitting the ambiguity.
 */
export function turnSpeaker(input: {
  role: string;
  turnIndex: number;
  interpretedFromTurnIndex?: number | null;
}): "assistant" | "caller" | "callerOrTeammate" {
  // Our own speech is never ambiguous, whoever else is on the line.
  if (input.role !== "caller") return "assistant";
  const from = input.interpretedFromTurnIndex;
  if (from === null || from === undefined) return "caller";
  return input.turnIndex >= from ? "callerOrTeammate" : "caller";
}

/**
 * True when this turn is model audio the lead never heard (the bridge prefixes
 * `[Muted]` while `modelAudioMuted`). Hidden on the call page so it cannot
 * read as something that went out over the line. `[Voicemail]` stays visible:
 * that badge is the script Telnyx TTS actually spoke.
 */
export function isMutedTranscriptTurn(content: unknown): boolean {
  return typeof content === "string" && content.trimStart().startsWith("[Muted]");
}
