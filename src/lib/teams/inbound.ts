/**
 * Everything Teams does inside its webhook's ack window: work out who is
 * writing, keep the conversation reference fresh, and queue a reply job.
 *
 * IDENTITY IS EASIER HERE THAN ON TELEGRAM, and that is the whole reason
 * Teams needs no binding table of its own. An activity carries an Entra
 * object id, and the Bot Connector's members endpoint turns that into a UPN
 * or email address, which resolves through the SAME `resolveSurfaceSpeaker`
 * that Slack uses. A directory that exposes no address falls back to the
 * shared link-code path, which Telegram already built.
 *
 * THE ADDRESS IS NOT ON THE ACTIVITY, which is the trap here. `from` is a
 * ChannelAccount (id, display name, object id) and `entities` carries
 * clientInfo and mentions. Reading an address off either yields undefined
 * forever, and the visible symptom is not an error: every colleague is
 * quietly treated as a stranger and told to go and find a link code.
 *
 * THE TENANT BOUNDARY IS `channelData.tenant.id`. Our Azure bot registration
 * is multi-tenant, so any Entra tenant that finds the app can install it and
 * message it. An activity whose tenant is not bound to a business belongs to
 * nobody and is dropped, which is the same rule as an unbound Slack team_id.
 *
 * THE CONVERSATION REFERENCE IS CAPTURED ON EVERY MESSAGE. Teams has no
 * "message this user" call: a proactive alert can only continue a
 * conversation the bot has already seen, so the reference is stored and
 * refreshed as it changes (Microsoft varies serviceUrl by region and
 * reserves the right to move it).
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
  upsertChannelIdentity,
  normalizeLinkCode
} from "@/lib/db/coworker-identities";
import {
  setCoworkerAlertTarget,
  type CoworkerConnectionRow
} from "@/lib/db/coworker-connections";
import { resolveSurfaceSpeaker } from "@/lib/owner-surfaces/speaker";
import { resolveOwnerUiLocaleForEmail } from "@/lib/i18n/owner-locale";
import {
  teamsFetchMember,
  teamsSendActivity,
  type TeamsConversationReference
} from "@/lib/teams/client";
import { teamsNeedsLinkingMessage, teamsOnboardingMessage } from "@/lib/teams/chat";
import { logger } from "@/lib/logger";

/** The slice of a Bot Framework activity this channel reads. */
export type TeamsActivity = {
  type?: string;
  id?: string;
  text?: string;
  serviceUrl?: string;
  conversation?: { id?: string };
  from?: { id?: string; name?: string; aadObjectId?: string };
  recipient?: { id?: string };
  channelData?: { tenant?: { id?: string } };
};

export type TeamsInboundResult = { enqueued: boolean; reason?: string };

/** Recent messages replayed for continuity (owner-SMS convention). */
const TEAMS_HISTORY_PROBE = 1;

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

export type TeamsInboundDeps = {
  send?: typeof teamsSendActivity;
  findIdentity?: typeof findChannelIdentity;
  fetchMember?: typeof teamsFetchMember;
  upsertIdentity?: typeof upsertChannelIdentity;
  redeem?: typeof redeemLinkCode;
  resolveSpeaker?: typeof resolveSurfaceSpeaker;
  getConversation?: typeof getOrCreateCoworkerConversation;
  insertMessage?: typeof insertCoworkerUserMessage;
  listMessages?: typeof listCoworkerMessages;
  markHello?: typeof markCoworkerHelloSent;
  updateIdentity?: typeof updateCoworkerConversationIdentity;
  setAlertTarget?: typeof setCoworkerAlertTarget;
  locale?: (businessId: string) => Promise<"en" | "es">;
};

