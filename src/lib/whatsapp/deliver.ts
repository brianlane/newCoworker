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
  sanitizeWhatsAppTemplateParam,
  sendWhatsAppMessage,
  sendWhatsAppTemplate,
  whatsappTemplateStateKey,
  WHATSAPP_STOCK_TEMPLATES
} from "@/lib/meta/client";
import { getContactLanguage } from "@/lib/db/contact-language";
import {
  appendMessengerMessage,
  getMessengerConversationByIdentityPublic,
  insertOutboundMessengerConversation,
  messengerWindowOpen,
  type MessengerConversationRow
} from "@/lib/messenger/db";
import { getBusiness } from "@/lib/db/businesses";
import { logger } from "@/lib/logger";

export type DeliverWhatsAppAudience = "owner" | "contact";

export type DeliverWhatsAppResult =
  | { ok: true; via: "text" | "template"; messageId: string | null }
  | {
      ok: false;
      /**
       * `not_connected` strictly means "no active WhatsApp integration"
       * (callers steer owners to the Integrations page on it); transient
       * infrastructure failures — connection/conversation reads throwing —
       * surface as `send_failed` so retry paths treat them as retryable.
       */
      reason:
        | "not_connected"
        | "invalid_recipient"
        | "empty_text"
        | "template_not_approved"
        | "send_failed";
      detail?: string;
    };

const AUDIENCE_TEMPLATE: Record<DeliverWhatsAppAudience, string> = {
  owner: "nc_owner_alert",
  contact: "nc_contact_followup"
};

/**
 * wa_id form the Cloud API expects: E.164 digits without the plus.
 *
 * NOT NANP-only: inbound webhooks store the customer's wa_id as full
 * international digits (often plus-less), and AiFlow vars/MCP callers
 * pass those digits straight back. Any 8-15 digit non-zero-leading run
 * is accepted as an international number; a bare 10-digit NANP number
 * keeps the +1 convenience prepend.
 */
export function toWaId(phone: string): string | null {
  const trimmed = phone.trim();
  const digits = trimmed.replace(/\D/g, "");
  if (!digits || digits.startsWith("0")) return null;
  // Bare 10 digits without an explicit country code reads as US/Canada
  // (matches the SMS surfaces' NANP coercion).
  if (digits.length === 10 && !trimmed.startsWith("+")) return `1${digits}`;
  if (digits.length >= 8 && digits.length <= 15) return digits;
  return null;
}

