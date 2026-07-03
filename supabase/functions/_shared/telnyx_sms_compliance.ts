/**
 * CTIA-style carrier compliance keywords for inbound SMS (Telnyx).
 * https://www.ctia.org/the-wireless-association/industry-resources/messaging-principles-and-best-practices
 */

export function inboundSmsBody(payload: Record<string, unknown>): string {
  const t = payload["text"];
  if (typeof t === "string") return t;
  const body = payload["body"];
  if (typeof body === "string") return body;
  // RCS inbound (`payload.type === "RCS"`) nests content under a body OBJECT:
  // `body.text` for typed messages, `body.suggestion_response.text` when the
  // user tapped a suggested reply/action (the tapped label IS the message).
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const b = body as Record<string, unknown>;
    if (typeof b["text"] === "string") return b["text"];
    const suggestion = b["suggestion_response"];
    if (suggestion && typeof suggestion === "object") {
      const st = (suggestion as Record<string, unknown>)["text"];
      if (typeof st === "string") return st;
    }
  }
  return "";
}

/** True when a Telnyx `message.received` payload arrived on the RCS channel. */
export function isRcsInboundPayload(payload: Record<string, unknown>): boolean {
  return payload["type"] === "RCS";
}

/**
 * The RCS agent id an inbound RCS message was addressed to (`to[].agent_id`).
 * RCS inbound webhooks carry NO recipient phone number — the agent id is the
 * only routing key, resolved against business_channel_settings.rcs_agent_id.
 */
