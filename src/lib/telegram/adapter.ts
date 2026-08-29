/**
 * Telegram's entry in the shared coworker queue.
 *
 * The claim loop, the batch, the reclaim and the crash handling belong to
 * `coworker-channels/worker.ts`; the prompt, the gates, the spend fuse and
 * the failure taxonomy belong to `owner-surfaces/run-turn.ts`. What is left
 * here is what is actually Telegram: loading the bot token, saying each
 * verdict in a way a chat window can carry, and closing the job out.
 *
 * No streaming and no typing indicator, deliberately. Telegram has
 * sendChatAction, but it expires after five seconds and would have to be
 * re-sent on a timer for the length of a turn, which is a lot of moving
 * parts to tell somebody something they can already see. Slack streams
 * because Slack gave us a real streaming API.
 */

import { getBusiness } from "@/lib/db/businesses";
import {
  completeCoworkerJob,
  failCoworkerJob,
  getCoworkerConversationById,
  listCoworkerMessages
} from "@/lib/db/coworker-chat";
import { getActiveCoworkerConnection } from "@/lib/db/coworker-connections";
import { findChannelIdentity } from "@/lib/db/coworker-identities";
import { coworkerChannelAllowedForBusiness } from "@/lib/coworker-channels/tier-gate";
import type { CoworkerChannelAdapter } from "@/lib/coworker-channels/types";
import { runOwnerSurfaceTurn } from "@/lib/owner-surfaces/run-turn";
import { resolveSurfaceSpeaker, type SurfaceSpeaker } from "@/lib/owner-surfaces/speaker";
import { fulfillOwnerEmailBlocks } from "@/lib/dashboard-chat/email-blocks";
import { scheduleCaptureOwnerRuleInline } from "@/lib/dashboard-chat/schedule-memory-capture";
import { resolveOwnerUiLocaleForEmail } from "@/lib/i18n/owner-locale";
import { telegramSendMessage, escapeTelegramHtml } from "@/lib/telegram/client";
import {
  TELEGRAM_REPLY_MAX_CHARS,
  telegramOverCapMessage,
  telegramTierBlockedMessage,
  telegramTurnFailedMessage
} from "@/lib/telegram/chat";
import type { PlanTier } from "@/lib/plans/tier";
import { logger } from "@/lib/logger";

/** Recent messages replayed for continuity (owner-SMS convention). */
const TELEGRAM_HISTORY_MESSAGES = 12;

