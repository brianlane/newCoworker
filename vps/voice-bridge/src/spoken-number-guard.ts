/**
 * Call-time firewall for spoken phone numbers.
 *
 * The daily call-integrity sweep proves the model fabricates callback numbers
 * on real calls (thirteen distinct invented Phoenix numbers over 45 days,
 * then two more within a day of the prompt rule shipping, then one more with
 * the fixed prompt AND the tool ordering both holding). Prompt rules name the
 * failure a day later; they do not prevent it. This module is the prevention:
 * it decides, per assistant utterance, whether a number-shaped string the
 * model is speaking was ever legitimately given to it on this call.
 *
 * The enforcement half lives in gemini-telnyx-bridge.ts: Gemini Live
 * generates audio faster than the phone line plays it, so when the streamed
 * output transcription reveals a disallowed number, the frames carrying those
 * digits are almost always still sitting in Telnyx's playback queue, and a
 * `{"event":"clear"}` on the media WebSocket wipes that queue before the
 * digits reach the caller's ear. This module stays pure (no sockets, no IO)
 * so the root test suite can pin every decision.
 *
 * THE ALLOWLIST IS THE PROMPT RULE, MADE MECHANICAL. NO_INVENTED_CONTACT_LINE
 * (call-integrity-lines.ts) permits a number only when it is written in the
 * model's instructions or materials, or the person on this call just said it.
 * The guard collects exactly those two sources: every text the bridge injects
 * toward the model (system instruction, coordinator cues, tool responses, the
 * mid-call brief, the voicemail script) and every caller-side transcription,
 * plus the known party numbers of the call itself. Anything the model speaks
 * outside that set is by construction fabricated.
 *
 * NUMBER EXTRACTION IS A LOCKSTEP COPY of the daily sweep's detector
 * (supabase/functions/_shared/call_integrity.ts: SPOKEN_NUMBER_PATTERN,
 * spokenNumberForm, extractSpokenNumbers). The bridge is its own npm package
 * and cannot import the Deno module, and the two MUST agree: a number the
 * guard allows but the sweep flags would page a human about audio that was
 * legitimately played, and the reverse would let a fabrication through
 * unreported. tests/spoken-number-guard-lockstep.test.ts pins them equal.
 */

/**
 * A phone number as it appears in speech or text: optionally a +1/1 prefix,
 * then 3-3-4 with any mix of spaces, dots, dashes or parentheses, including
 * none. Lockstep with SPOKEN_NUMBER_PATTERN in _shared/call_integrity.ts.
 */
const SPOKEN_NUMBER_PATTERN = /\b(?:\+?1[ .\-()]*)?\(?(\d{3})\)?[ .\-]*(\d{3})[ .\-]*(\d{4})\b/g;

/**
 * A phone-ish value normalized to spoken 3-3-4 form ("480-269-7977"), or null
 * when it does not hold a North American number. Lockstep with
 * spokenNumberForm in _shared/call_integrity.ts.
 */
export function spokenNumberForm(value: unknown): string | null {
  const digits = String(value ?? "").replace(/\D/g, "");
  const d = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  if (d.length !== 10) return null;
  return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
}

/**
 * Every number in a piece of text, in spoken 3-3-4 form, in order. Lockstep
 * with extractSpokenNumbers in _shared/call_integrity.ts.
 */
export function extractSpokenNumbers(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(SPOKEN_NUMBER_PATTERN)) {
    out.push(`${m[1]}-${m[2]}-${m[3]}`);
  }
  return out;
}

/**
 * One number the model tried to speak that nothing on the call supplied.
 * `turnText` is the assistant turn so far, for the diagnostic trail.
 */
export type SpokenNumberViolation = {
  number: string;
  turnText: string;
};

/**
 * The assistant-turn text tail the guard keeps. Output transcription streams
 * in small fragments, so matching must run over the accumulated turn, but an
 * unbounded buffer on an hour-long call would grow without limit. 4000 chars
 * is minutes of speech, far wider than any number can straddle.
 */
export const GUARD_TURN_TAIL_CHARS = 4000;

/**
 * What the model is told after a violation on a leg where a person may be
 * listening. Phrased as a coordinator message like every other mid-call cue,
 * and it does NOT repeat the number (repeating it would be one more chance
 * for the model to say it). Capped by GUARD_MAX_CUES because a model that
 * keeps trying numbers gets its audio suppressed either way, and a cue loop
 * would talk over the caller.
 */
export const NUMBER_SUPPRESSED_CUE =
  "[Coordinator] The last thing you said was cut off before the caller heard it, because it " +
  "contained a phone number that is not written in your instructions or materials. That " +
  "number does not exist: never say it again. Continue the conversation naturally, and give " +
  "out a phone number ONLY if one is written in your instructions. If none is, offer a " +
  "follow-up instead.";

/** Most correction cues sent per call before the guard goes silent-only. */
export const GUARD_MAX_CUES = 2;

export type SpokenNumberGuard = {
  /** Record text the model was legitimately given (instructions, cues, tool responses). */
  allowText(text: string | null | undefined): void;
  /** Record one known-legitimate number (party E.164s, configured numbers). */
  allowNumber(value: unknown): void;
  /**
   * Record caller-side transcription. Same effect as allowText, named apart
   * because the SOURCE differs: repeating back what the person said is the
   * prompt rule's second permitted origin.
   */
  noteCallerText(text: string | null | undefined): void;
  /**
   * Accumulate assistant-side transcription and return any NEW violations it
   * reveals. A number already allowed, or already reported this call, never
   * repeats: one violation per distinct number per call, mirroring the daily
   * sweep's one-finding-per-number rule.
   */
  noteAssistantText(text: string | null | undefined): SpokenNumberViolation[];
  /** The model's turn finished; start the next accumulation fresh. */
  endAssistantTurn(): void;
  /** Every number suppressed so far this call, in first-seen order. */
  suppressedNumbers(): string[];
};

export function createSpokenNumberGuard(): SpokenNumberGuard {
  const allowed = new Set<string>();
  const flagged = new Set<string>();
  const suppressedInOrder: string[] = [];
  let turnBuf = "";

  const allowText = (text: string | null | undefined): void => {
    if (typeof text !== "string" || text === "") return;
    for (const n of extractSpokenNumbers(text)) allowed.add(n);
  };

  return {
    allowText,
    allowNumber(value: unknown): void {
      const n = spokenNumberForm(value);
      if (n) allowed.add(n);
    },
    noteCallerText(text: string | null | undefined): void {
      allowText(text);
    },
    noteAssistantText(text: string | null | undefined): SpokenNumberViolation[] {
      if (typeof text !== "string" || text === "") return [];
      turnBuf = (turnBuf + text).slice(-GUARD_TURN_TAIL_CHARS);
      const out: SpokenNumberViolation[] = [];
      for (const n of extractSpokenNumbers(turnBuf)) {
        if (allowed.has(n) || flagged.has(n)) continue;
        flagged.add(n);
        suppressedInOrder.push(n);
        out.push({ number: n, turnText: turnBuf });
      }
      return out;
    },
    endAssistantTurn(): void {
      turnBuf = "";
    },
    suppressedNumbers(): string[] {
      return [...suppressedInOrder];
    }
  };
}
