/**
 * Tapback (message reaction) detection for SMS.
 *
 * When a phone reacts to a message in an SMS thread, the reaction arrives as
 * literal text. Apple renders:
 *
 *   Liked “Great, looking forward to it!”
 *   Removed a like from “Great, looking forward to it!”
 *   Reacted 🔥 to “Great, looking forward to it!”   (iOS 18+ emoji tapbacks)
 *
 * and newer renderers drop the verb entirely, wrapping the glyph in
 * zero-width spaces:
 *
 *   ❤️ to “ Great, looking forward to it! ”
 *
 * These are reactions, not messages, so the SMS worker suppresses the
 * generated reply for most of them platform-wide: answering a Like with
 * "Glad to hear it!" reads as bot noise (KYP Ads, 2026-07-20), and three
 * hearts in a row each drew a fresh reply (KYP, 2026-07-28). WhatsApp
 * already skips its native `reaction` events in src/lib/meta/webhook.ts, so
 * this brings SMS to parity.
 *
 * A reaction is not ALWAYS noise, which is what `tapbackKind` is for:
 *   - `removal`  un-reacting is cleanup, never a message. Always suppressed.
 *   - `question` "Questioned"/❓ means "huh?". Always answered.
 *   - `reaction` everything else. Suppressed unless our last message asked a
 *     question, in which case the reaction IS the answer (👎 means no).
 *
 * Matching is deliberately conservative. The classic and emoji forms need
 * their verb to open the message; the verbless form needs its leading token
 * to be a real emoji carrying no letters or digits, so "+1 to “great idea”"
 * is never read as a reaction. In every form the quoted body must span the
 * REST of the message, so a genuine sentence like "Loved it!" or "Liked your
 * proposal, let's talk" is never suppressed.
 *
 * A tapback still counts as engagement everywhere else: it resumes
 * wait_for_reply, fires the `replied` goal, bumps interaction counters, and
 * alerts the owner. Only the generated reply is skipped.
 */

/**
 * Zero-width characters some renderers wrap the glyph in (seen live: KYP,
 * 2026-07-28). They survive `trim()` and broke every pattern below, so they
 * are stripped before matching. ZWJ (U+200D) is deliberately NOT in the set:
 * it JOINS emoji sequences, and dropping it would split "🙂‍↕️" apart.
 */
const ZERO_WIDTH_RE = /[\u200B\u2060\uFEFF]/g;

/** `Liked “…”` / `Loved "…"` …, the six classic tapback verbs. */
const TAPBACK_VERB_RE =
  /^(liked|loved|disliked|laughed at|emphasized|emphasised|questioned)\s+[“"]([\s\S]+)[”"]$/iu;

/** `Removed a like from “…”` …, classic tapback removals. */
const TAPBACK_REMOVAL_RE =
  /^removed\s+(an?\s+(?:like|heart|dislike|laugh|exclamation(?:\s+point)?|question mark))\s+from\s+[“"]([\s\S]+)[”"]$/iu;

/** iOS 18 emoji tapbacks: `Reacted 🔥 to “…”` / `Removed 🔥 from “…”`. */
const TAPBACK_EMOJI_RE =
  /^(?:reacted\s+(\S{1,16})\s+to|removed\s+(\S{1,16})\s+from)\s+[“"]([\s\S]+)[”"]$/iu;

/** Verbless renderers: `❤️ to “…”` / `❤️ from “…”`. */
const TAPBACK_VERBLESS_RE = /^(\S{1,16})\s+(to|from)\s+[“"]([\s\S]+)[”"]$/iu;

/** ❓ and ❔, the emoji spelling of the "Questioned" tapback. */
const QUESTION_GLYPH_RE = /[\u2753\u2754]/u;

/** Longest quoted body we repeat back to the model in a note. */
const MAX_QUOTED_CHARS = 160;

export type TapbackKind = "removal" | "question" | "reaction";

export type Tapback = {
  kind: TapbackKind;
  /** The reaction as it arrived: an emoji ("❤️") or a verb ("Liked"). */
  reaction: string;
  /** The message that was reacted to, as the renderer quoted it. */
  quoted: string;
};

