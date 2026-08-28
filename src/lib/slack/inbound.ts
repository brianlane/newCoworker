/**
 * Slack inbound chat events → durable rows, inside the webhook's 3-second
 * ack window. Everything here is cheap: resolve the workspace, drop what
 * is not a human message for us, store message + reply job, and tell the
 * route whether a worker kick is warranted. The turn itself runs in
 * src/lib/slack/worker.ts.
 *
 * Deliberately NOT gated on tier here: the webhook must ack Slack fast
 * (the Meta-webhook rule), and the worker owns the tier chokepoint.
 */
import { getSlackConnectionByTeamId } from "@/lib/db/slack-connections";
import {
  getOrCreateCoworkerConversation,
  insertCoworkerUserMessage,
  listCoworkerMessages,
  markCoworkerHelloSent
} from "@/lib/db/coworker-chat";
import { slackPostMessage, slackUsersInfo } from "@/lib/slack/client";
import { slackOnboardingMessage } from "@/lib/slack/chat";
import {
  answerApprovalFromText,
  findAwaitingApprovalRunBySlackThread,
  slackApprovalAck
} from "@/lib/slack/approvals";
import { getBusiness } from "@/lib/db/businesses";
import { resolveOwnerUiLocaleForEmail } from "@/lib/i18n/owner-locale";
import type { SlackInboundEvent } from "@/lib/slack/webhook";
import { logger } from "@/lib/logger";

/** Slack messages can be long; the engine reads a bounded window anyway. */
const SLACK_INBOUND_MAX_CHARS = 8000;

type ChatEventFields = {
  user?: unknown;
  text?: unknown;
  channel?: unknown;
  ts?: unknown;
  thread_ts?: unknown;
  bot_id?: unknown;
  subtype?: unknown;
  channel_type?: unknown;
  tab?: unknown;
};

export type SlackInboundOutcome = {
  /** True when a reply job was stored and the worker should be kicked. */
  enqueued: boolean;
  reason?: string;
};

/**
 * message.im (DMs) and app_mention (channels). Returns whether a job was
 * enqueued; every drop names its reason for the route's debug log.
 */
export async function handleSlackChatEvent(input: {
  teamId: string;
  eventId: string | null;
  event: SlackInboundEvent;
}): Promise<SlackInboundOutcome> {
  const e = input.event as SlackInboundEvent & ChatEventFields;
  const isMention = e.type === "app_mention";

  // Not a fresh human message: bot echoes (including our own posts), edits,
  // deletes, joins, and other subtyped noise.
  if (e.bot_id !== undefined) return { enqueued: false, reason: "bot_message" };
  if (typeof e.subtype === "string" && e.subtype.length > 0) {
    return { enqueued: false, reason: `subtype_${e.subtype}` };
  }
  const user = typeof e.user === "string" ? e.user : null;
  const text = typeof e.text === "string" ? e.text.trim() : "";
  const channel = typeof e.channel === "string" ? e.channel : null;
  const ts = typeof e.ts === "string" ? e.ts : null;
  if (!user || !channel || !ts || text.length === 0) {
    return { enqueued: false, reason: "missing_fields" };
  }

  const connection = await getSlackConnectionByTeamId(input.teamId);
  if (!connection || !connection.is_active || connection.botToken.length === 0) {
    return { enqueued: false, reason: "no_active_connection" };
  }
  // Self-echo belt and braces (message.im also delivers our own DM posts on
  // some manifests; bot_id already catches the normal case).
  if (user === connection.bot_user_id) return { enqueued: false, reason: "self" };

  // Strip the leading @-mention so the engine sees the ask, not the tag.
  const content = (
    isMention ? text.replace(new RegExp(`^<@${connection.bot_user_id}>\\s*`), "") : text
  ).slice(0, SLACK_INBOUND_MAX_CHARS);
  if (content.length === 0) return { enqueued: false, reason: "empty_after_mention" };

  const threadTs = isMention
    ? typeof e.thread_ts === "string" && e.thread_ts.length > 0
      ? e.thread_ts
      : ts
    : null;

  // A mention inside an approval-prompt thread is an ANSWER to that gate,
  // not a chat message: digits map against the stored options (the SMS
  // numbering) and anything else is the free-text modify. Owner-only, the
  // same trust bar as every other decision surface.
  if (isMention && threadTs) {
    const approvalRun = await findAwaitingApprovalRunBySlackThread(
      connection.business_id,
      channel,
      threadTs
    );
    if (approvalRun) {
      const [identity, business] = await Promise.all([
        slackUsersInfo(connection.botToken, user).catch(() => null),
        getBusiness(connection.business_id).catch(() => null)
      ]);
      const ownerEmail = (business?.owner_email ?? "").trim().toLowerCase();
      const isOwner =
        ownerEmail.length > 0 &&
        (identity?.email ?? "").trim().toLowerCase() === ownerEmail;
      const ack = isOwner
        ? slackApprovalAck(
            await answerApprovalFromText({
              businessId: connection.business_id,
              runId: approvalRun.runId,
              text: content,
              decidedBy: `slack:${user}`
            })
          )
        : "Only the business owner can decide this approval.";
      await slackPostMessage(connection.botToken, {
        channel,
        thread_ts: threadTs,
        text: ack
      }).catch(() => undefined);
      return { enqueued: false, reason: isOwner ? "approval_reply" : "approval_not_owner" };
    }
  }

  const conversation = await getOrCreateCoworkerConversation({
    businessId: connection.business_id,
    channel: "slack",
    externalWorkspaceId: input.teamId,
    externalConversationId: channel,
    threadKey: threadTs,
    externalUserId: user
  });

  const stored = await insertCoworkerUserMessage({
    conversationId: conversation.id,
    businessId: connection.business_id,
    channel: "slack",
    content,
    externalEventId: input.eventId,
    externalTs: ts
  });
  if (stored === null) {
    // Slack's 0/1/5-min redelivery of an event we already own: ack quietly.
    return { enqueued: false, reason: "duplicate_delivery" };
  }
  return { enqueued: true };
}

