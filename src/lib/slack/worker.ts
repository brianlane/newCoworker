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
  claimSlackJob,
  completeSlackJob,
  failSlackJob,
  getSlackConversationById,
  listSlackMessages,
  reclaimStaleSlackJobs,
  updateSlackConversationIdentity,
  type SlackConversationRow
} from "@/lib/db/slack-chat";
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
  SLACK_SURFACE_BLOCK,
  SLACK_TEAM_PREAMBLE,
  slackOverCapMessage,
  slackTierBlockedMessage,
  slackTurnFailedMessage
} from "@/lib/slack/chat";
import { slackAllowedForBusiness } from "@/lib/slack/tier-gate";
import { getBusiness } from "@/lib/db/businesses";
import { getAgentToolStates } from "@/lib/db/agent-tool-settings";
import { getPublicWhatsAppConnection } from "@/lib/db/whatsapp-connections";
import { getChatSpendSnapshotForBusiness } from "@/lib/db/chat-usage";
import type { PlanTier } from "@/lib/plans/tier";
import { runInlineChatTurn } from "@/lib/dashboard-chat/inline-turn";
import {
  buildBusinessContextBlock,
  buildIntegrationsStatusLine
} from "@/lib/dashboard-chat/context-blocks";
import { scheduleCaptureOwnerRuleInline } from "@/lib/dashboard-chat/schedule-memory-capture";
import {
  buildMcpBridgeExtraTools,
  mcpBridgeToolsPreamble
} from "@/lib/dashboard-chat/mcp-bridge";
import {
  EMAIL_TOOL_DISABLED_PREAMBLE,
  EMAIL_TOOL_ENABLED_PREAMBLE,
  OWNER_PREAMBLE
} from "@/app/api/dashboard/chat/route";
import { fulfillOwnerEmailBlocks } from "@/lib/dashboard-chat/email-blocks";
import { bookingLinkPromptLine } from "@/lib/booking-page/prompt-line";
import { resolveOwnerUiLocaleForEmail } from "@/lib/i18n/owner-locale";
import { logger } from "@/lib/logger";
import { currentDateTimeLine } from "../../../supabase/functions/_shared/datetime_line";

/** Recent thread messages replayed for continuity (owner-SMS convention). */
const SLACK_HISTORY_MESSAGES = 12;

/** Same engine budget as the owner-SMS turn: streaming makes waiting visible. */
const SLACK_TURN_BUDGET_MS = 60_000;

/** Claim ceiling per sweep pass; the inline kick handles the common case. */
const MAX_JOBS_PER_RUN = 8;

/** A potential EMAIL_SEND block start; streamed text is withheld from it. */
const STREAM_WITHHOLD_MARKER = "<<";

export type SlackWorkerResult = {
  reclaimed: number;
  processed: number;
  failed: number;
};

export async function processSlackJobs(): Promise<SlackWorkerResult> {
  const workerId = `slack-worker-${Math.random().toString(36).slice(2, 10)}`;
  let reclaimed = 0;
  try {
    reclaimed = await reclaimStaleSlackJobs();
  } catch (err) {
    logger.warn("slack-worker: stale reclaim failed", {
      error: err instanceof Error ? err.message : String(err)
    });
  }

  let processed = 0;
  let failed = 0;
  for (let i = 0; i < MAX_JOBS_PER_RUN; i += 1) {
    let job;
    try {
      job = await claimSlackJob(workerId);
    } catch (err) {
      logger.error("slack-worker: claim failed", {
        error: err instanceof Error ? err.message : String(err)
      });
      break;
    }
    if (!job) break;
    try {
      const ok = await runOneSlackJob(job.id, job.business_id, job.conversation_id, job.attempts);
      if (ok) processed += 1;
      else failed += 1;
    } catch (err) {
      failed += 1;
      logger.error("slack-worker: job crashed", {
        jobId: job.id,
        error: err instanceof Error ? err.message : String(err)
      });
      await failSlackJob({
        jobId: job.id,
        errorCode: "worker_crash",
        errorDetail: err instanceof Error ? err.message : String(err),
        terminal: false
      }).catch(() => undefined);
    }
  }
  return { reclaimed, processed, failed };
}

