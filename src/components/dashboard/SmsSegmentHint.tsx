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
   * Channel this composer will send on. "rcs" (Standard+ tenants with an
   * approved agent) is not bound by GSM/UCS-2 segment limits, so the emoji
   * warning softens: the RCS message itself delivers as typed — only the
   * automatic SMS fallback copy (sent to phones without RCS) is affected.
   */
  channel?: "sms" | "rcs";
};

/**
 * Inline warning for SMS text that contains emoji (or any non-GSM character)
 * and exceeds the 670-character UCS-2 sendable cap. Renders nothing while the
 * message is deliverable as typed, so composers stay clean in the common case.
 */
export function SmsSegmentHint({ text, mode, channel = "sms" }: Props) {
  // AiFlow sends run through the worker's gsmSafeSmsText, which normalizes
  // smart punctuation to ASCII before the encoding check — so only emoji-like
  // characters that survive normalization should trigger the aiflow warning.
  // Verbatim sends hit Telnyx as typed: smart quotes really do force UCS-2.
  const info = smsSegmentInfo(text, { normalizeSmartPunctuation: mode === "aiflow" });
  if (!info.exceedsUcs2SendableLimit) return null;
  if (channel === "rcs") {
    // RCS-first sends put the full text in the RCS leg; the sms_fallback leg
    // is sliced to Telnyx's 3072-char cap (truncated, never rejected). Below
    // that cap the fallback also goes out in full, so there is nothing to warn
    // about.
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
          `which caps texts at ${UCS2_MAX_SENDABLE_CHARS} characters — it will fail to send. ` +
          `Remove the emoji or shorten the message.`
        : `This message is ${info.length} characters and contains emoji or special characters, ` +
          `which caps texts at ${UCS2_MAX_SENDABLE_CHARS} characters. To keep it sendable, ` +
          `emoji will be converted to text versions (like :-)) or removed when it goes out.`}
    </p>
  );
}
