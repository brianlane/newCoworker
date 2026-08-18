import {
  smsSegmentInfo,
  RCS_SMS_FALLBACK_MAX_CHARS,
  UCS2_MAX_SENDABLE_CHARS
} from "@/lib/sms/segment-info";

type Props = {
  text: string;
  /**
   * Verbatim sends (dashboard composers) are handed to Telnyx as typed and
   * FAIL outright past the cap; templated sends (AiFlow steps) are auto-fixed
   * by the worker, which converts emoji to ASCII emoticons or strips them.
   * The warning copy tells the user which fate awaits.
   */
  mode: "verbatim" | "aiflow";
  /**
   * Channel this composer will send on. "rcs" (Enterprise tenants with an
   * approved agent) is not bound by GSM/UCS-2 segment limits, so the emoji
   * warning softens: the RCS message itself delivers as typed, only the
   * automatic SMS fallback copy (sent to phones without RCS) is affected.
   */
  channel?: "sms" | "rcs";
};

/**
 * Inline segment/cost hint for SMS composers.
 *
 * Two jobs, layered:
 *  1. COST (new with weighted metering): once a message needs 2+ parts, say
 *     how many texts it counts as against the monthly allowance, at the one
 *     moment the author can still shorten it. Carriers have always billed
 *     long messages as several texts; this makes the arithmetic visible where
 *     the expensive messages are actually written (thread composer, new-
 *     message composer, and the AiFlow editor, where the 10-part flow bodies that
 *     motivated this were authored blind).
 *  2. DELIVERABILITY (pre-existing): emoji/non-GSM text over the 670-char
 *     UCS-2 sendable cap either fails outright (verbatim) or gets its emoji
 *     converted (aiflow); RCS-first sends only truncate the SMS fallback leg.
 *
 * Renders nothing for a single-part message, so composers stay clean in the
 * common case.
 */
export function SmsSegmentHint({ text, mode, channel = "sms" }: Props) {
  // AiFlow sends run through the worker's gsmSafeSmsText, which normalizes
  // smart punctuation to ASCII before the encoding check, so only emoji-like
  // characters that survive normalization should trigger the aiflow warning.
  // Verbatim sends hit Telnyx as typed: smart quotes really do force UCS-2.
  const info = smsSegmentInfo(text, { normalizeSmartPunctuation: mode === "aiflow" });
  if (info.exceedsUcs2SendableLimit) {
    if (channel === "rcs") {
      // RCS-first sends put the full text in the RCS leg; the sms_fallback leg
      // is sliced to Telnyx's 3072-char cap (truncated, never rejected). Below
      // that cap the fallback also goes out in full, so only truncation is
      // worth warning about.
      if (info.length <= RCS_SMS_FALLBACK_MAX_CHARS) return null;
      return (
        <p className="text-xs text-spark-orange" role="alert">
          {`This message is ${info.length} characters. It will deliver in full over RCS, ` +
            `but recipients without RCS get an SMS fallback truncated to the first ` +
            `${RCS_SMS_FALLBACK_MAX_CHARS} characters.`}
        </p>
      );
    }
    return (
      <p className="text-xs text-spark-orange" role="alert">
        {mode === "verbatim"
          ? `This message is ${info.length} characters and contains emoji or special characters, ` +
            `which caps texts at ${UCS2_MAX_SENDABLE_CHARS} characters, so it will fail to send. ` +
            `Remove the emoji or shorten the message.`
          : `This message is ${info.length} characters and contains emoji or special characters, ` +
            `which caps texts at ${UCS2_MAX_SENDABLE_CHARS} characters. To keep it sendable, ` +
            `emoji will be converted to text versions (like :-)) or removed when it goes out.`}
      </p>
    );
  }
  // Cost hint: a multi-part message counts as several texts against the
  // monthly allowance. RCS-first sends are exempt (the RCS leg bills as one
  // message; only handsets without RCS get the multi-part SMS fallback).
  if (channel !== "rcs" && info.segments >= 2) {
    return (
      <p className="text-xs text-parchment/50">
        {`This message is ${info.length} characters, so it sends as ${info.segments} texts ` +
          `(each 160 characters counts as one text, or 70 with emoji).`}
      </p>
    );
  }
  return null;
}
