/**
 * AiFlows outbound-SMS compliance helpers.
 *
 * AiFlow `send_sms` steps can deliver COLD outbound (e.g. a scraped seller's
 * number from a lead page), which carries the highest carrier-filtering /
 * consent risk in the product. Two guards live here, used by the ai-flow-worker
 * before it ever calls Telnyx:
 *
 *   1. `ensureStopLanguage`, every cold body must carry opt-out language
 *      (CTIA / A2P 10DLC), appended idempotently.
 *   2. `isRecipientOptedOut`, never message a recipient who has sent STOP for
 *      this business (the same `sms_is_opted_out` RPC the inbound webhook uses).
 *
 * The business still owns consent; these are defense-in-depth so a misconfigured
 * flow can't silently spam or message an opted-out number.
 */

import { truncateAtWord } from "../text_truncate.ts";

/**
 * How many characters `truncateAtWord`'s "…" marker grows by once
 * `gsmSafeSmsText` expands it to ASCII "...". Reserved from the truncation
 * budget so the expansion cannot push a capped body back over the cap.
 */
const ELLIPSIS_GROWTH = 2;

/** Structural Supabase client (RPC only), see _shared/chat_spend_cap.ts. */
export interface ComplianceRpcClient {
  // PromiseLike (not Promise) so supabase-js's thenable PostgrestFilterBuilder
  // satisfies the interface structurally (same approach as _shared/cap_alerts.ts).
  rpc(
    fn: string,
    args: Record<string, unknown>
  ): PromiseLike<{ data: unknown; error: { message: string } | null }>;
}

export const STOP_SUFFIX = "Reply STOP to opt out.";
export const STOP_SUFFIX_ES = "Responde ALTO para cancelar.";

export function stopSuffixForLocale(locale?: string | null): string {
  return locale === "es" ? STOP_SUFFIX_ES : STOP_SUFFIX;
}

/**
 * Guarantee an opt-out instruction in a cold-outbound body. Idempotent: if the
 * body already mentions STOP it is returned unchanged; an empty body becomes
 * just the suffix.
 */
export function ensureStopLanguage(body: string, suffix: string = STOP_SUFFIX): string {
  // "ALTO" only counts as existing opt-out language in an actual opt-out
  // instruction ("responde/envía ALTO ..."), the bare word is everyday
  // Spanish ("un costo muy alto") and must not skip the required footer.
  if (/\bstop\b/i.test(body)) return body;
  if (/\b(responde|respondiendo|env[ií]a|texto|manda)\s+alto\b/i.test(body)) return body;
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
 * Characters that LOOK like a space but are not GSM-7, replaced with a plain
 * ASCII space. One of them anywhere re-encodes the whole message as UCS-2 and
 * cuts the per-segment budget from 153 characters to 67, so a message that
 * reads exactly the same costs roughly twice as much and eats twice as much of
 * the tenant's monthly text allowance.
 *
 * U+202F (NARROW NO-BREAK SPACE) is the one that actually bites:
 * `Intl.DateTimeFormat` puts it before AM/PM, so EVERY message that quotes a
 * clock time carries one. Measured across the fleet, Jun 1 to Aug 29 2026: 250
 * outbound sends were non-GSM for that character and nothing else, costing 834
 * wasted segments, 7.9% of every outbound SMS segment in that window.
 *
 * Deliberately limited to characters that occupy visible width, where a plain
 * space preserves the text exactly. Zero-width characters are NOT touched:
 * U+200D joins the parts of a family emoji and U+200C separates letters in
 * Persian and Indic scripts, so deleting them would corrupt content that
 * `gsmSafeSmsText` otherwise keeps intact.
 */
const GSM_UNSAFE_SPACES = /[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g;

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
    .replace(GSM_UNSAFE_SPACES, " ");
  if (!/[^\x00-\x7F]/.test(normalized)) return normalized;
  // Short enough to deliver as UCS-2: keep emoji (and any other symbols)
  // exactly as written. Emoji must never be downgraded when the message is
  // deliverable with them intact.
  if (normalized.length <= UCS2_MAX_SENDABLE_CHARS) return normalized;
  // Long + non-ASCII: the message can only be delivered as GSM-7, so the
  // symbols have to go. Downgrade common smileys to their ASCII emoticon
  // (better than disappearing), then drop whatever non-ASCII remains.
  return normalized
    .replace(/[\u{1F600}\u{1F603}\u{1F604}\u{1F60A}\u{1F642}]/gu, ":-)")
    .replace(/[^\x00-\x7F]/gu, "");
}

/**
 * Compose the full outbound-body pipeline in the only order that can't
 * produce an unsendable message: GSM-normalize, append the STOP suffix (cold
 * sends), then re-check the UCS-2 cap and the 10-segment GSM cap AFTER the
 * suffix. Appending after the cap check (the previous order) could push a
 * ≤670-char UCS-2 body past Telnyx's ten-segment limit, failing exactly the
 * sends the STOP suffix exists to protect.
 */
export function prepareSmsBody(
  raw: string,
  opts: { requireStop?: boolean; locale?: string | null } = {}
): string {
  // Recipient's language decides the opt-out wording (ALTO for es contacts).
  const suffix = stopSuffixForLocale(opts.locale);
  let body = gsmSafeSmsText(raw);
  if (opts.requireStop) body = ensureStopLanguage(body, suffix);
  // Suffix may have pushed a kept-emoji body past the UCS-2 sendable cap;
  // re-running the guard strips the non-GSM chars in that case.
  body = gsmSafeSmsText(body);
  if (body.length > SMS_MAX_BODY_CHARS) {
    // Word-boundary cut with a visible "..." marker, not a bare mid-word
    // slice (the Amy Laidlaw case in text_truncate.ts, where an alert ended
    // "Bud" and the budget figure vanished with no sign anything was
    // dropped). truncateAtWord marks the cut with a "…", which gsmSafeSmsText
    // then expands to three ASCII characters, so the budget has to reserve
    // the two it grows by or this re-overflows the very cap it enforces.
    const budget = opts.requireStop ? SMS_MAX_BODY_CHARS - suffix.length - 1 : SMS_MAX_BODY_CHARS;
    body = gsmSafeSmsText(truncateAtWord(body, budget - ELLIPSIS_GROWTH));
    if (opts.requireStop) body = ensureStopLanguage(body, suffix);
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
