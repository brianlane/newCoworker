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
