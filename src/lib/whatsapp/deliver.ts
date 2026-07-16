/**
 * Central outbound WhatsApp delivery — the ONE path every business-
 * initiated send takes (AiFlow send_whatsapp steps, owner alerts, the
 * dashboard coworker tool). Conversational replies from the messenger
 * worker do NOT come through here (they are always in-window free-form).
 *
 * Policy routing:
 *   * 24h service window OPEN (the recipient messaged the business's
 *     WhatsApp within 24h) → free-form text, exactly as written.
 *   * Window CLOSED → the pre-approved utility template for the audience
 *     (owner_alert / contact_followup), with the text as the body
 *     variable — Meta bills the tenant per template message.
 *   * Template not APPROVED (still in review, rejected, or registration
 *     failed) → honest structured skip; the caller reports it and other
 *     channels (SMS/email) still fire.
 *
 * Every delivered message is appended to the recipient's
 * messenger_conversations transcript (creating the row when absent, with
 * last_user_message_at backdated so a fresh row does NOT fake an open
 * window) so replies thread straight into the WhatsApp inbox.
 */

import {
  getWhatsAppConnection,
  type WhatsAppConnectionRow
} from "@/lib/db/whatsapp-connections";
import {
  sendWhatsAppMessage,
  sendWhatsAppTemplate,
  WHATSAPP_STOCK_TEMPLATES
} from "@/lib/meta/client";
import {
  appendMessengerMessage,
  getMessengerConversationByIdentityPublic,
  insertOutboundMessengerConversation,
  messengerWindowOpen
} from "@/lib/messenger/db";
import { getBusiness } from "@/lib/db/businesses";
import { coerceOwnerPhoneToE164 } from "@/lib/telnyx/assign-did";
import { logger } from "@/lib/logger";

export type DeliverWhatsAppAudience = "owner" | "contact";

export type DeliverWhatsAppResult =
  | { ok: true; via: "text" | "template"; messageId: string | null }
  | {
      ok: false;
      reason:
        | "not_connected"
        | "invalid_recipient"
        | "template_not_approved"
        | "send_failed";
      detail?: string;
    };

const AUDIENCE_TEMPLATE: Record<DeliverWhatsAppAudience, string> = {
  owner: "nc_owner_alert",
  contact: "nc_contact_followup"
};

/** wa_id form Cloud API expects: E.164 digits without the plus. */
export function toWaId(phone: string): string | null {
  const e164 = coerceOwnerPhoneToE164(phone);
  return e164 ? e164.replace(/^\+/, "") : null;
}

export type DeliverWhatsAppDeps = {
  getConnection?: (businessId: string) => Promise<WhatsAppConnectionRow | null>;
  getConversation?: typeof getMessengerConversationByIdentityPublic;
  createConversation?: typeof insertOutboundMessengerConversation;
  appendMessage?: typeof appendMessengerMessage;
  sendText?: typeof sendWhatsAppMessage;
  sendTemplate?: typeof sendWhatsAppTemplate;
  fetchBusinessName?: (businessId: string) => Promise<string | null>;
  now?: () => Date;
};

/* c8 ignore start -- thin default; tests inject explicit deps */
async function fetchBusinessNameDefault(businessId: string): Promise<string | null> {
  try {
    const business = await getBusiness(businessId);
    return business?.name?.trim() || null;
  } catch {
    return null;
  }
}
/* c8 ignore stop */