/**
 * A reaction token stands in for an emoji, so it must contain at least one
 * pictographic codepoint and no letters or digits. Without both halves the
 * verbless form has no verb to anchor on and would swallow ordinary text
 * ("+1 to “great idea”", "? to “the quote”").
 */
function isEmojiReactionToken(token: string): boolean {
  return /\p{Extended_Pictographic}/u.test(token) && !/[a-z0-9]/i.test(token);
}

function reactionKind(token: string): TapbackKind {
  return QUESTION_GLYPH_RE.test(token) ? "question" : "reaction";
}

/**
 * Parse an inbound into its reaction and the message it reacted to, or null
 * when the text is a real message. Full-string match on the normalized text.
 */
export function parseTapback(text: string): Tapback | null {
  const t = text.replace(ZERO_WIDTH_RE, "").trim();
  if (!t) return null;

  const removal = TAPBACK_REMOVAL_RE.exec(t);
  if (removal) {
    return { kind: "removal", reaction: removal[1], quoted: removal[2].trim() };
  }

  const verb = TAPBACK_VERB_RE.exec(t);
  if (verb) {
    const kind = verb[1].toLowerCase() === "questioned" ? "question" : "reaction";
    return { kind, reaction: verb[1], quoted: verb[2].trim() };
  }

  const emoji = TAPBACK_EMOJI_RE.exec(t);
  if (emoji) {
    const [, reacted, removed, quoted] = emoji;
    const token = reacted ?? removed;
    if (!isEmojiReactionToken(token)) return null;
    return {
      kind: removed ? "removal" : reactionKind(token),
      reaction: token,
      quoted: quoted.trim()
    };
  }

  const verbless = TAPBACK_VERBLESS_RE.exec(t);
  if (verbless) {
    const [, token, preposition, quoted] = verbless;
    if (!isEmojiReactionToken(token)) return null;
    return {
      kind: preposition.toLowerCase() === "from" ? "removal" : reactionKind(token),
      reaction: token,
      quoted: quoted.trim()
    };
  }

  return null;
}

/** The reaction's kind, or null when the text is a real message. */
export function tapbackKind(text: string): TapbackKind | null {
  return parseTapback(text)?.kind ?? null;
}

/** True when the message text is a tapback rendered over SMS. */
export function isTapbackText(text: string): boolean {
  return parseTapback(text) !== null;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

/**
 * The note that rides INSIDE the user turn when a tapback is answered
 * instead of suppressed. A bare "❤️" tells the model nothing on its own:
 * which question it answers, and whether it means yes, live in the quoted
 * message. Same anchoring reason as formatFlowAnswerNote (a small model
 * ignores the equivalent fact in the system preamble).
 *
 * The quoted message is stated rather than assumed to be the pending
 * question, because it need not be: a texter can react to an older message
 * while a newer question sits unanswered. Comparing the quote against our
 * last message would be the obvious guard and is deliberately not done,
 * since renderers pad, truncate, and re-punctuate the quote. Handing the
 * model both halves and telling it to re-ask on a mismatch is the reliable
 * version of the same check.
 */
export function formatTapbackAnswerNote(tapback: Tapback): string {
  const quoted = truncate(tapback.quoted, MAX_QUOTED_CHARS);
  const head =
    `(Note: the texter did not type a message. They reacted with ` +
    `"${tapback.reaction}" to your message: "${quoted}".`;
  if (tapback.kind === "question") {
    return (
      `${head} A question-mark reaction means they did not understand that ` +
      `message. Explain it again in plain words, and do not just acknowledge ` +
      `the reaction.)`
    );
  }
  return (
    `${head} If that is the message you are waiting on an answer to, read ` +
    `the reaction as the answer: a thumbs down, a dislike, or a clearly ` +
    `negative reaction means no, and a thumbs up, a heart, or a clearly ` +
    `positive reaction means yes, and act on that answer in this reply. If ` +
    `they reacted to something else, or the reaction does not clearly answer ` +
    `you, do not guess: ask your question again in plain words.)`
  );
}
