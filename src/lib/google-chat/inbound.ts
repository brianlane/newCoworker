/**
 * Everything Google Chat does inside its webhook's ack window: work out
 * which business a space belongs to, who is writing, and queue the turn.
 *
 * A CODE BINDS THE SPACE, NOT JUST THE PERSON, and that is the one genuinely
 * new idea here. Slack learns its workspace from an OAuth install and Teams
 * has the owner paste an Entra tenant id, but a Google Chat app is simply
 * ADDED to a space by whoever is in it, and the event that arrives carries
 * no identifier the owner could have typed in beforehand: a space name is
 * opaque and is not shown anywhere in the Chat UI.
 *
 * So the connect code does double duty. The owner mints one in the
 * dashboard, adds the app to a space, and sends the code. Redeeming it says
 * which business, which binds the space, and says who they are, which binds
 * them. One step instead of two, and no value anybody has to copy out of a
 * URL bar.
 *
 * That makes the unbound-space path a real path rather than an error, which
 * is why this handler takes a nullable connection.
 *
 * REPLIES ARE SYNCHRONOUS WHERE THEY CAN BE. Google Chat posts whatever the
 * webhook returns, so every immediate answer here (the greeting, the two
 * refusals, the code outcomes) is returned as text rather than sent through
 * the API. That is not only fewer round trips inside the ack window: a
 * stranger in an unbound space gets an answer without our service-account
 * credential being involved at all.
 */

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
  upsertChannelIdentity,
  normalizeLinkCode
} from "@/lib/db/coworker-identities";
import {
  getCoworkerConnection,
  upsertCoworkerConnection,
  type CoworkerConnectionRow
} from "@/lib/db/coworker-connections";
import { getBusiness } from "@/lib/db/businesses";
import { resolveSurfaceSpeaker } from "@/lib/owner-surfaces/speaker";
import { resolveOwnerUiLocaleForEmail } from "@/lib/i18n/owner-locale";
import { isSpaceName } from "@/lib/google-chat/client";
import {
  googleChatAlreadyBoundMessage,
  googleChatBindFailedMessage,
  googleChatLinkRejectedMessage,
  googleChatNeedsLinkingMessage,
  googleChatOnboardingMessage,
  googleChatUnboundSpaceMessage
} from "@/lib/google-chat/chat";
import { logger } from "@/lib/logger";

/** The slice of a Google Chat event this channel reads. */
export type GoogleChatEvent = {
  type?: string;
  space?: { name?: string; type?: string; displayName?: string };
  message?: {
    name?: string;
    text?: string;
    /** The text with any @mention of the app removed, when Chat supplies it. */
    argumentText?: string;
    thread?: { name?: string };
    space?: { name?: string };
    sender?: { name?: string; displayName?: string; email?: string; type?: string };
  };
};

export type GoogleChatInboundResult = {
  enqueued: boolean;
  reason?: string;
  /** Posted by Chat as the webhook's own reply. */
  reply?: string;
};

/** Recent messages replayed for continuity (owner-SMS convention). */
const GOOGLE_CHAT_HISTORY_PROBE = 1;

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

export type GoogleChatInboundDeps = {
  findIdentity?: typeof findChannelIdentity;
  upsertIdentity?: typeof upsertChannelIdentity;
  redeem?: typeof redeemLinkCode;
  getConnection?: typeof getCoworkerConnection;
  upsertConnection?: typeof upsertCoworkerConnection;
  resolveSpeaker?: typeof resolveSurfaceSpeaker;
  getConversation?: typeof getOrCreateCoworkerConversation;
  insertMessage?: typeof insertCoworkerUserMessage;
  listMessages?: typeof listCoworkerMessages;
  markHello?: typeof markCoworkerHelloSent;
  updateIdentity?: typeof updateCoworkerConversationIdentity;
  locale?: (businessId: string) => Promise<"en" | "es">;
};