export function rcsInboundAgentId(payload: Record<string, unknown>): string | null {
  const to = payload["to"];
  const list = Array.isArray(to) ? to : to && typeof to === "object" ? [to] : [];
  for (const item of list) {
    if (item && typeof item === "object") {
      const agentId = (item as Record<string, unknown>)["agent_id"];
      if (typeof agentId === "string" && agentId.length > 0) return agentId;
    }
  }
  return null;
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
  /**
   * Optional sender E.164. Leave empty/undefined to let Telnyx pick a sender
   * from the messaging profile's number pool — the correct behaviour for
   * tenants that don't have a dedicated `telnyx_sms_from_e164` configured.
   * When empty we must OMIT the `from` key entirely (sending "" would 400).
   */
  fromE164?: string;
  /**
   * Recipient E.164, or an ARRAY of recipients for a group MMS (Telnyx accepts
   * `to` as a list and fans the message into one group thread). An empty array
   * is rejected by Telnyx, so callers must pass at least one number.
   */
  toE164: string | string[];
  text: string;
  /**
   * Optional public/signed media URLs. When non-empty the message is sent as
   * MMS (Telnyx fetches each URL at send time). The from-number must be
   * MMS-enabled or Telnyx rejects the request.
   */
  mediaUrls?: string[];
  fetchImpl?: typeof fetch;
  /**
   * Optional Telnyx `Idempotency-Key`. Set this on compliance auto-replies (STOP/HELP/START)
   * so that if the inbound webhook is retried by Telnyx, Telnyx itself will de-duplicate the
   * resulting outbound message instead of sending it twice.
   */
  idempotencyKey?: string;
  /**
   * Tenant's approved Telnyx RCS agent id (resolve via
   * _shared/channel_settings.ts `resolveRcsAgentId`). When set — and the send
   * is a single-recipient, no-media text with a concrete `fromE164` for the
   * SMS fallback — the message goes out RCS-FIRST (`POST /v2/messages/rcs`,
   * verified-brand sender, read receipts) with automatic SMS fallback to
   * non-RCS devices. Group sends, MMS, and pool-sender sends stay on the
   * plain SMS/MMS path. Callers that must stay plain SMS (carrier compliance
   * auto-replies) simply never pass this.
   */
  rcsAgentId?: string | null;
}): Promise<{ ok: boolean; status: number; body: string; channel: "sms" | "rcs" }> {
  const fetchImpl = params.fetchImpl ?? fetch;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${params.apiKey}`,
    "Content-Type": "application/json"
  };
  if (params.idempotencyKey) {
    headers["Idempotency-Key"] = params.idempotencyKey;
  }
  const fromTrimmed = (params.fromE164 ?? "").trim();
  const agentId = (params.rcsAgentId ?? "").trim();
  const hasMedia = Boolean(params.mediaUrls && params.mediaUrls.length > 0);
  const useRcs =
    agentId.length > 0 && typeof params.toE164 === "string" && !hasMedia && fromTrimmed.length > 0;

  if (useRcs) {
    const rcsBody: Record<string, unknown> = {
      agent_id: agentId,
      to: params.toE164,
      messaging_profile_id: params.messagingProfileId,
      type: "RCS",
      agent_message: { content_message: { text: params.text } },
      // Plain-text fallback from the tenant's existing number for devices /
      // carriers without RCS. Telnyx caps fallback text at 3072 chars.
      sms_fallback: { from: fromTrimmed, text: params.text.slice(0, 3072) }
    };
    const res = await fetchImpl("https://api.telnyx.com/v2/messages/rcs", {
      method: "POST",
      headers,
      body: JSON.stringify(rcsBody)
    });
    const bodyText = await res.text();
    if (res.ok) {
      // A 2xx without data.id means Telnyx did not durably create the message
      // (nothing to track, reconcile, or deliver). Treat it like a rejection
      // and deliver over plain SMS — same behavior as the Node helper and the
      // inbound worker.
      let rcsMessageId = "";
      try {
        const json = JSON.parse(bodyText) as { data?: { id?: string } };
        rcsMessageId = json.data?.id ?? "";
      } catch {
        /* unparseable body → treat as missing id */
      }
      if (rcsMessageId) {
        return { ok: true, status: res.status, body: bodyText, channel: "rcs" };
      }
      console.warn("telnyxSendSms: RCS 2xx with no message id, falling back to SMS");
    } else {
      // RCS API rejection (agent revoked, destination not routable, …): fall
      // through to plain SMS so channel plumbing never drops a customer message.
      // The idempotency key is safe to reuse — the rejected request created no
      // message. Warn so operators notice misconfigured agents.
      console.warn(
        `telnyxSendSms: RCS send rejected (${res.status}), falling back to SMS:`,
        bodyText.slice(0, 200)
      );
    }
  }

  const body: Record<string, unknown> = {
    to: params.toE164,
    text: params.text,
    messaging_profile_id: params.messagingProfileId
  };
  if (fromTrimmed) body.from = fromTrimmed;
  if (hasMedia) body.media_urls = params.mediaUrls;
  const res = await fetchImpl("https://api.telnyx.com/v2/messages", {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });
  const bodyText = await res.text();
  return { ok: res.ok, status: res.status, body: bodyText, channel: "sms" };
}

/**
 * Send a group MMS to 2+ recipients via Telnyx's dedicated endpoint
 * (`POST /v2/messages/group_mms`). The standard `/v2/messages` endpoint rejects
 * a multi-destination `to` for SMS ("Destination number array must have a
 * length of exactly 1"); group messaging lives on its own endpoint, fans the
 * message into a single group thread, and is delivered as MMS.
 *
 * `from` is REQUIRED here (unlike the single-send number-pool case) — a group
 * MMS must originate from a specific MMS-enabled number. Telnyx caps the group
 * at 8 recipients; callers should pre-trim.
 */
export async function telnyxSendGroupMms(params: {
  apiKey: string;
  /** MMS-enabled sender E.164 (required for group MMS). */
  fromE164: string;
  /** 2+ recipient E.164 numbers (the other group participants). */
  toE164: string[];
  text: string;
  /** Optional media URLs; group MMS may be text-only. */
  mediaUrls?: string[];
  fetchImpl?: typeof fetch;
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
  const body: Record<string, unknown> = {
    from: params.fromE164,
    to: params.toE164,
    text: params.text
  };
  if (params.mediaUrls && params.mediaUrls.length > 0) body.media_urls = params.mediaUrls;
  const res = await fetchImpl("https://api.telnyx.com/v2/messages/group_mms", {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });
  const bodyText = await res.text();
  return { ok: res.ok, status: res.status, body: bodyText };
}
