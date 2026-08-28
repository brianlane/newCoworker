/**
 * Slack reply worker: claims slack_jobs, runs the inline engine, and posts
 * the answer back into the workspace, streaming when Slack allows it.
 *
 * The shape mirrors src/lib/messenger/worker.ts (claim loop, terminal
 * tier_blocked, bounded batch); the TURN mirrors the owner-SMS operator
 * route (same engine, prompt blocks, Settings gates, EMAIL_SEND
 * fulfilment) with one addition: an identity branch. The workspace's
 * verified owner (users.info email matching businesses.owner_email) gets
 * the full dashboard persona and owner-power tools; everyone else in the
 * workspace gets the team persona with those tools hard-off.
 *
 * Streaming: chat.startStream when the workspace supports it, the final
 * step's text appended once (the engine's onTextDelta fires only for
 * never-superseded text), chat.stopStream with the fulfilled content.
 * EMAIL_SEND blocks never stream: the append is withheld the moment a
 * potential block marker appears, and the fulfilled text lands at stop.
 * Any refusal degrades to a single chat.postMessage.
 */
import { getActiveSlackConnection } from "@/lib/db/slack-connections";
import {
  completeCoworkerJob,
  failCoworkerJob,
  getCoworkerConversationById,
  listCoworkerMessages,
  updateCoworkerConversationIdentity,
  type CoworkerJobRow
} from "@/lib/db/coworker-chat";
import {
  slackPostMessage,
  slackSetAssistantStatus,
  slackStartStream,
  slackStopStream,
  slackAppendStream,
  slackUsersInfo,
  type SlackStreamHandle
} from "@/lib/slack/client";
import {
  SLACK_REPLY_MAX_CHARS,
  slackOverCapMessage,
  slackTierBlockedMessage,
  slackTurnFailedMessage
} from "@/lib/slack/chat";
import { slackAllowedForBusiness } from "@/lib/slack/tier-gate";
import { getBusiness } from "@/lib/db/businesses";
import type { PlanTier } from "@/lib/plans/tier";
import { runOwnerSurfaceTurn } from "@/lib/owner-surfaces/run-turn";
import { scheduleCaptureOwnerRuleInline } from "@/lib/dashboard-chat/schedule-memory-capture";
import { fulfillOwnerEmailBlocks } from "@/lib/dashboard-chat/email-blocks";
import { resolveOwnerUiLocaleForEmail } from "@/lib/i18n/owner-locale";
import type { CoworkerChannelAdapter } from "@/lib/coworker-channels/types";
import { logger } from "@/lib/logger";

/** Recent thread messages replayed for continuity (owner-SMS convention). */
const SLACK_HISTORY_MESSAGES = 12;

/** Claim ceiling per sweep pass; the inline kick handles the common case. */
const MAX_JOBS_PER_RUN = 8;

/** A potential EMAIL_SEND block start; streamed text is withheld from it. */
const STREAM_WITHHOLD_MARKER = "<<";

/**
 * Slack's entry in the shared queue.
 *
 * The claim loop, the bounded batch, the stale reclaim and the crash
 * handling all moved to `coworker-channels/worker.ts`, which drains one
 * queue for every channel. What is left here is what is actually Slack:
 * streaming, the thread status indicator, the approval gate, and the
 * workspace-profile identity branch.
 */
export const slackChannelAdapter: CoworkerChannelAdapter = {
  channel: "slack",
  runJob: (job) => runOneSlackJob(job.id, job.business_id, job.conversation_id, job.attempts)
};

