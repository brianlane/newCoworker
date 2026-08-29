/**
 * Everything Telegram does inside its webhook's ack window: work out who is
 * writing, enrol them if they are proving who they are, and otherwise queue
 * a reply job. The turn itself runs later, in the shared worker.
 *
 * THE ONE RULE THAT MATTERS HERE: an account this business has not
 * connected is NOT staff, and gets no turn. Telegram tells us nothing about
 * a sender that the sender did not choose (an opaque `from.id`, and a
 * self-chosen re-assignable @username), so "I have not seen this account
 * before" is the only safe reading of an unknown id. Anyone can find a bot
 * and message it.
 *
 * There are exactly two ways to stop being unknown, and both end in a row
 * in `coworker_channel_identities`:
 *
 *   1. Sharing a contact card. Telegram verifies phone numbers at signup,
 *      so this yields a real E.164. The card MUST be their own, which
 *      Telegram reports as `contact.user_id === message.from.id`; without
 *      that check anyone could forward a colleague's contact card and
 *      inherit that colleague's powers.
 *   2. Redeeming a single-use code minted in the dashboard by a session
 *      that already held manage_settings.
 */

import { getBusiness } from "@/lib/db/businesses";
import {
  getOrCreateCoworkerConversation,
  insertCoworkerUserMessage,
  listCoworkerMessages,
  markCoworkerHelloSent,
  updateCoworkerConversationIdentity
} from "@/lib/db/coworker-chat";
import {
  findChannelIdentity,
  redeemLinkCode,
  upsertChannelIdentity
} from "@/lib/db/coworker-identities";
import { resolveSurfaceSpeaker } from "@/lib/owner-surfaces/speaker";
import { resolveOwnerUiLocaleForEmail } from "@/lib/i18n/owner-locale";
import type { CoworkerConnectionRow } from "@/lib/db/coworker-connections";
import { telegramSendMessage } from "@/lib/telegram/client";
import {
  telegramContactNotYoursMessage,
  telegramLinkAcceptedMessage,
  telegramLinkRejectedMessage,
  telegramNeedsLinkingMessage,
  telegramOnboardingMessage,
  telegramShareContactButton
} from "@/lib/telegram/chat";
import { normalizeLinkCode } from "@/lib/db/coworker-identities";
import { logger } from "@/lib/logger";

/** The slice of a Telegram `message` update this channel reads. */
type TelegramInboundMessage = {
  message_id: number;
  date?: number;
  from?: { id: number; is_bot?: boolean; first_name?: string; last_name?: string; username?: string };
  chat?: { id: number; type?: string };
  text?: string;
  contact?: { phone_number?: string; user_id?: number };
};

export type TelegramUpdate = {
  update_id?: number;
  message?: TelegramInboundMessage;
};

export type TelegramInboundResult = {
  enqueued: boolean;
  reason?: string;
};

/** Telegram sends a bare `+` only sometimes; normalise to strict E.164. */
function telegramContactToE164(raw: string | undefined | null): string | null {
  const digits = (raw ?? "").replace(/[^\d]/g, "");
  if (digits.length < 7 || digits.length > 15) return null;
  return `+${digits}`;
}

/** A plausible enrolment code, before we spend a database read on it. */
function looksLikeLinkCode(text: string): boolean {
  return /^[A-Za-z0-9]{8}$/.test(normalizeLinkCode(text));
}

/* c8 ignore start -- production default for `locale`; tests inject it */
async function ownerLocale(businessId: string) {
  const business = await getBusiness(businessId).catch(() => null);
  return business?.owner_email
    ? await resolveOwnerUiLocaleForEmail(business.owner_email).catch(() => "en" as const)
    : ("en" as const);
}
/* c8 ignore stop */

export type TelegramInboundDeps = {
  send?: typeof telegramSendMessage;
  findIdentity?: typeof findChannelIdentity;
  redeem?: typeof redeemLinkCode;
  upsertIdentity?: typeof upsertChannelIdentity;
  resolveSpeaker?: typeof resolveSurfaceSpeaker;
  getConversation?: typeof getOrCreateCoworkerConversation;
  insertMessage?: typeof insertCoworkerUserMessage;
  listMessages?: typeof listCoworkerMessages;
  markHello?: typeof markCoworkerHelloSent;
  updateIdentity?: typeof updateCoworkerConversationIdentity;
  locale?: (businessId: string) => Promise<"en" | "es">;
};