/**
 * app_home_opened with tab=="messages": the agent-surface "user opened a DM
 * with the coworker" signal. Post the onboarding line EXACTLY ONCE: only
 * when the conversation has no messages at all (a user who already chatted
 * must never get a welcome mid-thread), with a durable marker row claimed
 * before posting so racing opens collapse onto the unique index. Everything
 * about it is best-effort; a failed hello must never 500 a webhook.
 */
export async function handleSlackHomeOpened(input: {
  teamId: string;
  event: SlackInboundEvent;
}): Promise<void> {
  const e = input.event as SlackInboundEvent & ChatEventFields;
  if (e.tab !== "messages") return;
  const user = typeof e.user === "string" ? e.user : null;
  const channel = typeof e.channel === "string" ? e.channel : null;
  if (!user || !channel) return;

  try {
    const connection = await getSlackConnectionByTeamId(input.teamId);
    if (!connection || !connection.is_active || connection.botToken.length === 0) return;

    const conversation = await getOrCreateCoworkerConversation({
      businessId: connection.business_id,
      channel: "slack",
      externalWorkspaceId: input.teamId,
      externalConversationId: channel,
      threadKey: null,
      externalUserId: user
    });
    // Any existing message (theirs, ours, or an earlier hello marker) means
    // this is not a first meeting; no repeat welcomes, and never a welcome
    // injected into a thread that already started.
    const existing = await listCoworkerMessages(conversation.id, 1);
    if (existing.length > 0) return;

    const business = await getBusiness(connection.business_id).catch(() => null);
    const locale = business?.owner_email
      ? await resolveOwnerUiLocaleForEmail(business.owner_email).catch(() => "en" as const)
      : ("en" as const);
    const hello = slackOnboardingMessage(locale);
    // Claim the marker BEFORE posting: two rapid opens race here, exactly
    // one wins the unique index, and only the winner speaks.
    const claimed = await markCoworkerHelloSent({
      conversationId: conversation.id,
      businessId: connection.business_id,
      channel: "slack",
      content: hello
    });
    if (!claimed) return;
    await slackPostMessage(connection.botToken, { channel, text: hello });
  } catch (err) {
    logger.warn("slack inbound: home-opened hello failed", {
      teamId: input.teamId,
      error: err instanceof Error ? err.message : String(err)
    });
  }
}
