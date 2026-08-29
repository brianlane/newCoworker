/**
 * Google Chat's entry in the shared coworker queue.
 *
 * The claim loop belongs to `coworker-channels/worker.ts` and the turn to
 * `owner-surfaces/run-turn.ts`. What is left here is what is actually
 * Google Chat: replying into the right thread, and voicing each verdict.
 *
 * No streaming and no typing indicator: Chat has neither for apps.
 */

import { getBusiness } from "@/lib/db/businesses";
import {
  completeCoworkerJob,
  failCoworkerJob,
  getCoworkerConversationById,
  listCoworkerMessages
} from "@/lib/db/coworker-chat";
import { getActiveCoworkerConnection } from "@/lib/db/coworker-connections";
import { coworkerChannelAllowedForBusiness } from "@/lib/coworker-channels/tier-gate";
import type { CoworkerChannelAdapter } from "@/lib/coworker-channels/types";
import { runOwnerSurfaceTurn } from "@/lib/owner-surfaces/run-turn";
import { resolveSurfaceSpeaker } from "@/lib/owner-surfaces/speaker";
import { fulfillOwnerEmailBlocks } from "@/lib/dashboard-chat/email-blocks";
import { scheduleCaptureOwnerRuleInline } from "@/lib/dashboard-chat/schedule-memory-capture";
import { resolveOwnerUiLocaleForEmail } from "@/lib/i18n/owner-locale";
import { googleChatSendMessage } from "@/lib/google-chat/client";
import {
  GOOGLE_CHAT_REPLY_MAX_CHARS,
  googleChatOverCapMessage,
  googleChatTierBlockedMessage,
  googleChatTurnFailedMessage
} from "@/lib/google-chat/chat";
import type { PlanTier } from "@/lib/plans/tier";
import { logger } from "@/lib/logger";

const GOOGLE_CHAT_HISTORY_MESSAGES = 12;

async function runOneGoogleChatJob(
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

  const connection = await getActiveCoworkerConnection(businessId, "google_chat");
  if (!connection) {
    await failCoworkerJob({ jobId, errorCode: "no_connection", terminal: true });
    return false;
  }

  // Back into the thread the question was asked in. The conversation IS the
  // thread here, so a space-level reply would read as the app talking over
  // the top of whatever else is going on in the room.
  const target = {
    space: conversation.external_conversation_id,
    thread: conversation.thread_key
  };

  const business = await getBusiness(businessId).catch(() => null);
  const locale = business?.owner_email
    ? await resolveOwnerUiLocaleForEmail(business.owner_email).catch(() => "en" as const)
    : ("en" as const);
  const say = async (text: string) => {
    const sent = await googleChatSendMessage(target, { text }).catch(() => null);
    return sent?.messageName ?? null;
  };

  if (!(await coworkerChannelAllowedForBusiness(businessId).catch(() => true))) {
    const text = googleChatTierBlockedMessage(locale);
    const ts = await say(text);
    await completeCoworkerJob({ jobId, content: text, historyMaxMessageId: 0, externalTs: ts });
    return false;
  }

  const history = await listCoworkerMessages(conversationId, GOOGLE_CHAT_HISTORY_MESSAGES);
  const historyMaxMessageId = history.length > 0 ? history[history.length - 1].id : 0;
  const latestUserIndex = history.map((m) => m.role).lastIndexOf("user");
  if (latestUserIndex < 0) {
    await failCoworkerJob({ jobId, errorCode: "no_user_message", terminal: true });
    return false;
  }

  // Re-checked at turn time, exactly as Telegram and Teams do: a roster row
  // can be deactivated between a message arriving and its turn running, and
  // a former teammate must lose their powers at the second boundary too.
  const speaker = await resolveSurfaceSpeaker(businessId, {
    email: conversation.user_email,
    externalRef: { channel: "google_chat", externalUserId: conversation.external_user_id }
  });
  if (speaker.kind === "customer") {
    await failCoworkerJob({
      jobId,
      errorCode: speaker.readFailed ? "identity_unreadable" : "not_linked",
      terminal: !speaker.readFailed
    });
    return false;
  }

  const speakerRef = conversation.user_display_name ?? conversation.user_email ?? "a team member";
  const outcome = await runOwnerSurfaceTurn({
    businessId,
    surfaceKey: "google_chat",
    speaker,
    speakerRef,
    history: history.slice(0, latestUserIndex + 1).map((m) => ({
      role: m.role,
      content: m.content
    })),
    speakerLabel: speaker.kind === "owner" ? "Owner" : "Teammate",
    userLabel: `Google Chat from ${speaker.kind === "owner" ? "owner" : "team member"}${
      speaker.name ? ` ${speaker.name}` : ""
    }`,
    businessMeta: {
      timezone: business?.timezone ?? null,
      tier: (business?.tier ?? null) as PlanTier | null,
      ownerEmail: business?.owner_email?.trim() || null
    }
  });

  if (outcome.kind === "over_cap") {
    const text = googleChatOverCapMessage(locale);
    const ts = await say(text);
    await completeCoworkerJob({ jobId, content: text, historyMaxMessageId: 0, externalTs: ts });
    return true;
  }

  if (outcome.kind === "silent") {
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
      const text = googleChatTurnFailedMessage(locale);
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

  // Fulfil EMAIL_SEND against the UNCLIPPED answer: clipping first can cut a
  // block into an unparseable fragment that reaches the speaker as raw JSON.
  const emailOutcome =
    speaker.kind === "owner"
      ? await fulfillOwnerEmailBlocks({
          businessId,
          content: outcome.unclipped,
          source: "google_chat_assistant"
        })
      : { content: outcome.unclipped };
  const finalContent = emailOutcome.content.slice(0, GOOGLE_CHAT_REPLY_MAX_CHARS);

  const postedTs = await say(finalContent);
  if (postedTs === null) {
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
  logger.info("google chat: replied", {
    businessId,
    conversationId,
    isOwner: speaker.kind === "owner"
  });
  return true;
}

export const googleChatChannelAdapter: CoworkerChannelAdapter = {
  channel: "google_chat",
  runJob: (job) =>
    runOneGoogleChatJob(job.id, job.business_id, job.conversation_id, job.attempts)
};
