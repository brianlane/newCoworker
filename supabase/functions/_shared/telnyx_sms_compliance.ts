/**
 * CTIA-style carrier compliance keywords for inbound SMS (Telnyx).
 * https://www.ctia.org/the-wireless-association/industry-resources/messaging-principles-and-best-practices
 */

export function inboundSmsBody(payload: Record<string, unknown>): string {
  const t = payload["text"];
  if (typeof t === "string") return t;
  const body = payload["body"];
  if (typeof body === "string") return body;
  return "";
}

/** Single-word STOP variants (case-insensitive). */
export function isStopKeyword(normalizedUpper: string): boolean {
  return /^(STOP|STOPALL|UNSUBSCRIBE|CANCEL|END|QUIT)$/.test(normalizedUpper.trim());
}

export function isHelpKeyword(normalizedUpper: string): boolean {
  return /^HELP$/.test(normalizedUpper.trim());
}

/** START / UNSTOP — case-insensitive single token (carrier re-subscribe). */
export function isStartKeyword(normalizedUpper: string): boolean {
  return /^(START|YES|UNSTOP)$/.test(normalizedUpper.trim());
}

export async function telnyxSendSms(params: {
  apiKey: string;
  messagingProfileId: string;
  fromE164: string;
  toE164: string;
  text: string;
  fetchImpl?: typeof fetch;
  /**
   * Optional Telnyx `Idempotency-Key`. Set this on compliance auto-replies (STOP/HELP/START)
   * so that if the inbound webhook is retried by Telnyx, Telnyx itself will de-duplicate the
   * resulting outbound message instead of sending it twice.
   */
  idempotencyKey?: string;
}): Promise<{ ok: boolean; status: number; body: string }> {
  const fetchImpl = params.fetchImpl ?? fetch;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${params.apiKey}`,
    "Content-Type": "application/json"
  };
  if (params.idempotencyKey) {
    headers["Idempotency-Key"] = params.idempotencyKey;
  }
  const res = await fetchImpl("https://api.telnyx.com/v2/messages", {
    method: "POST",
    headers,
    body: JSON.stringify({
      to: params.toE164,
      from: params.fromE164,
      text: params.text,
      messaging_profile_id: params.messagingProfileId
    })
  });
  const body = await res.text();
  return { ok: res.ok, status: res.status, body };
}