export async function handleTelegramMessage(
  input: { connection: CoworkerConnectionRow; update: TelegramUpdate },
  deps: TelegramInboundDeps = {}
): Promise<TelegramInboundResult> {
  /* c8 ignore start -- production defaults; tests inject */
  const send = deps.send ?? telegramSendMessage;
  const findIdentity = deps.findIdentity ?? findChannelIdentity;
  const redeem = deps.redeem ?? redeemLinkCode;
  const upsertIdentity = deps.upsertIdentity ?? upsertChannelIdentity;
  const resolveSpeaker = deps.resolveSpeaker ?? resolveSurfaceSpeaker;
  const getConversation = deps.getConversation ?? getOrCreateCoworkerConversation;
  const insertMessage = deps.insertMessage ?? insertCoworkerUserMessage;
  const listMessages = deps.listMessages ?? listCoworkerMessages;
  const markHello = deps.markHello ?? markCoworkerHelloSent;
  const updateIdentity = deps.updateIdentity ?? updateCoworkerConversationIdentity;
  const locale = deps.locale ?? ownerLocale;
  /* c8 ignore stop */

  const { connection, update } = input;
  const message = update.message;
  if (!message) return { enqueued: false, reason: "unsupported_update" };

  const from = message.from;
  const chat = message.chat;
  if (!from || !chat) return { enqueued: false, reason: "no_sender" };
  // Our own echoes and other bots. Answering a bot is how two integrations
  // talk to each other forever.
  if (from.is_bot) return { enqueued: false, reason: "bot_sender" };

  const businessId = connection.business_id;
  const externalUserId = String(from.id);
  const chatId = String(chat.id);
  const displayName =
    [from.first_name, from.last_name].filter(Boolean).join(" ").trim() ||
    (from.username ? `@${from.username}` : null);

  // ---- Enrolment: a shared contact card ----
  if (message.contact) {
    const l = await locale(businessId);
    // It must be THEIR card. Telegram sets contact.user_id only when the
    // card belongs to the sharer; a forwarded colleague's card has a
    // different id (or none), and trusting it would hand over that
    // colleague's powers to whoever forwarded it.
    if (message.contact.user_id !== from.id) {
      await send(connection.credential, {
        chatId,
        text: telegramContactNotYoursMessage(l)
      }).catch(() => undefined);
      return { enqueued: false, reason: "contact_not_own" };
    }
    const phone = telegramContactToE164(message.contact.phone_number);
    if (!phone) return { enqueued: false, reason: "contact_unusable" };

    // The number is verified, but it still has to belong to somebody we
    // know. resolveSurfaceSpeaker answers that against the owner numbers
    // and the ACTIVE roster, and fails closed.
    const speaker = await resolveSpeaker(businessId, { phoneE164: phone });
    if (speaker.kind === "customer") {
      await send(connection.credential, {
        chatId,
        text: telegramNeedsLinkingMessage(l)
      }).catch(() => undefined);
      return { enqueued: false, reason: "contact_not_staff" };
    }
    await upsertIdentity({
      businessId,
      channel: "telegram",
      externalUserId,
      // The roster row is resolved at read time from the phone, so the
      // binding records what was PROVEN (the number) rather than a
      // snapshot of the roster that would go stale on the next edit.
      employeeId: null,
      isOwner: speaker.kind === "owner",
      verifiedPhoneE164: phone,
      linkedVia: "shared_contact"
    });
    await send(connection.credential, {
      chatId,
      text: telegramLinkAcceptedMessage(l)
    }).catch(() => undefined);
    return { enqueued: false, reason: "linked_by_contact" };
  }

  const text = (message.text ?? "").trim();
  if (!text) return { enqueued: false, reason: "no_text" };

  const existing = await findIdentity(businessId, "telegram", externalUserId);

  // ---- Enrolment: a link code ----
  // Only offered to accounts we do not already know. A connected teammate
  // typing eight characters is asking their coworker something, not
  // enrolling again.
  if (!existing && looksLikeLinkCode(text)) {
    const l = await locale(businessId);
    const outcome = await redeem({ channel: "telegram", code: text, externalUserId });
    await send(connection.credential, {
      chatId,
      text: outcome.ok ? telegramLinkAcceptedMessage(l) : telegramLinkRejectedMessage(l)
    }).catch(() => undefined);
    return { enqueued: false, reason: outcome.ok ? "linked_by_code" : `link_${outcome.reason}` };
  }

  // ---- Unknown account: say how to get connected, and nothing else ----
  if (!existing) {
    const l = await locale(businessId);
    await send(connection.credential, {
      chatId,
      text: telegramNeedsLinkingMessage(l),
      // The button is the easy path; the code is the fallback for anyone
      // who would rather not share a number.
      requestContact: { buttonText: telegramShareContactButton(l) }
    }).catch(() => undefined);
    return { enqueued: false, reason: "not_linked" };
  }

  // ---- A known account: queue the turn ----
  const conversation = await getConversation({
    businessId,
    channel: "telegram",
    externalWorkspaceId: connection.external_workspace_id,
    externalConversationId: chatId,
    // Telegram DMs have no thread anchor; the chat IS the thread.
    threadKey: null,
    externalUserId
  });

  // First contact in a brand-new conversation gets one hello, claimed
  // through the unique index so two rapid messages cannot double-greet.
  const priorMessages = await listMessages(conversation.id, 1);
  if (priorMessages.length === 0) {
    const l = await locale(businessId);
    const hello = telegramOnboardingMessage(l);
    if (await markHello({ conversationId: conversation.id, businessId, channel: "telegram", content: hello })) {
      await send(connection.credential, { chatId, text: hello }).catch(() => undefined);
    }
  }

  const stored = await insertMessage({
    conversationId: conversation.id,
    businessId,
    channel: "telegram",
    content: text,
    // Telegram redelivers an update it did not get a 200 for, and the
    // update_id is stable across those retries. This is the dedupe.
    externalEventId: update.update_id === undefined ? null : `u:${update.update_id}`,
    externalTs: String(message.message_id)
  });
  if (stored === null) {
    logger.info("telegram inbound: duplicate delivery", { businessId, externalUserId });
    return { enqueued: false, reason: "duplicate_delivery" };
  }

  if (displayName && displayName !== conversation.user_display_name) {
    // Best effort: a stale display name costs a label, never a decision.
    await updateIdentity(conversation.id, {
      displayName,
      email: conversation.user_email,
      isOwner: existing.is_owner
    }).catch(() => undefined);
  }

  return { enqueued: true };
}