export async function handleTeamsActivity(
  input: { connection: CoworkerConnectionRow; activity: TeamsActivity },
  deps: TeamsInboundDeps = {}
): Promise<TeamsInboundResult> {
  /* c8 ignore start -- production defaults; tests inject */
  const send = deps.send ?? teamsSendActivity;
  const findIdentity = deps.findIdentity ?? findChannelIdentity;
  const fetchMember = deps.fetchMember ?? teamsFetchMember;
  const upsertIdentity = deps.upsertIdentity ?? upsertChannelIdentity;
  const redeem = deps.redeem ?? redeemLinkCode;
  const resolveSpeaker = deps.resolveSpeaker ?? resolveSurfaceSpeaker;
  const getConversation = deps.getConversation ?? getOrCreateCoworkerConversation;
  const insertMessage = deps.insertMessage ?? insertCoworkerUserMessage;
  const listMessages = deps.listMessages ?? listCoworkerMessages;
  const markHello = deps.markHello ?? markCoworkerHelloSent;
  const updateIdentity = deps.updateIdentity ?? updateCoworkerConversationIdentity;
  const setAlertTarget = deps.setAlertTarget ?? setCoworkerAlertTarget;
  const locale = deps.locale ?? ownerLocale;
  /* c8 ignore stop */

  const { connection, activity } = input;
  // Teams sends conversationUpdate, typing, and more. Only a message is a
  // question; the rest are acked and ignored.
  if (activity.type !== "message") return { enqueued: false, reason: "unsupported_activity" };

  const conversationId = activity.conversation?.id?.trim();
  const fromId = activity.from?.id?.trim();
  const serviceUrl = activity.serviceUrl?.trim();
  if (!conversationId || !fromId || !serviceUrl) {
    return { enqueued: false, reason: "incomplete_activity" };
  }

  const businessId = connection.business_id;
  // The Entra object id is stable across renames and address changes, which
  // a display name and even a UPN are not. It is the binding key.
  const externalUserId = activity.from?.aadObjectId?.trim() || fromId;
  const displayName = activity.from?.name?.trim() || null;

  // Strip the bot's own @mention out of a channel message. Left in, the
  // model answers the mention as though it were part of the question.
  //
  // The character class is NOT `.` on purpose. `<at>.*?</at>` backtracks
  // polynomially on a message that is many repetitions of `<at>` with no
  // closing tag, which is attacker-controlled text arriving on a public
  // endpoint. `[^<]*` cannot cross a `<`, so there is nothing to backtrack.
  const text = (activity.text ?? "").replace(/<at>[^<]*<\/at>/gi, "").trim();
  if (!text) return { enqueued: false, reason: "no_text" };

  const reference: TeamsConversationReference = { serviceUrl, conversationId };

  // Who is speaking.
  //
  // A recorded binding answers it without a round trip, which is the common
  // case after somebody's first message. Only a stranger costs a directory
  // lookup, and only once: a lookup that resolves them to staff is written
  // back as a binding below.
  const binding = await findIdentity(businessId, "teams", externalUserId);
  const address =
    binding?.verified_email ?? (await fetchMember(reference, fromId))?.email ?? null;
  const speaker = await resolveSpeaker(businessId, {
    email: address,
    externalRef: { channel: "teams", externalUserId }
  });

  if (speaker.kind === "customer") {
    // Not somebody we can place. A code is the way in, so honour one before
    // giving up, but only from an account that is not already bound.
    if (!binding && looksLikeLinkCode(text)) {
      const outcome = await redeem({ channel: "teams", code: text, externalUserId });
      await send(reference, {
        text: outcome.ok
          ? teamsOnboardingMessage(await locale(businessId))
          : teamsNeedsLinkingMessage(await locale(businessId))
      }).catch(() => undefined);
      return { enqueued: false, reason: outcome.ok ? "linked_by_code" : `link_${outcome.reason}` };
    }
    await send(reference, { text: teamsNeedsLinkingMessage(await locale(businessId)) }).catch(
      () => undefined
    );
    return { enqueued: false, reason: "not_linked" };
  }

  // Remember what the directory said, so the next message from this person
  // skips the lookup. Recorded against the Entra object id, which survives a
  // rename or an address change.
  if (!binding && address) {
    await upsertIdentity({
      businessId,
      channel: "teams",
      externalUserId,
      // Resolved fresh from the roster on every turn by the address, the
      // same reasoning as Telegram's shared-contact path: a snapshot of the
      // roster here would go stale on the next edit.
      employeeId: null,
      isOwner: speaker.kind === "owner",
      verifiedEmail: address,
      linkedVia: "directory"
    }).catch(() => undefined);
  }

  const conversation = await getConversation({
    businessId,
    channel: "teams",
    externalWorkspaceId: connection.external_workspace_id,
    externalConversationId: conversationId,
    // A Teams conversation IS the thread from our point of view; replies go
    // back into it rather than onto a separate anchor.
    threadKey: null,
    externalUserId
  });

  // Capture where to send a PROACTIVE message. Teams has no "message this
  // user" call, so without a stored reference an alert has nowhere to go.
  // The FIRST conversation the bot sees becomes the alert target, which is
  // what makes "message your bot once" the whole of setup.
  //
  // The SERVICE URL is refreshed whenever it changes, and that half is not
  // optional. Microsoft varies it by region and relocates tenants; both
  // replies and alerts POST to the stored value, so a pinned one keeps
  // failing after a move until somebody disconnects and starts over. The
  // conversation id is only claimed once, so a later thread does not quietly
  // move where alerts land.
  const claimTarget = !connection.alert_target_id;
  const urlMoved =
    Boolean(connection.alert_target_id) && connection.alert_target_name !== serviceUrl;
  if (claimTarget || urlMoved) {
    await setAlertTarget(businessId, "teams", {
      id: connection.alert_target_id ?? conversationId,
      name: serviceUrl
    }).catch(() => undefined);
  }

  const priorMessages = await listMessages(conversation.id, TEAMS_HISTORY_PROBE);
  if (priorMessages.length === 0) {
    const hello = teamsOnboardingMessage(await locale(businessId));
    if (
      await markHello({ conversationId: conversation.id, businessId, channel: "teams", content: hello })
    ) {
      await send(reference, { text: hello }).catch(() => undefined);
    }
  }

  const stored = await insertMessage({
    conversationId: conversation.id,
    businessId,
    channel: "teams",
    content: text,
    // The activity id is stable across Bot Framework's own redelivery, which
    // is what makes it the dedupe key.
    externalEventId: activity.id ? `a:${activity.id}` : null,
    externalTs: activity.id ?? null
  });
  if (stored === null) {
    logger.info("teams inbound: duplicate delivery", { businessId, externalUserId });
    return { enqueued: false, reason: "duplicate_delivery" };
  }

  const nameChanged = Boolean(displayName) && displayName !== conversation.user_display_name;
  const emailChanged = (address ?? null) !== (conversation.user_email ?? null);
  if (nameChanged || emailChanged) {
    // The EMAIL half feeds channel liveness, which reads
    // coworker_conversations to decide whether a human is still here and
    // places a Teams row in the audience by address.
    await updateIdentity(conversation.id, {
      displayName: displayName ?? conversation.user_display_name,
      email: address ?? conversation.user_email,
      isOwner: speaker.kind === "owner"
    }).catch(() => undefined);
  }

  return { enqueued: true };
}