export async function deliverWhatsApp(
  input: {
    businessId: string;
    /** Recipient phone, any reasonable format; coerced to E.164/wa_id. */
    to: string;
    text: string;
    audience: DeliverWhatsAppAudience;
  },
  deps: DeliverWhatsAppDeps = {}
): Promise<DeliverWhatsAppResult> {
  /* c8 ignore start -- production default deps; tests inject explicit deps */
  const getConnection = deps.getConnection ?? getWhatsAppConnection;
  const getConversation =
    deps.getConversation ?? getMessengerConversationByIdentityPublic;
  const createConversation =
    deps.createConversation ?? insertOutboundMessengerConversation;
  const appendMessage = deps.appendMessage ?? appendMessengerMessage;
  const sendText = deps.sendText ?? sendWhatsAppMessage;
  const sendTemplate = deps.sendTemplate ?? sendWhatsAppTemplate;
  const fetchBusinessName = deps.fetchBusinessName ?? fetchBusinessNameDefault;
  const now = deps.now ?? (() => new Date());
  /* c8 ignore stop */

  const text = input.text.trim();
  const waId = toWaId(input.to);
  if (!waId || !text) {
    return { ok: false, reason: "invalid_recipient", detail: input.to };
  }

  let connection: WhatsAppConnectionRow | null;
  try {
    connection = await getConnection(input.businessId);
  } catch (err) {
    logger.warn("deliverWhatsApp: connection read failed", {
      businessId: input.businessId,
      error: err instanceof Error ? err.message : String(err)
    });
    return { ok: false, reason: "not_connected" };
  }
  if (!connection?.accessToken || !connection.is_active) {
    return { ok: false, reason: "not_connected" };
  }

  // Window check: an existing conversation whose last inbound message is
  // under 24h old permits free-form text. No conversation (or a stale
  // one) means the template path.
  let conversation = await getConversation(
    input.businessId,
    connection.phone_number_id,
    "whatsapp",
    waId
  ).catch((err) => {
    logger.warn("deliverWhatsApp: conversation read failed; assuming closed window", {
      businessId: input.businessId,
      error: err instanceof Error ? err.message : String(err)
    });
    return null;
  });
  const windowOpen = conversation ? messengerWindowOpen(conversation, now()) : false;

  let via: "text" | "template";
  let messageId: string | null;
  let transcriptText: string;
  if (windowOpen) {
    via = "text";
    transcriptText = text;
    try {
      const sent = await sendText(connection.phone_number_id, connection.accessToken, waId, text);
      messageId = sent.messageId;
    } catch (err) {
      return {
        ok: false,
        reason: "send_failed",
        detail: err instanceof Error ? err.message : String(err)
      };
    }
  } else {
    const templateName = AUDIENCE_TEMPLATE[input.audience];
    const templateState = connection.templates?.[templateName];
    if (templateState?.status !== "APPROVED") {
      return {
        ok: false,
        reason: "template_not_approved",
        detail: `${templateName}: ${templateState?.status ?? "not registered"}`
      };
    }
    const stock = WHATSAPP_STOCK_TEMPLATES.find((t) => t.name === templateName);
    /* c8 ignore next 3 -- unreachable: AUDIENCE_TEMPLATE only maps stock names */
    if (!stock) {
      return { ok: false, reason: "template_not_approved", detail: templateName };
    }
    const businessName = (await fetchBusinessName(input.businessId)) ?? "your business";
    via = "template";
    // The transcript stores what the recipient actually read.
    transcriptText = stock.bodyText
      .replace("{{1}}", businessName)
      .replace("{{2}}", text);
    try {
      const sent = await sendTemplate(connection.phone_number_id, connection.accessToken, waId, {
        name: templateName,
        language: templateState.language || stock.language,
        bodyParams: [businessName, text]
      });
      messageId = sent.messageId;
    } catch (err) {
      return {
        ok: false,
        reason: "send_failed",
        detail: err instanceof Error ? err.message : String(err)
      };
    }
  }

  // Transcript append (best-effort — the send already happened): thread
  // the outbound into the WhatsApp inbox so a reply lands in context.
  try {
    if (!conversation) {
      conversation = await createConversation({
        businessId: input.businessId,
        pageId: connection.phone_number_id,
        platform: "whatsapp",
        psid: waId
      });
    }
    if (conversation) {
      await appendMessage({
        conversationId: conversation.id,
        businessId: input.businessId,
        role: "owner",
        content: transcriptText
      });
    }
  } catch (err) {
    logger.warn("deliverWhatsApp: transcript append failed (send already delivered)", {
      businessId: input.businessId,
      error: err instanceof Error ? err.message : String(err)
    });
  }

  return { ok: true, via, messageId };
}
