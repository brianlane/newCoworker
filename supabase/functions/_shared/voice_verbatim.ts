/**
 * How closely did the assistant say what it was told to say?
 *
 * Some spoken output is scripted rather than conversational: a voicemail is
 * written copy, approved by the business owner, played to someone who cannot
 * interrupt or correct it. A live model cannot be GUARANTEED word for word,
 * but the gap between the approved script and what actually came out of the
 * speaker is measurable, and measuring it turns an unverifiable risk into a
 * monitored one.
 *
 * The number this produces is meant for two jobs:
 *
 *   1. Per call, stored next to the transcript, so an owner can see not only
 *      what was said on their behalf but how close it landed to their words,
 *      and be alerted when it drifts.
 *   2. As a benchmark before a script is ever enabled: run it enough times to
 *      see the distribution, and let that decide whether the copy ships at
 *      full length or needs shortening. Drift scales with length, so this is
 *      the honest way to settle "is this script too long", rather than
 *      guessing.
 *
 * Scoring is WORD-level, not character-level, on purpose. A voicemail that
 * swaps one word ("call us back" for "give us a call back") is a near-perfect
 * read, and character distance over-punishes it because a short word shifts
 * every character after it. Word distance says what a listener would say: one
 * word out of sixty.
 */

/**
 * Reduce spoken or scripted text to comparable words.
 *
 * Case, punctuation, and whitespace all differ between a written script and a
 * speech-to-text transcript of that script being read aloud, and none of those
 * differences mean the assistant said the wrong thing. Digits are kept as
 * their own words so a phone number still has to be right: dropping a digit
 * from a callback number is exactly the kind of drift worth catching.
 */
export function normalizeSpokenText(text: string): string[] {
  return text
    .toLowerCase()
    // Apostrophes vanish rather than splitting a word: "I'll" and "ill" should
    // not read as a substitution when a transcriber writes it either way.
    .replace(/['’]/g, "")
    // Everything else non-alphanumeric becomes a boundary.
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Word-level Levenshtein distance: the fewest word insertions, deletions, or
 * substitutions turning one word list into the other.
 *
 * Two rolling rows rather than a full matrix. Scripts here are short, so this
 * is about keeping the shape obvious rather than about speed.
 */
function wordDistance(a: readonly string[], b: readonly string[]): number {
  // No empty-input special cases: they fall out of the recurrence. With `a`
  // empty the outer loop never runs and the seeded row already holds b.length;
  // with `b` empty the inner loop never runs and each row carries i forward.
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let curr = new Array<number>(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j]! + 1, // deletion
        curr[j - 1]! + 1, // insertion
        prev[j - 1]! + cost // substitution
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length]!;
}

export type VerbatimScore = {
  /** 1 = word-for-word, 0 = nothing in common. Rounded to 4 decimals. */
  score: number;
  /** Words in the approved script, after normalization. */
  scriptWords: number;
  /** Word edits between the script and what was actually said. */
  edits: number;
};

/**
 * Score what was SAID against what was SCRIPTED.
 *
 * Normalized by the longer of the two word counts, so padding is penalized as
 * much as omission. An assistant that reads the script correctly and then adds
 * two improvised sentences has not read it verbatim, and a score that ignored
 * additions would call that perfect: additions are the drift most worth
 * catching, since an invented sentence in a voicemail is a commitment nobody
 * approved.
 *
 * Empty spoken text scores 0 against a non-empty script. An empty SCRIPT
 * scores 1, since there was nothing to deviate from, and callers should treat
 * "no script configured" as a separate case before scoring at all.
 */
export function scoreVerbatim(spoken: string, script: string): VerbatimScore {
  const said = normalizeSpokenText(spoken);
  const want = normalizeSpokenText(script);
  if (want.length === 0) {
    return { score: 1, scriptWords: 0, edits: said.length };
  }
  const edits = wordDistance(want, said);
  const denominator = Math.max(want.length, said.length);
  const raw = 1 - edits / denominator;
  const score = Math.max(0, Math.min(1, raw));
  return {
    score: Math.round(score * 10_000) / 10_000,
    scriptWords: want.length,
    edits
  };
}

/**
 * Below this, the read is different enough from the approved copy that a
 * person should look at it.
 *
 * 0.85 allows roughly one word in seven to move, which covers transcription
 * noise and small filler ("um", a repeated name) without tolerating an
 * invented sentence. It is a starting point to be tuned against a real
 * distribution, not a derived constant, and it is deliberately a floor for
 * ALERTING rather than a gate on the call: the voicemail has already been left
 * by the time this can be computed, so the only useful response is to tell
 * someone.
 */
export const VERBATIM_ALERT_THRESHOLD = 0.85;

/** True when a read is far enough off the script to be worth surfacing. */
export function verbatimNeedsReview(score: number): boolean {
  return score < VERBATIM_ALERT_THRESHOLD;
}