async function runOneSlackJob(
  jobId: string,
  businessId: string,
  conversationId: string,
  attempts: number
): Promise<boolean> {
  const lastAttempt = attempts >= 3;
  const conversation = await getCoworkerConversationById(conversationId);
  if (!conversation) {
    await failCoworkerJob({ jobId, errorCode: "conversation_missing", terminal: true });
    return false;
  }

  const connection = await getActiveSlackConnection(businessId);
  if (!connection) {
    // Uninstalled mid-queue: nothing to post with, nothing to retry into.
    await failCoworkerJob({ jobId, errorCode: "no_connection", terminal: true });
    return false;
  }
  const botToken = connection.botToken;
  const replyTarget = {
    channel: conversation.external_conversation_id,
    thread_ts: conversation.thread_key ?? undefined
  };

  const business = await getBusiness(businessId).catch(() => null);
  const locale = business?.owner_email
    ? await resolveOwnerUiLocaleForEmail(business.owner_email).catch(() => "en" as const)
    : ("en" as const);

  const history = await listCoworkerMessages(conversationId, SLACK_HISTORY_MESSAGES);
  const historyMaxMessageId = history.length > 0 ? history[history.length - 1].id : 0;
  const latestUser = [...history].reverse().find((m) => m.role === "user");
  if (!latestUser) {
    await failCoworkerJob({ jobId, errorCode: "no_user_message", terminal: true });
    return false;
  }

  // Slack auto-clears the "is thinking" status only when the app posts INTO
  // the status thread. DM replies post to the channel top level (there is no
  // conversation thread), so the auto-clear never fires there and the
  // indicator spins forever after the reply lands. Clear it explicitly at
  // every terminal outcome; retryable failures keep it, honestly, since the
  // sweep will run the turn again.
  const statusThreadTs = conversation.thread_key ?? latestUser.external_ts ?? "";
  const clearAssistantStatus = async () => {
    await slackSetAssistantStatus(botToken, {
      channel_id: conversation.external_conversation_id,
      thread_ts: statusThreadTs,
      status: ""
    }).catch(() => false);
  };

  // Tier chokepoint (messenger worker precedent): terminal so the reclaim
  // never loops a starter tenant, but with an honest line in the thread,
  // since Slack silence reads as "broken", not "gated".
  if (!(await slackAllowedForBusiness(businessId).catch(() => true))) {
    await slackPostMessage(botToken, {
      ...replyTarget,
      text: slackTierBlockedMessage(locale)
    }).catch(() => undefined);
    await clearAssistantStatus();
    await failCoworkerJob({ jobId, errorCode: "tier_blocked", terminal: true });
    return false;
  }

  // Identity: resolve once per conversation, cached on the row. A lookup
  // failure degrades to TEAM powers for this turn and retries next message.
  let isOwner = conversation.is_owner;
  let displayName = conversation.user_display_name;
  // Re-resolve while no VERIFIED EMAIL is cached (null or empty): a member
  // whose workspace profile gains an email later, or an owner whose first
  // lookup raced a Slack hiccup, must be able to graduate to owner powers on
  // a later message instead of being frozen by the first answer.
  if (!conversation.user_email) {
    const identity = await slackUsersInfo(botToken, conversation.external_user_id).catch(() => null);
    if (identity) {
      if (identity.isBot) {
        // Belt and braces: the webhook already drops bot messages.
        await clearAssistantStatus();
        await failCoworkerJob({ jobId, errorCode: "bot_user", terminal: true });
        return false;
      }
      const ownerEmail = (business?.owner_email ?? "").trim().toLowerCase();
      isOwner =
        ownerEmail.length > 0 &&
        (identity.email ?? "").trim().toLowerCase() === ownerEmail;
      displayName = identity.displayName;
      await updateCoworkerConversationIdentity(conversationId, {
        displayName: identity.displayName,
        // null (not "") when Slack exposed no email, so the next message
        // retries the lookup rather than trusting an empty cache forever.
        email: identity.email ?? null,
        isOwner
      }).catch(() => undefined);
    } else {
      isOwner = false;
    }
  }

  // The turn itself is the shared runner now: staff mode, the context
  // reads, the spend fuse, the prompt assembly, the tool gates and the
  // failure taxonomy. What stays here is the part that is actually Slack,
  // namely the streaming handle, the thread status indicator, and how each
  // verdict gets voiced in the workspace.
  const speaker = displayName ?? "Teammate";
  // Answer the NEWEST user message and replay only what came before it.
  // Slicing at that index rather than handing over the whole window keeps
  // the previous behaviour exactly: a trailing assistant row must not make
  // us re-answer an older question.
  const answeredIndex = history.indexOf(latestUser);

  // Streaming and the "is thinking" indicator are opened from onTurnStart
  // below, NOT here. Both are visible in the workspace, and the verdicts
  // that come back without a reply (staff mode off, over the cap, nothing
  // to answer) are all supposed to leave no trace: opening either one up
  // front would have a switched-off surface announce itself with a spinner
  // and an empty streamed message.
  // Held on an object rather than in a plain `let`: it is assigned inside
  // the onTurnStart callback, and the compiler cannot see across that, so a
  // bare local narrows to `null` for the rest of the function.
  const streaming: { handle: SlackStreamHandle | null } = { handle: null };
  let streamedChars = 0;
  const stopStream = async () => {
    if (streaming.handle) {
      await slackStopStream(botToken, streaming.handle, undefined).catch(() => false);
    }
  };

  const outcome = await runOwnerSurfaceTurn({
    businessId,
    surfaceKey: "slack",
    // Identity comes from the Slack profile email, matched against the
    // business owner email upstream in this function.
    speaker: {
      kind: isOwner ? "owner" : "teammate",
      name: displayName || null,
      readFailed: false
    },
    speakerRef: speaker,
    history: history.slice(0, answeredIndex + 1).map((m) => ({
      role: m.role,
      content: m.content
    })),
    speakerLabel: speaker,
    userLabel: `Slack from ${isOwner ? "owner" : "team member"} ${speaker}`,
    // Kept verbatim rather than the runner's generic
    // `slack-owner-operator` default: Slack is the one surface with a real
    // per-user id, and this string is what the MCP bridge files against
    // every tool call made from the workspace.
    bridgeUserId: `slack:${conversation.external_user_id}`,
    // Already read above for the owner's UI locale, so hand it over rather
    // than making the context load fetch the same row again.
    businessMeta: {
      timezone: business?.timezone ?? null,
      tier: (business?.tier ?? null) as PlanTier | null,
      ownerEmail: business?.owner_email?.trim() || null
    },
    onTurnStart: async () => {
      // Best-effort: a refusal (free plan, non-agent context) degrades to a
      // single post at the end.
      await slackSetAssistantStatus(botToken, {
        channel_id: conversation.external_conversation_id,
        thread_ts: statusThreadTs,
        status: "is thinking..."
      });
      streaming.handle = await slackStartStream(botToken, replyTarget);
    },
    // The append is withheld the moment a potential EMAIL_SEND marker shows
    // up, so raw blocks never render mid-stream.
    onTextDelta: (text: string) => {
      const handle = streaming.handle;
      if (!handle) return;
      if (text.includes(STREAM_WITHHOLD_MARKER)) return;
      void slackAppendStream(botToken, handle, text.slice(0, SLACK_REPLY_MAX_CHARS)).then(
        (ok) => {
          if (ok) streamedChars += text.length;
        }
      );
    }
  });

  if (outcome.kind === "over_cap") {
    // An honest line instead of a silent model refusal: there is no Rowboat
    // fallback on this surface, so silence here reads as "broken".
    await stopStream();
    const text = slackOverCapMessage(locale);
    const posted = await slackPostMessage(botToken, { ...replyTarget, text });
    await clearAssistantStatus();
    await completeCoworkerJob({
      jobId,
      content: text,
      historyMaxMessageId: 0,
      externalTs: posted.ok ? posted.ts : null
    });
    return true;
  }

  if (outcome.kind === "silent") {
    // The owner switched this surface off in Settings > Coworker. Post
    // NOTHING: "answer them as a customer" is not a thing in a workspace,
    // and a line explaining the setting would only nag a teammate who
    // cannot change it. Terminal, because the answer cannot change until
    // the owner switches it back on, so it must not burn the retry ladder.
    await stopStream();
    await clearAssistantStatus();
    await failCoworkerJob({ jobId, errorCode: outcome.reason, terminal: true });
    return false;
  }

  if (outcome.kind === "failed") {
    await stopStream();
    if (outcome.terminal) {
      // Nothing to answer. Saying "something went wrong" would be a reply
      // to a message that was never really a question.
      await clearAssistantStatus();
      await failCoworkerJob({
        jobId,
        errorCode: outcome.code,
        errorDetail: outcome.detail,
        terminal: true
      });
      return false;
    }
    if (lastAttempt) {
      const text = slackTurnFailedMessage(locale);
      const posted = await slackPostMessage(botToken, { ...replyTarget, text });
      await clearAssistantStatus();
      await completeCoworkerJob({
        jobId,
        content: text,
        historyMaxMessageId,
        externalTs: posted.ok ? posted.ts : null
      });
      return false;
    }
    await failCoworkerJob({
      jobId,
      errorCode: outcome.code,
      errorDetail: outcome.detail,
      terminal: false
    });
    return false;
  }

  // Fulfil EMAIL_SEND blocks BEFORE any clip or final send: raw JSON must
  // never reach the workspace (owner branch only; team turns carry none).
  // The runner hands back `unclipped` for exactly this: clipping first
  // could cut an EMAIL_SEND block into an unparseable fragment that then
  // renders as raw JSON in the workspace.
  const emailOutcome = isOwner
    ? await fulfillOwnerEmailBlocks({
        businessId,
        content: outcome.unclipped,
        source: "slack_assistant",
        // The SAME toggle the preamble above was built from, so the
        // authoritative check can never contradict what the model was told.
        agentKey: "slack"
      })
    : { content: outcome.unclipped };
  const finalContent = emailOutcome.content.slice(0, SLACK_REPLY_MAX_CHARS);

  let postedTs: string | null = null;
  if (streaming.handle) {
    const stopped = await slackStopStream(botToken, streaming.handle, finalContent);
    if (stopped) postedTs = streaming.handle.ts;
  }
  if (postedTs === null) {
    const posted = await slackPostMessage(botToken, { ...replyTarget, text: finalContent });
    if (!posted.ok) {
      // Retryable: keep the status spinning, the sweep will run this again.
      await failCoworkerJob({
        jobId,
        errorCode: "post_failed",
        errorDetail: posted.error,
        terminal: false
      });
      return false;
    }
    postedTs = posted.ts;
  }
  // The reply is visible; kill the indicator (a no-op wherever Slack already
  // auto-cleared it, e.g. threaded mention replies).
  await clearAssistantStatus();

  if (isOwner) {
    // Same silent durable-rule capture as dashboard turns.
    scheduleCaptureOwnerRuleInline({
      businessId,
      ownerMessage: latestUser.content,
      assistantReply: finalContent
    });
  }

  await completeCoworkerJob({
    jobId,
    content: finalContent,
    historyMaxMessageId,
    externalTs: postedTs
  });
  logger.info("slack-worker: replied", {
    businessId,
    conversationId,
    isOwner,
    streamed: streamedChars > 0
  });
  return true;
}