async function runOneTelegramJob(
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

  const connection = await getActiveCoworkerConnection(businessId, "telegram");
  if (!connection) {
    // Disconnected or paused mid-queue: nothing to post with, and nothing
    // a retry could fix.
    await failCoworkerJob({ jobId, errorCode: "no_connection", terminal: true });
    return false;
  }
  const token = connection.credential;
  const chatId = conversation.external_conversation_id;

  const business = await getBusiness(businessId).catch(() => null);
  const locale = business?.owner_email
    ? await resolveOwnerUiLocaleForEmail(business.owner_email).catch(() => "en" as const)
    : ("en" as const);
  const say = async (text: string) => {
    const posted = await telegramSendMessage(token, {
      chatId,
      text: escapeTelegramHtml(text)
    }).catch(() => null);
    return posted?.messageId ?? null;
  };

  // Tier chokepoint, terminal, but with an honest line: silence on a chat
  // surface reads as "broken", not as "gated".
  if (!(await coworkerChannelAllowedForBusiness(businessId).catch(() => true))) {
    const ts = await say(telegramTierBlockedMessage(locale));
    await completeCoworkerJob({
      jobId,
      content: telegramTierBlockedMessage(locale),
      historyMaxMessageId: 0,
      externalTs: ts
    });
    return false;
  }

  const history = await listCoworkerMessages(conversationId, TELEGRAM_HISTORY_MESSAGES);
  const historyMaxMessageId = history.length > 0 ? history[history.length - 1].id : 0;
  const latestUserIndex = history.map((m) => m.role).lastIndexOf("user");
  if (latestUserIndex < 0) {
    await failCoworkerJob({ jobId, errorCode: "no_user_message", terminal: true });
    return false;
  }

  /**
   * Who is speaking.
   *
   * BOTH identity forms go in, and that is load-bearing rather than
   * belt-and-braces. A teammate who enrolled by sharing their contact card
   * has a binding that records the VERIFIED PHONE and no employee id on
   * purpose, so that the roster is consulted fresh on every turn and a
   * roster edit takes effect immediately. Passing only the externalRef
   * would resolve that person to a stranger; passing only the phone would
   * miss anyone who enrolled with a code instead.
   */
  const binding = await findChannelIdentity(businessId, "telegram", conversation.external_user_id);
  const speaker: SurfaceSpeaker = await resolveSurfaceSpeaker(businessId, {
    phoneE164: binding?.verified_phone_e164 ?? null,
    externalRef: { channel: "telegram", externalUserId: conversation.external_user_id }
  });
  if (speaker.kind === "customer") {
    // The binding was removed, or the roster row was deactivated, between
    // the message arriving and this turn running. Say nothing: on this
    // surface an unidentified account is a stranger who found the bot.
    await failCoworkerJob({
      jobId,
      errorCode: speaker.readFailed ? "identity_unreadable" : "not_linked",
      // A failed READ can change on a retry; a removed binding cannot.
      terminal: !speaker.readFailed
    });
    return false;
  }

  const speakerRef = conversation.user_display_name ?? `id:${conversation.external_user_id}`;
  const outcome = await runOwnerSurfaceTurn({
    businessId,
    surfaceKey: "telegram",
    speaker,
    speakerRef,
    history: history.slice(0, latestUserIndex + 1).map((m) => ({
      role: m.role,
      content: m.content
    })),
    speakerLabel: speaker.kind === "owner" ? "Owner" : "Teammate",
    userLabel: `Telegram from ${speaker.kind === "owner" ? "owner" : "team member"}${
      speaker.name ? ` ${speaker.name}` : ""
    }`,
    businessMeta: {
      timezone: business?.timezone ?? null,
      tier: (business?.tier ?? null) as PlanTier | null,
      ownerEmail: business?.owner_email?.trim() || null
    }
  });

  if (outcome.kind === "over_cap") {
    const ts = await say(telegramOverCapMessage(locale));
    await completeCoworkerJob({
      jobId,
      content: telegramOverCapMessage(locale),
      historyMaxMessageId: 0,
      externalTs: ts
    });
    return true;
  }

  if (outcome.kind === "silent") {
    // The owner switched this surface off in Settings > Coworker. Post
    // nothing, and do not retry: the answer cannot change until they switch
    // it back on.
    await failCoworkerJob({ jobId, errorCode: outcome.reason, terminal: true });
    return false;
  }

  if (outcome.kind === "failed") {
    if (outcome.terminal) {
      await failCoworkerJob({
        jobId,
        errorCode: outcome.code,
        errorDetail: outcome.detail,
        terminal: true
      });
      return false;
    }
    if (lastAttempt) {
      const text = telegramTurnFailedMessage(locale);
      const ts = await say(text);
      await completeCoworkerJob({ jobId, content: text, historyMaxMessageId, externalTs: ts });
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

  // Fulfil EMAIL_SEND blocks BEFORE the clip, against the UNCLIPPED answer:
  // clipping first can cut a block into an unparseable fragment that then
  // reaches the speaker as raw JSON.
  const emailOutcome =
    speaker.kind === "owner"
      ? await fulfillOwnerEmailBlocks({
          businessId,
          content: outcome.unclipped,
          source: "telegram_assistant"
        })
      : { content: outcome.unclipped };
  const finalContent = emailOutcome.content.slice(0, TELEGRAM_REPLY_MAX_CHARS);

  const postedTs = await say(finalContent);
  if (postedTs === null) {
    // Retryable: the answer exists, Telegram just would not take it.
    await failCoworkerJob({ jobId, errorCode: "post_failed", terminal: false });
    return false;
  }

  if (speaker.kind === "owner") {
    scheduleCaptureOwnerRuleInline({
      businessId,
      ownerMessage: history[latestUserIndex].content,
      assistantReply: finalContent
    });
  }

  await completeCoworkerJob({
    jobId,
    content: finalContent,
    historyMaxMessageId,
    externalTs: postedTs
  });
  logger.info("telegram: replied", { businessId, conversationId, isOwner: speaker.kind === "owner" });
  return true;
}

export const telegramChannelAdapter: CoworkerChannelAdapter = {
  channel: "telegram",
  runJob: (job) => runOneTelegramJob(job.id, job.business_id, job.conversation_id, job.attempts)
};
