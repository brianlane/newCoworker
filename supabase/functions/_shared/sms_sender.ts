/**
 * Classifying an inbound SMS sender.
 *
 * Almost every sender is an E.164 phone. Lead services frequently are not: they
 * blast from a 5-digit SHORT CODE (ReferralExchange from 73339, Realtor.com from
 * 72825), which is a real, valid origination address that `normalizeE164`
 * correctly refuses to invent a country code for.
 *
 * That matters because a short code is ONE-WAY by design. A 10DLC or toll-free
 * number cannot text one back; carriers reject it. So an alert from a short code
 * is not a conversation and never gets a reply, and treating "no reply sent" as a
 * failed job made the inbound dead-letter count meaningless: 109 of them in 60
 * days were nothing but ReferralExchange and Realtor.com alerts whose flows had
 * ALREADY run correctly. A genuine inbound failure was invisible in that pile.
 */

/**
 * A short code: 3 to 6 bare digits, no plus and no separators. US/Canada short
 * codes are 5 or 6 digits; 3 and 4 are allowed because carriers and aggregators
 * do use them, and the only thing this gate decides is "do not try to reply".
 *
 * Deliberately strict about formatting: anything with a `+`, a space, or a dash
 * is a (possibly malformed) phone number, and calling that a short code would
 * silently stop replying to a real person.
 */
const SHORTCODE_RE = /^\d{3,6}$/;

export function isSmsShortcode(raw: string | null | undefined): boolean {
  if (!raw) return false;
  return SHORTCODE_RE.test(raw.trim());
}

/**
 * Why an inbound job got no assistant reply. `shortcode_sender` is expected and
 * routine; `no_text` means the message carried nothing to answer.
 */
export type NoReplyReason = "shortcode_sender" | "no_text";

/**
 * Decide what to do with a job the reply path cannot answer.
 *
 *   - `{ kind: "reply" }`, normal: there is a sender and something to say.
 *   - `{ kind: "skip", reason }`, expected and NOT a failure; complete the job.
 *   - `{ kind: "fail" }`, genuinely broken: an unusable sender that is
 *                                      not a short code, so dead-lettering it is
 *                                      real signal worth surfacing in admin.
 */
export function classifyReplyTarget(args: {
  /** The raw sender from the Telnyx payload; absent on a malformed envelope. */
  fromRaw: string | null | undefined;
  /** The normalized E.164, or "" / null when it could not be parsed. */
  fromE164: string | null;
  /** The message text (already defaulted for image-only messages). */
  text: string;
}): { kind: "reply" } | { kind: "skip"; reason: NoReplyReason } | { kind: "fail" } {
  const hasText = args.text.trim().length > 0;
  // A short code is unreplyable whether or not it sent text, and either way the
  // flow engine has already had its look at the message in the webhook.
  if (!args.fromE164 && isSmsShortcode(args.fromRaw)) {
    return { kind: "skip", reason: "shortcode_sender" };
  }
  if (!args.fromE164) return { kind: "fail" };
  if (!hasText) return { kind: "skip", reason: "no_text" };
  return { kind: "reply" };
}
