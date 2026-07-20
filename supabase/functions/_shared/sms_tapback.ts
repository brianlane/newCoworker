/**
 * iMessage tapback detection for SMS.
 *
 * When an iPhone user tapbacks (Like/Love/Haha/…) a message in a
 * green-bubble thread, Apple renders the reaction as literal SMS text:
 *
 *   Liked “Great, looking forward to it!”
 *   Removed a like from “Great, looking forward to it!”
 *   Reacted 🔥 to “Great, looking forward to it!”   (iOS 18+ emoji tapbacks)
 *
 * These are reactions, not messages — generating an AI reply to one reads
 * as bot noise (seen live: KYP Ads, 2026-07-20, the assistant answered a
 * Like with "Glad to hear it!"). The SMS worker suppresses the reply for
 * any inbound this detector matches, platform-wide; WhatsApp already skips
 * its native `reaction` events in src/lib/meta/webhook.ts, so this brings
 * SMS to parity.
 *
 * Matching is deliberately conservative: the verb must open the message
 * and a quoted body (curly or straight quotes) must span the REST of it,
 * so a genuine sentence like "Loved it!" or "Liked your proposal, let's
 * talk" is never suppressed. A tapback still counts as engagement
 * everywhere else — it resumes wait_for_reply, fires the `replied` goal,
 * and bumps interaction counters; only the generated reply is skipped.
 */

/** `Liked “…”` / `Loved "…"` … — the six classic tapback verbs. */
const TAPBACK_VERB_RE =
  /^(?:liked|loved|disliked|laughed at|emphasized|emphasised|questioned)\s+[“"][\s\S]+[”"]$/i;

/** `Removed a like from “…”` … — classic tapback removals. */
const TAPBACK_REMOVAL_RE =
  /^removed an?\s+(?:like|heart|dislike|laugh|exclamation(?:\s+point)?|question mark)\s+from\s+[“"][\s\S]+[”"]$/i;

/**
 * iOS 18 emoji tapbacks: `Reacted 🔥 to “…”` / `Removed 🔥 from “…”`.
 * The reaction token must contain no ASCII letters or digits (it's an
 * emoji, possibly a multi-codepoint sequence), so ordinary sentences like
 * "Reacted quickly to “the news”" never match.
 */
const TAPBACK_EMOJI_RE =
  /^(?:reacted\s+([^\sa-z0-9]{1,16})\s+to|removed\s+([^\sa-z0-9]{1,16})\s+from)\s+[“"][\s\S]+[”"]$/i;

/**
 * True when the message text is an iMessage tapback rendered over SMS.
 * Full-string match on the trimmed text; anything with extra content
 * before or after the tapback shape is treated as a real message.
 */
export function isTapbackText(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  return (
    TAPBACK_VERB_RE.test(t) || TAPBACK_REMOVAL_RE.test(t) || TAPBACK_EMOJI_RE.test(t)
  );
}
