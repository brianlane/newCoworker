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
