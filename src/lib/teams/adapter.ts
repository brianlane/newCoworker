/**
 * Teams' entry in the shared coworker queue.
 *
 * The claim loop belongs to `coworker-channels/worker.ts` and the turn to
 * `owner-surfaces/run-turn.ts`. What is left here is what is actually Teams:
 * finding the conversation reference to reply into, and voicing each verdict.
 *
 * No streaming and no typing indicator. Teams has a typing activity, but it
 * expires in seconds and would need re-sending on a timer for the length of
 * a turn; Slack streams because Slack gave us a streaming API.
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
import { teamsSendActivity } from "@/lib/teams/client";
import {
  TEAMS_REPLY_MAX_CHARS,
  teamsOverCapMessage,
  teamsTierBlockedMessage,
  teamsTurnFailedMessage
} from "@/lib/teams/chat";
import type { PlanTier } from "@/lib/plans/tier";
import { logger } from "@/lib/logger";

const TEAMS_HISTORY_MESSAGES = 12;

async function runOneTeamsJob(
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

  const connection = await getActiveCoworkerConnection(businessId, "teams");
  if (!connection) {
    await failCoworkerJob({ jobId, errorCode: "no_connection", terminal: true });
    return false;
  }

  // The service URL was captured from the tenant's own activity when the
  // alert target was recorded. Without one there is nowhere to reply: Teams
  // has no "message this conversation id" call that does not need it.
  const serviceUrl = connection.alert_target_name;
  if (!serviceUrl) {
    await failCoworkerJob({ jobId, errorCode: "no_service_url", terminal: true });
    return false;
  }
  const reference = {
    serviceUrl,
    conversationId: conversation.external_conversation_id
  };

  const business = await getBusiness(businessId).catch(() => null);
  const locale = business?.owner_email
    ? await resolveOwnerUiLocaleForEmail(business.owner_email).catch(() => "en" as const)
    : ("en" as const);
  const say = async (text: string) => {
    const sent = await teamsSendActivity(reference, { text }).catch(() => null);
    return sent?.activityId ?? null;
  };

  if (!(await coworkerChannelAllowedForBusiness(businessId).catch(() => true))) {
    const text = teamsTierBlockedMessage(locale);
    const ts = await say(text);
    await completeCoworkerJob({ jobId, content: text, historyMaxMessageId: 0, externalTs: ts });
    return false;
  }

  const history = await listCoworkerMessages(conversationId, TEAMS_HISTORY_MESSAGES);
  const historyMaxMessageId = history.length > 0 ? history[history.length - 1].id : 0;
  const latestUserIndex = history.map((m) => m.role).lastIndexOf("user");
  if (latestUserIndex < 0) {
    await failCoworkerJob({ jobId, errorCode: "no_user_message", terminal: true });
    return false;
  }

  // Re-checked at turn time, exactly as Telegram does: a roster row can be
  // deactivated between a message arriving and its turn running, and a
  // former teammate must lose their powers at the second boundary too.
  const speaker = await resolveSurfaceSpeaker(businessId, {
    email: conversation.user_email,
    externalRef: { channel: "teams", externalUserId: conversation.external_user_id }
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
    surfaceKey: "teams",
    speaker,
    speakerRef,
    history: history.slice(0, latestUserIndex + 1).map((m) => ({
      role: m.role,
      content: m.content
    })),
    speakerLabel: speaker.kind === "owner" ? "Owner" : "Teammate",
    userLabel: `Teams from ${speaker.kind === "owner" ? "owner" : "team member"}${
      speaker.name ? ` ${speaker.name}` : ""
    }`,
    businessMeta: {
      timezone: business?.timezone ?? null,
      tier: (business?.tier ?? null) as PlanTier | null,
      ownerEmail: business?.owner_email?.trim() || null
    }
  });

  if (outcome.kind === "over_cap") {
    const text = teamsOverCapMessage(locale);
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
      const text = teamsTurnFailedMessage(locale);
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
          source: "teams_assistant"
        })
      : { content: outcome.unclipped };
  const finalContent = emailOutcome.content.slice(0, TEAMS_REPLY_MAX_CHARS);

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
  logger.info("teams: replied", { businessId, conversationId, isOwner: speaker.kind === "owner" });
  return true;
}

export const teamsChannelAdapter: CoworkerChannelAdapter = {
  channel: "teams",
  runJob: (job) => runOneTeamsJob(job.id, job.business_id, job.conversation_id, job.attempts)
};