export type DeliverWhatsAppDeps = {
  getConnection?: (businessId: string) => Promise<WhatsAppConnectionRow | null>;
  getConversation?: typeof getMessengerConversationByIdentityPublic;
  createConversation?: typeof insertOutboundMessengerConversation;
  appendMessage?: typeof appendMessengerMessage;
  sendText?: typeof sendWhatsAppMessage;
  sendTemplate?: typeof sendWhatsAppTemplate;
  fetchBusinessName?: (businessId: string) => Promise<string | null>;
  /** Contact-audience language lookup for the template-variant pick. */
  fetchContactLanguage?: (
    businessId: string,
    customerE164: string
  ) => Promise<{ preferred_language: "en" | "es" | null } | null>;
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
    /**
     * Recipient language for the out-of-window template pick. When omitted
     * for contact sends, the stored contact preference is looked up;
     * English remains the default and the fallback when the es_US variant
     * isn't approved.
     */
    language?: "en" | "es";
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
  const fetchContactLanguage = deps.fetchContactLanguage ?? getContactLanguage;
  const now = deps.now ?? (() => new Date());
  /* c8 ignore stop */

  const text = input.text.trim();
  if (!text) {
    return { ok: false, reason: "empty_text" };
  }
  const waId = toWaId(input.to);
  if (!waId) {
    return { ok: false, reason: "invalid_recipient", detail: input.to };
  }

  let connection: WhatsAppConnectionRow | null;
  try {
    connection = await getConnection(input.businessId);
  } catch (err) {
    // A throwing read is an infrastructure blip, not "the owner never
    // connected WhatsApp" — report it retryable so AiFlows/alerts don't
    // log a misleading not-connected skip.
    logger.warn("deliverWhatsApp: connection read failed", {
      businessId: input.businessId,
      error: err instanceof Error ? err.message : String(err)
    });
    return { ok: false, reason: "send_failed", detail: "connection_read_failed" };
  }
  if (!connection?.accessToken || !connection.is_active) {
    return { ok: false, reason: "not_connected" };
  }

  // Window check: an existing conversation whose last inbound message is
  // under 24h old permits free-form text; absent/stale means the template
  // path. A FAILING read must not silently pick the billed template path
  // (the recipient may be in an open, free window) — it fails retryable.
  const readConversation = (): Promise<MessengerConversationRow | null | "read_failed"> =>
    getConversation(input.businessId, connection.phone_number_id, "whatsapp", waId).catch(
      (err) => {
        logger.warn("deliverWhatsApp: conversation read failed", {
          businessId: input.businessId,
          error: err instanceof Error ? err.message : String(err)
        });
        return "read_failed" as const;
      }
    );
  let firstRead = await readConversation();
  if (firstRead === "read_failed") {
    // One immediate retry before giving up (the second read exists for
    // the race-narrowing below anyway).
    firstRead = await readConversation();
    if (firstRead === "read_failed") {
      return { ok: false, reason: "send_failed", detail: "conversation_read_failed" };
    }
  }
  let conversation: MessengerConversationRow | null = firstRead;
  let windowOpen = conversation ? messengerWindowOpen(conversation, now()) : false;
  if (!windowOpen) {
    // Narrow the read→send race: a customer's first inbound message can
    // open the window between the read above and the send below — a
    // second read right before committing to the billed template path
    // flips those sends back to free (and unbilled) text. A failing
    // re-read keeps the first read's verdict (already a good read).
    const fresh = await readConversation();
    if (fresh && fresh !== "read_failed") {
      conversation = fresh;
      windowOpen = messengerWindowOpen(fresh, now());
    }
  }

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

    // Language pick: explicit input wins; contact sends fall back to the
    // stored contact preference. Spanish only applies when the es_US
    // variant is APPROVED — otherwise the English variant keeps working
    // exactly as before.
    let wantEs = input.language === "es";
    if (input.language === undefined && input.audience === "contact") {
      try {
        const row = await fetchContactLanguage(input.businessId, `+${waId}`);
        wantEs = row?.preferred_language === "es";
      } catch {
        wantEs = false;
      }
    }
    const esState = wantEs
      ? connection.templates?.[whatsappTemplateStateKey(templateName, "es_US")]
      : undefined;
    const useEs = esState?.status === "APPROVED";
    const templateState = useEs ? esState : connection.templates?.[templateName];
    if (templateState?.status !== "APPROVED") {
      return {
        ok: false,
        reason: "template_not_approved",
        detail: `${templateName}: ${templateState?.status ?? "not registered"}`
      };
    }
    const templateLanguage = useEs ? "es_US" : "en_US";
    const stock = WHATSAPP_STOCK_TEMPLATES.find(
      (t) => t.name === templateName && t.language === templateLanguage
    );
    /* c8 ignore next 3 -- unreachable: AUDIENCE_TEMPLATE only maps stock names */
    if (!stock) {
      return { ok: false, reason: "template_not_approved", detail: templateName };
    }
    const businessName = (await fetchBusinessName(input.businessId)) ?? "your business";
    via = "template";
    // The transcript stores what the recipient ACTUALLY read: the same
    // whitespace-collapse + length cap the Cloud API client applies to
    // the body parameters.
    transcriptText = stock.bodyText
      .replace("{{1}}", () => sanitizeWhatsAppTemplateParam(businessName))
      .replace("{{2}}", () => sanitizeWhatsAppTemplateParam(text));
    try {
      const sent = await sendTemplate(connection.phone_number_id, connection.accessToken, waId, {
        name: templateName,
        language: useEs ? "es_US" : templateState.language || stock.language,
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