async function runOneSlackJob(
  jobId: string,
  businessId: string,
  conversationId: string,
  attempts: number
): Promise<boolean> {
  const lastAttempt = attempts >= 3;
  const conversation = await getSlackConversationById(conversationId);
  if (!conversation) {
    await failSlackJob({ jobId, errorCode: "conversation_missing", terminal: true });
    return false;
  }

  const connection = await getActiveSlackConnection(businessId);
  if (!connection) {
    // Uninstalled mid-queue: nothing to post with, nothing to retry into.
    await failSlackJob({ jobId, errorCode: "no_connection", terminal: true });
    return false;
  }
  const botToken = connection.botToken;
  const replyTarget = {
    channel: conversation.channel_id,
    thread_ts: conversation.thread_ts ?? undefined
  };

  const business = await getBusiness(businessId).catch(() => null);
  const tier = (business?.tier ?? null) as PlanTier | null;
  const locale = business?.owner_email
    ? await resolveOwnerUiLocaleForEmail(business.owner_email).catch(() => "en" as const)
    : ("en" as const);

  const history = await listSlackMessages(conversationId, SLACK_HISTORY_MESSAGES);
  const historyMaxMessageId = history.length > 0 ? history[history.length - 1].id : 0;
  const latestUser = [...history].reverse().find((m) => m.role === "user");
  if (!latestUser) {
    await failSlackJob({ jobId, errorCode: "no_user_message", terminal: true });
    return false;
  }

  // Slack auto-clears the "is thinking" status only when the app posts INTO
  // the status thread. DM replies post to the channel top level (there is no
  // conversation thread), so the auto-clear never fires there and the
  // indicator spins forever after the reply lands. Clear it explicitly at
  // every terminal outcome; retryable failures keep it, honestly, since the
  // sweep will run the turn again.
  const statusThreadTs = conversation.thread_ts ?? latestUser.slack_ts ?? "";
  const clearAssistantStatus = async () => {
    await slackSetAssistantStatus(botToken, {
      channel_id: conversation.channel_id,
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
    await failSlackJob({ jobId, errorCode: "tier_blocked", terminal: true });
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
    const identity = await slackUsersInfo(botToken, conversation.slack_user_id).catch(() => null);
    if (identity) {
      if (identity.isBot) {
        // Belt and braces: the webhook already drops bot messages.
        await clearAssistantStatus();
        await failSlackJob({ jobId, errorCode: "bot_user", terminal: true });
        return false;
      }
      const ownerEmail = (business?.owner_email ?? "").trim().toLowerCase();
      isOwner =
        ownerEmail.length > 0 &&
        (identity.email ?? "").trim().toLowerCase() === ownerEmail;
      displayName = identity.displayName;
      await updateSlackConversationIdentity(conversationId, {
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

  // Over the shared AI cap: an honest line instead of a silent model refusal
  // (there is no Rowboat fallback on this surface). Fails open on a read blip.
  const spend = await getChatSpendSnapshotForBusiness(businessId, undefined, tier).catch(
    () => null
  );
  if (spend !== null && spend.spendMicros >= spend.effectiveCapMicros) {
    const text = slackOverCapMessage(locale);
    const posted = await slackPostMessage(botToken, { ...replyTarget, text });
    await clearAssistantStatus();
    await completeSlackJob({
      jobId,
      content: text,
      historyMaxMessageId: 0,
      slackTs: posted.ok ? posted.ts : null
    });
    return true;
  }

  const speaker = displayName ?? "Teammate";
  const transcript = history
    .slice(0, -1)
    .map((m) => `[${m.role === "user" ? speaker : "Coworker"}]: ${m.content.slice(0, 500)}`)
    .join("\n");

  // Same per-turn gates as the owner-SMS operator, keyed to THIS surface's
  // agent settings so Settings → Coworker → Slack coworker is authoritative.
  // Batched: one settings query instead of fifteen round-trips per message.
  const [toolStates, integrationsLine, businessContextBlock, bookingLinkLine] =
    await Promise.all([
      getAgentToolStates(businessId, "slack", [
        "business_knowledge_lookup",
        "send_sms",
        "send_whatsapp",
        "calendar_find_slots",
        "calendar_book_appointment",
        "calendar_reschedule_appointment",
        "calendar_cancel_appointment",
        "calendar_join_waitlist",
        "run_aiflow",
        "edit_aiflow",
        "update_notification_preferences",
        "flag_contact_spam",
        "set_contact_reply_mode",
        "manage_employee",
        "send_email",
        "read_business_data",
        "manage_contacts",
        "manage_flows",
        "manage_agents",
        "update_business_profile",
        "update_business_knowledge",
        "manage_coworker_tools",
        "custom_table_read",
        "custom_table_write",
        "custom_table_manage"
      ] as const),
      buildIntegrationsStatusLine(businessId),
      buildBusinessContextBlock(businessId),
      bookingLinkPromptLine(businessId)
    ]);
  const {
    business_knowledge_lookup: knowledgeToolEnabled,
    send_sms: smsToolEnabled,
    send_whatsapp: whatsappToolEnabled,
    calendar_find_slots: calFindEnabled,
    calendar_book_appointment: calBookEnabled,
    calendar_reschedule_appointment: calRescheduleEnabled,
    calendar_cancel_appointment: calCancelEnabled,
    calendar_join_waitlist: calWaitlistEnabled,
    run_aiflow: runAiflowEnabled,
    edit_aiflow: editAiflowEnabled,
    update_notification_preferences: notificationPrefsToolEnabled,
    flag_contact_spam: flagSpamToolEnabled,
    set_contact_reply_mode: replyModeToolEnabled,
    manage_employee: manageEmployeeToolEnabled,
    custom_table_read: customTableReadEnabled,
    custom_table_write: customTableWriteEnabled,
    custom_table_manage: customTableManageEnabled,
    send_email: emailToolEnabled
  } = toolStates;

  // MCP-bridge tools: OWNER-VERIFIED turns only, the same double gate as
  // the other owner-power tools on this surface. A teammate never sees the
  // declarations, and even a smuggled call would refuse inside the handler
  // (requireMcpBusinessRole re-checks the caller email per call).
  const verifiedOwnerEmail = (business?.owner_email ?? "").trim();
  const bridgeExtraTools =
    isOwner && verifiedOwnerEmail
      ? buildMcpBridgeExtraTools(
          businessId,
          { userId: `slack:${conversation.slack_user_id}`, email: verifiedOwnerEmail },
          {
            read_business_data: toolStates.read_business_data,
            manage_contacts: toolStates.manage_contacts,
            manage_flows: toolStates.manage_flows,
            manage_agents: toolStates.manage_agents,
            update_business_profile: toolStates.update_business_profile,
            update_business_knowledge: toolStates.update_business_knowledge,
            manage_coworker_tools: toolStates.manage_coworker_tools
          },
          "owner"
        )
      : null;

  const speakerLine = isOwner
    ? `The speaker is the business OWNER${displayName ? `, ${displayName}` : ""}, verified from their Slack profile email.`
    : `The speaker is team member ${speaker} in the business's Slack workspace.`;

  const systemInstruction = [
    ...(isOwner ? [OWNER_PREAMBLE] : [SLACK_TEAM_PREAMBLE]),
    SLACK_SURFACE_BLOCK,
    speakerLine,
    // The EMAIL_SEND protocol is owner-only on this surface: the enabled
    // preamble (or its equally load-bearing disabled twin) only for the
    // verified owner; the team preamble already names email as owner-only.
    ...(isOwner ? [emailToolEnabled ? EMAIL_TOOL_ENABLED_PREAMBLE : EMAIL_TOOL_DISABLED_PREAMBLE] : []),
    currentDateTimeLine(new Date(), business?.timezone ?? null),
    ...(integrationsLine ? [integrationsLine] : []),
    ...(bookingLinkLine ? [bookingLinkLine] : []),
    ...(businessContextBlock ? [businessContextBlock] : []),
    // includeCreationTools is false on this surface, so the ladder must
    // not advertise create_aiflow (Bugbot Medium on PR #1382).
    ...(bridgeExtraTools ? [mcpBridgeToolsPreamble({ creationToolsDeclared: false })] : []),
    ...(transcript
      ? [
          `Recent Slack exchange (oldest first, ground truth for what was already said):\n${transcript}`
        ]
      : [])
  ].join("\n\n");

  // Streaming: start best-effort; refusals (free plan, non-agent context)
  // degrade to a single post. The append is withheld the moment a potential
  // EMAIL_SEND marker shows up, so raw blocks never render mid-stream.
  await slackSetAssistantStatus(botToken, {
    channel_id: conversation.channel_id,
    thread_ts: statusThreadTs,
    status: "is thinking..."
  });
  const stream: SlackStreamHandle | null = await slackStartStream(botToken, replyTarget);
  let streamedChars = 0;

  const inline = await runInlineChatTurn({
    businessId,
    systemInstruction,
    userMessage: `[Slack from ${isOwner ? "owner" : "team member"} ${speaker}] ${latestUser.content}`,
    knowledgeToolEnabled,
    includeCreationTools: false,
    extraTools: bridgeExtraTools,
    // Bridged read chains need headroom; the turn budget still bounds the
    // wall clock regardless of the step count.
    maxToolSteps: 6,
    budgetMs: SLACK_TURN_BUDGET_MS,
    spendSurface: "slack_chat",
    flowEditSource: "ai_edit_slack",
    flowEditActor: speaker,
    onTextDelta: (text) => {
      if (!stream) return;
      if (text.includes(STREAM_WITHHOLD_MARKER)) return;
      void slackAppendStream(botToken, stream, text.slice(0, SLACK_REPLY_MAX_CHARS)).then(
        (ok) => {
          if (ok) streamedChars += text.length;
        }
      );
    },
    actionToolGates: {
      send_sms: smsToolEnabled,
      // Connection-aware, like dashboard chat: never declare a tool that
      // can only fail.
      send_whatsapp:
        whatsappToolEnabled &&
        (await getPublicWhatsAppConnection(businessId).catch(() => null))?.is_active === true,
      calendar_find_slots: calFindEnabled,
      calendar_book_appointment: calBookEnabled,
      calendar_reschedule_appointment: calRescheduleEnabled,
      calendar_cancel_appointment: calCancelEnabled,
      calendar_join_waitlist: calWaitlistEnabled,
      list_aiflows: runAiflowEnabled,
      run_aiflow: runAiflowEnabled,
      // Owner-power tools: per-surface toggle AND the verified owner. A
      // team member in the workspace can read and act, never reconfigure.
      edit_aiflow: isOwner && editAiflowEnabled,
      undo_aiflow_edit: isOwner && editAiflowEnabled,
      generate_image: false,
      update_notification_preferences: isOwner && notificationPrefsToolEnabled,
      flag_contact_spam: isOwner && flagSpamToolEnabled,
      set_contact_reply_mode: isOwner && replyModeToolEnabled,
      manage_employee: isOwner && manageEmployeeToolEnabled,
      // Same line this surface already draws in words: a team member in the
      // workspace can read and act, never reconfigure. So reading and
      // filling in a table is open to the workspace, while BUILDING or
      // deleting one is the owner's alone.
      custom_table_list: customTableReadEnabled,
      custom_table_find_rows: customTableReadEnabled,
      custom_table_history: customTableReadEnabled,
      custom_table_add_row: customTableWriteEnabled,
      custom_table_update_row: customTableWriteEnabled,
      custom_table_delete_row: customTableWriteEnabled,
      custom_table_undo: customTableWriteEnabled,
      custom_table_create: isOwner && customTableManageEnabled,
      custom_table_update_schema: isOwner && customTableManageEnabled,
      custom_table_delete: isOwner && customTableManageEnabled,
      custom_table_restore: isOwner && customTableManageEnabled
    }
  });

  if (!inline.ok) {
    if (stream) await slackStopStream(botToken, stream, undefined).catch(() => false);
    if (lastAttempt) {
      const text = slackTurnFailedMessage(locale);
      const posted = await slackPostMessage(botToken, { ...replyTarget, text });
      await clearAssistantStatus();
      await completeSlackJob({
        jobId,
        content: text,
        historyMaxMessageId,
        slackTs: posted.ok ? posted.ts : null
      });
      return false;
    }
    await failSlackJob({
      jobId,
      errorCode: inline.error ?? "model_failed",
      errorDetail: inline.detail,
      terminal: false
    });
    return false;
  }

  // Fulfil EMAIL_SEND blocks BEFORE any clip or final send: raw JSON must
  // never reach the workspace (owner branch only; team turns carry none).
  const emailOutcome = isOwner
    ? await fulfillOwnerEmailBlocks({
        businessId,
        content: inline.content,
        source: "slack_assistant",
        // The SAME toggle the preamble above was built from, so the
        // authoritative check can never contradict what the model was told.
        agentKey: "slack"
      })
    : { content: inline.content };
  const finalContent = emailOutcome.content.slice(0, SLACK_REPLY_MAX_CHARS);

  let postedTs: string | null = null;
  if (stream) {
    const stopped = await slackStopStream(botToken, stream, finalContent);
    if (stopped) postedTs = stream.ts;
  }
  if (postedTs === null) {
    const posted = await slackPostMessage(botToken, { ...replyTarget, text: finalContent });
    if (!posted.ok) {
      // Retryable: keep the status spinning, the sweep will run this again.
      await failSlackJob({
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

  await completeSlackJob({ jobId, content: finalContent, historyMaxMessageId, slackTs: postedTs });
  logger.info("slack-worker: replied", {
    businessId,
    conversationId,
    isOwner,
    streamed: streamedChars > 0
  });
  return true;
}
