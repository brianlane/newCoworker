/**
 * AiFlows outbound-SMS compliance helpers.
 *
 * AiFlow `send_sms` steps can deliver COLD outbound (e.g. a scraped seller's
 * number from a lead page), which carries the highest carrier-filtering /
 * consent risk in the product. Two guards live here, used by the ai-flow-worker
 * before it ever calls Telnyx:
 *
 *   1. `ensureStopLanguage` — every cold body must carry opt-out language
 *      (CTIA / A2P 10DLC), appended idempotently.
 *   2. `isRecipientOptedOut` — never message a recipient who has sent STOP for
 *      this business (the same `sms_is_opted_out` RPC the inbound webhook uses).
 *
 * The business still owns consent; these are defense-in-depth so a misconfigured
 * flow can't silently spam or message an opted-out number.
 */

/** Structural Supabase client (RPC only) — see _shared/chat_spend_cap.ts. */
export interface ComplianceRpcClient {
  rpc(
    fn: string,
    args: Record<string, unknown>
  ): Promise<{ data: unknown; error: { message: string } | null }>;
}

export const STOP_SUFFIX = "Reply STOP to opt out.";

/**
 * Guarantee an opt-out instruction in a cold-outbound body. Idempotent: if the
 * body already mentions STOP it is returned unchanged; an empty body becomes
 * just the suffix.
 */
export function ensureStopLanguage(body: string, suffix: string = STOP_SUFFIX): string {
  if (/\bstop\b/i.test(body)) return body;
  const trimmed = body.trim();
  return trimmed.length > 0 ? `${trimmed} ${suffix}` : suffix;
}

/**
 * One non-GSM character anywhere in an SMS forces UCS-2 encoding for the WHOLE
 * message: 67 chars per segment instead of 153, and Telnyx hard-rejects
 * anything over 10 segments (error 40302 "Message too large"). 10 × 67 = 670
 * is therefore the longest UCS-2 message that can be sent at all.
 */
export const UCS2_MAX_SENDABLE_CHARS = 670;

/**
 * Longest body the worker will hand to Telnyx: just under 10 GSM segments
 * (10 × 153 = 1530), minus headroom for the appended STOP suffix.
 */
export const SMS_MAX_BODY_CHARS = 1500;

/**
 * Make an outbound body safe to actually deliver.
 *
 * Live failure this guards against: a flow template written with smart quotes
 * and a 😊 produced a ~1300-char intro that Telnyx rejected outright (15 UCS-2
 * parts > the 10-part cap), so the "approved" SMS never sent. Smart
 * punctuation is always normalized to its ASCII equivalent (same words, GSM
 * encodable). Emoji are kept when the message is short enough to survive
 * UCS-2 encoding (≤ 670 chars) and stripped only when keeping them would make
 * the message unsendable.
 */
export function gsmSafeSmsText(text: string): string {
  const normalized = text
    .replace(/[\u2018\u2019\u02BC]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\u2026/g, "...")
    .replace(/\u00A0/g, " ")
    .replace(/[\u{1F600}\u{1F603}\u{1F604}\u{1F60A}\u{1F642}]/gu, ":-)");
  if (!/[^\x00-\x7F]/.test(normalized)) return normalized;
  if (normalized.length <= UCS2_MAX_SENDABLE_CHARS) return normalized;
  // Long + still non-ASCII: dropping the remaining symbols is the only way
  // the message can be delivered at all.
  return normalized.replace(/[^\x00-\x7F]/gu, "");
}

/**
 * Compose the full outbound-body pipeline in the only order that can't
 * produce an unsendable message: GSM-normalize, append the STOP suffix (cold
 * sends), then re-check the UCS-2 cap and the 10-segment GSM cap AFTER the
 * suffix. Appending after the cap check (the previous order) could push a
 * ≤670-char UCS-2 body past Telnyx's ten-segment limit — failing exactly the
 * sends the STOP suffix exists to protect.
 */
export function prepareSmsBody(raw: string, opts: { requireStop?: boolean } = {}): string {
  let body = gsmSafeSmsText(raw);
  if (opts.requireStop) body = ensureStopLanguage(body);
  // Suffix may have pushed a kept-emoji body past the UCS-2 sendable cap;
  // re-running the guard strips the non-GSM chars in that case.
  body = gsmSafeSmsText(body);
  if (body.length > SMS_MAX_BODY_CHARS) {
    body = opts.requireStop
      ? ensureStopLanguage(body.slice(0, SMS_MAX_BODY_CHARS - STOP_SUFFIX.length - 1))
      : body.slice(0, SMS_MAX_BODY_CHARS);
  }
  return body;
}

/**
 * True when `toE164` has opted out of SMS for this business. Throws on a hard
 * RPC error so the worker treats it as a retryable failure rather than sending
 * to a possibly opted-out number.
 */
export async function isRecipientOptedOut(
  client: ComplianceRpcClient,
  businessId: string,
  toE164: string
): Promise<boolean> {
  const { data, error } = await client.rpc("sms_is_opted_out", {
    p_business_id: businessId,
    p_sender_e164: toE164
  });
  if (error) throw new Error(`sms_is_opted_out: ${error.message}`);
  return data === true;
}
