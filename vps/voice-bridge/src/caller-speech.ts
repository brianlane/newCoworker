/**
 * What the CALLER has said so far on this call, in memory, synchronously.
 *
 * The translator gate has to judge the caller's language at the instant a warm
 * transfer succeeds. The transcript recorder (voice-transcript.ts) buffers the
 * same frames, but it is fire-and-forget async around a DB adapter and only
 * exists when transcripts are wired, so a live routing decision cannot read it
 * without either awaiting a write or silently having no evidence.
 *
 * Both read the SAME frame parser (`extractTranscriptionFrame`), so the gate
 * can never disagree with the transcript the owner later reads about what the
 * caller said.
 *
 * Caller turns ONLY. Scoring our own speech would let an AI that greeted in
 * Spanish look like a Spanish-speaking caller and interpret at itself.
 */
import {
  extractTranscriptionFrame,
  type LiveTranscriptMessage
} from "./voice-transcript.js";

/** Enough context for a language judgment without unbounded growth. */
const DEFAULT_MAX_TURNS = 20;

export type CallerSpeechLog = {
  ingest: (message: LiveTranscriptMessage | null | undefined) => void;
  /** Completed turns, oldest first, plus the in-flight one when non-empty. */
  turns: () => string[];
};

export function createCallerSpeechLog(
  opts: { maxTurns?: number } = {}
): CallerSpeechLog {
  const maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS;
  const completed: string[] = [];
  let buffer = "";

  return {
    ingest(message) {
      if (!message || typeof message !== "object") return;
      const frame = extractTranscriptionFrame(message);
      buffer += frame.callerText;
      if (!frame.turnComplete) return;
      const turn = buffer.trim();
      buffer = "";
      if (!turn) return;
      completed.push(turn);
      if (completed.length > maxTurns) completed.splice(0, completed.length - maxTurns);
    },
    turns() {
      // The in-flight buffer counts: the model routinely calls
      // transfer_to_owner in the same turn the caller finished speaking, before
      // turnComplete has landed, and that last sentence is often the only one
      // carrying the language.
      const pending = buffer.trim();
      return pending ? [...completed, pending] : [...completed];
    }
  };
}