export async function handleGoogleChatEvent(
  input: { connection: CoworkerConnectionRow | null; event: GoogleChatEvent },
  deps: GoogleChatInboundDeps = {}
): Promise<GoogleChatInboundResult> {
  /* c8 ignore start -- production defaults; tests inject */
  const findIdentity = deps.findIdentity ?? findChannelIdentity;
  const upsertIdentity = deps.upsertIdentity ?? upsertChannelIdentity;
  const redeem = deps.redeem ?? redeemLinkCode;
  const getConnection = deps.getConnection ?? getCoworkerConnection;
  const upsertConnection = deps.upsertConnection ?? upsertCoworkerConnection;
  const resolveSpeaker = deps.resolveSpeaker ?? resolveSurfaceSpeaker;
  const getConversation = deps.getConversation ?? getOrCreateCoworkerConversation;
  const insertMessage = deps.insertMessage ?? insertCoworkerUserMessage;
  const listMessages = deps.listMessages ?? listCoworkerMessages;
  const markHello = deps.markHello ?? markCoworkerHelloSent;
  const updateIdentity = deps.updateIdentity ?? updateCoworkerConversationIdentity;
  const locale = deps.locale ?? ownerLocale;
  /* c8 ignore stop */

  const { connection, event } = input;
  const space = (event.space?.name ?? event.message?.space?.name ?? "").trim();
  // Checked rather than trusted even here: the space name is the tenant key
  // AND becomes a request path segment when we reply.
  if (!isSpaceName(space)) return { enqueued: false, reason: "no_space" };

  // Chat sends ADDED_TO_SPACE, REMOVED_FROM_SPACE, CARD_CLICKED and more.
  // Only a message is a question; being added is worth one greeting.
  if (event.type === "ADDED_TO_SPACE") {
    return {
      enqueued: false,
      reason: "added_to_space",
      reply: connection
        ? googleChatOnboardingMessage(await locale(connection.business_id))
        : googleChatUnboundSpaceMessage()
    };
  }
  if (event.type !== "MESSAGE") return { enqueued: false, reason: "unsupported_event" };

  const sender = event.message?.sender;
  const externalUserId = sender?.name?.trim() ?? "";
  // Chat is a place other apps live too. A bot answering a bot is a loop.
  if (sender?.type === "BOT") return { enqueued: false, reason: "bot_sender" };
  if (!externalUserId) return { enqueued: false, reason: "no_sender" };

  // `argumentText` is the message with the app's own @mention already
  // stripped, which is what Chat supplies in a space; a DM has only `text`.
  // Taking the mention out matters: left in, the model answers it as
  // though it were part of the question.
  const text = (event.message?.argumentText ?? event.message?.text ?? "").trim();
  if (!text) return { enqueued: false, reason: "no_text" };

  // ---- An unbound space: a code is the only thing that can happen here ----
  if (!connection) {
    if (!looksLikeLinkCode(text)) {
      return { enqueued: false, reason: "unbound_space", reply: googleChatUnboundSpaceMessage() };
    }
    const outcome = await redeem({ channel: "google_chat", code: text, externalUserId });
    if (!outcome.ok) {
      return {
        enqueued: false,
        reason: `link_${outcome.reason}`,
        reply: googleChatLinkRejectedMessage()
      };
    }

    // THE CODE IS SPENT FROM HERE ON, and everything below has to be
    // written knowing that. Which business a code belongs to is only
    // knowable by redeeming it, so there is no ordering that checks the
    // conditions below first, and a code is deliberately single use.
    //
    // What that costs must therefore be paid honestly rather than hidden:
    // every failure past this point says the code has been used up, and
    // none of them throws. A throw would become a 500, Google would
    // redeliver, and the retry would meet an already-redeemed code and tell
    // the owner their code was invalid, which is both untrue and a dead
    // end they cannot get out of without guessing.
    const businessId = outcome.identity.business_id;

    // A business gets ONE Chat space, and a second code must not silently
    // move it. Alerts go to the bound space, so relocating it from inside a
    // chat message would send them somewhere the owner never chose and
    // never sees, with nothing in the dashboard to say what happened.
    const already = await getConnection(businessId, "google_chat").catch(() => null);
    if (already && already.external_workspace_id !== space) {
      return {
        enqueued: false,
        reason: "already_bound_elsewhere",
        reply: googleChatAlreadyBoundMessage(await locale(businessId))
      };
    }

    try {
      await upsertConnection({
        businessId,
        channel: "google_chat",
        externalWorkspaceId: space,
        externalWorkspaceName: event.space?.displayName?.trim() || null,
        // No per-tenant secret exists for this channel: the app
        // authenticates with our own Google service account, exactly as
        // Teams uses our Azure app. The column is NOT NULL, so it holds an
        // empty string.
        credential: ""
      });
    } catch (err) {
      logger.error("google chat: space bind failed after the code was spent", {
        businessId,
        space,
        error: err instanceof Error ? err.message : String(err)
      });
      return {
        enqueued: false,
        reason: "bind_failed",
        reply: googleChatBindFailedMessage(await locale(businessId))
      };
    }
    logger.info("google chat: space bound by code", { businessId, space });
    return {
      enqueued: false,
      reason: "linked_by_code",
      reply: googleChatOnboardingMessage(await locale(businessId))
    };
  }

  const businessId = connection.business_id;
  const externalRef = { channel: "google_chat" as const, externalUserId };

  // Who is speaking.
  //
  // EASIER THAN TEAMS, where the address has to be fetched: a Chat event
  // carries `sender.email` for a human in the app's own Workspace. It is
  // not guaranteed (a Workspace can be configured so apps never see one,
  // and an external user has none), so a recorded binding answers first and
  // the code path remains the way in when neither does.
  const binding = await findIdentity(businessId, "google_chat", externalUserId);
  const eventAddress = (sender?.email ?? "").trim().toLowerCase() || null;
  const address = eventAddress ?? binding?.verified_email ?? null;
  const speaker = await resolveSpeaker(businessId, { email: address, externalRef });

  if (speaker.kind === "customer") {
    // Not somebody we can place. A code is the way in, and it is offered
    // whatever the binding says: somebody whose Workspace address changed
    // is exactly the person who needs one, and refusing them because a
    // stale binding exists would leave them no way back.
    if (looksLikeLinkCode(text)) {
      const outcome = await redeem({ channel: "google_chat", code: text, externalUserId });
      return {
        enqueued: false,
        reason: outcome.ok ? "linked_by_code" : `link_${outcome.reason}`,
        reply: outcome.ok
          ? googleChatOnboardingMessage(await locale(businessId))
          : googleChatLinkRejectedMessage(await locale(businessId))
      };
    }
    return {
      enqueued: false,
      reason: "not_linked",
      reply: googleChatNeedsLinkingMessage(await locale(businessId))
    };
  }

  // Record what the event said, so somebody whose Workspace stops exposing
  // an address keeps working. Rewritten whenever it moves.
  if (eventAddress && binding?.verified_email !== eventAddress) {
    await upsertIdentity({
      businessId,
      channel: "google_chat",
      externalUserId,
      // Resolved fresh from the roster on every turn by the address: a
      // snapshot of the roster here would go stale on the next edit.
      employeeId: null,
      isOwner: speaker.kind === "owner",
      verifiedEmail: eventAddress,
      linkedVia: "directory"
    }).catch(() => undefined);
  }

  const conversation = await getConversation({
    businessId,
    channel: "google_chat",
    externalWorkspaceId: connection.external_workspace_id,
    externalConversationId: space,
    // A Chat space holds many threads at once, so the THREAD is the
    // conversation and the space is only the place. Getting this wrong
    // would splice two unrelated discussions into one history.
    threadKey: event.message?.thread?.name?.trim() || null,
    externalUserId
  });

  const priorMessages = await listMessages(conversation.id, GOOGLE_CHAT_HISTORY_PROBE);
  let reply: string | undefined;
  if (priorMessages.length === 0) {
    const hello = googleChatOnboardingMessage(await locale(businessId));
    if (
      await markHello({
        conversationId: conversation.id,
        businessId,
        channel: "google_chat",
        content: hello
      })
    ) {
      reply = hello;
    }
  }

  const stored = await insertMessage({
    conversationId: conversation.id,
    businessId,
    channel: "google_chat",
    content: text,
    // The message name is stable across Chat's own redelivery, which is
    // what makes it the dedupe key.
    externalEventId: event.message?.name ? `m:${event.message.name}` : null,
    externalTs: event.message?.name ?? null
  });
  if (stored === null) {
    logger.info("google chat inbound: duplicate delivery", { businessId, externalUserId });
    return { enqueued: false, reason: "duplicate_delivery" };
  }

  const displayName = sender?.displayName?.trim() || null;
  const nameChanged = Boolean(displayName) && displayName !== conversation.user_display_name;
  const emailChanged = address !== (conversation.user_email ?? null);
  if (nameChanged || emailChanged) {
    // The EMAIL half feeds channel liveness, which reads
    // coworker_conversations to decide whether a human is still here and
    // places a Google Chat row in the audience by address.
    await updateIdentity(conversation.id, {
      displayName: displayName ?? conversation.user_display_name,
      email: address ?? conversation.user_email,
      isOwner: speaker.kind === "owner"
    }).catch(() => undefined);
  }

  return { enqueued: true, reply };
}
