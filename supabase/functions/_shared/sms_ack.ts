/**
 * Bare-acknowledgment detection for SMS.
 *
 * Customers close conversations with filler acknowledgments, "Ok",
 * "Okay 👍", "Thanks", "Sounds good", and answering EVERY one reads as
 * bot noise and burns a metered outbound SMS per turn (seen live: Truly
 * Insurance, 2026-07-21, four consecutive "Ok"-shaped turns each drew a
 * fresh "Acknowledged!" / "Got it!" reply). The SMS worker suppresses the
 * generated reply for an inbound this detector matches, but ONLY when the
 * assistant's latest message did not end in a question, so an "Ok"
 * answering "Does noon work for you?" still gets its confirmation turn.
 *
 * Matching is deliberately conservative:
 *  - a fixed phrase set (normalized to letters only), never fuzzy, real
 *    content like "Ok broker will call or I have to call?" never matches;
 *  - anything containing a digit is NEVER an ack ("1" claims a team offer,
 *    "2" picks a slot);
 *  - letterless inbounds count only when they carry an emoji and no "?"
 *    (a bare "👍" is an ack; a bare "?" is a nudge that deserves a reply);
 *  - a thumbs down is never an ack, whatever else it is sent with. It
 *    signals a problem, and staying silent on one is worse than replying.
 *
 * Like tapbacks, a suppressed ack is still a real interaction, it is
 * logged, counted, resumes flows, and can page the owner; only the
 * generated reply is skipped.
 */

/** Normalized (letters-only, single-spaced, lowercased) ack phrases. */
const ACK_PHRASES = new Set([
  "ok",
  "okay",
  "okey",
  "oki",
  "k",
  "kk",
  "kay",
  "alright",
  "all right",
  "sounds good",
  "sounds great",
  "got it",
  "gotcha",
  "roger",
  "roger that",
  "understood",
  "noted",
  "thanks",
  "thank you",
  "thanks so much",
  "thank you so much",
  "many thanks",
  "thx",
  "ty",
  "tysm",
  "perfect",
  "awesome",
  "no problem",
  "no worries",
  "will do",
  "ok thanks",
  "ok thank you",
  "okay thanks",
  "okay thank you",
  "ok great",
  "okay great",
  "ok perfect",
  "okay perfect",
  "ok sounds good",
  "okay sounds good",
  "got it thanks",
  "sounds good thanks",
  "sounds good thank you",
  "perfect thanks",
  "perfect thank you",
  "great thanks",
  "great thank you",
  "awesome thanks",
  "thanks ok"
]);

/** Longest raw inbound we'll even consider (acks are short by nature). */
const ACK_MAX_LENGTH = 40;

/**
 * Thumbs down, any skin tone (the U+1F3FB..U+1F3FF modifiers follow the base
 * codepoint, so matching the base covers every variant).
 */
const THUMBS_DOWN_RE = /\u{1F44E}/u;

/** Zero-width padding some renderers add around emoji (see sms_tapback.ts). */
const ZERO_WIDTH_RE = /[\u200B\u2060\uFEFF]/g;

/**
 * True when the message text is a bare acknowledgment. Full-string match on
 * the normalized text; anything with real content never matches.
 */
export function isBareAcknowledgmentText(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > ACK_MAX_LENGTH) return false;
  // Digits are never acks, numeric replies are meaningful ("1" claims a
  // team offer; "2" picks slot two).
  if (/\d/.test(t)) return false;
  // A thumbs down is never an ack, and the check sits above the phrase match
  // on purpose: "Ok 👎" normalizes to the ack phrase "ok", and swallowing a
  // grudging yes loses the complaint riding with it.
  if (THUMBS_DOWN_RE.test(t)) return false;
  const letters = t
    .toLowerCase()
    .replace(/[^\p{L}]+/gu, " ")
    .trim();
  if (letters === "") {
    // Letterless: an emoji reaction ("👍", "🙏🙏") is an ack; bare
    // punctuation, especially "?", is a nudge that deserves a reply.
    return /\p{Extended_Pictographic}/u.test(t) && !t.includes("?");
  }
  return ACK_PHRASES.has(letters.replace(/\s+/g, " "));
}

/**
 * True when the inbound is emoji only: no letters, no digits, at least one
 * emoji. Covers both the acks we swallow ("👍") and the ones we answer
 * ("👎", "🐬"), because either can land on a question the assistant just
 * asked, and neither says which answer it means without help.
 */
export function isEmojiOnlyText(text: string): boolean {
  const t = text.replace(ZERO_WIDTH_RE, "").trim();
  if (!t || t.length > ACK_MAX_LENGTH) return false;
  if (/[\p{L}\d]/u.test(t)) return false;
  return /\p{Extended_Pictographic}/u.test(t);
}

/**
 * The note that rides INSIDE the user turn when an emoji-only reply lands on
 * a question the assistant just asked. "🐬" answers nothing, and without
 * this the model picks a reading and moves on; with it, an unclear emoji
 * draws the question again. Same anchoring reason as formatFlowAnswerNote.
 */
export function formatEmojiOnlyAnswerNote(text: string): string {
  return (
    `(Note: the texter replied with only an emoji and no words: ` +
    `"${text.replace(ZERO_WIDTH_RE, "").trim()}". Read it as their answer to ` +
    `the question you asked when its meaning is clear: a thumbs down or a ` +
    `clearly negative emoji means no, and a thumbs up, a nod, or a clearly ` +
    `positive emoji means yes. Act on that answer in this reply. If the ` +
    `emoji does not clearly answer the question, ask it again in plain words ` +
    `instead of guessing.)`
  );
}

/**
 * True when the assistant's message invites a reply, it ends with a
 * question (ignoring trailing whitespace/quotes/emoji). An "Ok" after
 * "Does 2 PM Eastern work?" is an ANSWER, not filler, and must still get
 * its confirmation turn.
 */
export function assistantMessageInvitesReply(text: string): boolean {
  const t = text
    .trim()
    // Trailing closers that can follow the question mark.
    .replace(/[\s"'”’)\]\p{Extended_Pictographic}]+$/gu, "");
  return t.endsWith("?");
}
