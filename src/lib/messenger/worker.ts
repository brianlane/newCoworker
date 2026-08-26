/**
 * Messenger reply worker, the processing loop behind
 * /api/internal/messenger-worker (kicked fire-and-forget by the Meta
 * webhook route, retried by the per-minute cron sweep).
 *
 * Per claimed job: load the conversation + transcript window, gate on
 * Meta's 24-hour standard messaging window, run the Gemini engine, send
 * via the Messenger Send API (page token), then commit atomically
 * (assistant message + job done + supersede covered queued siblings).
 *
 * Send-before-commit ordering: a failed send leaves the job claimed and
 * the reclaim sweep retries it; a failed commit AFTER a successful send
 * is logged loudly and left to the reclaim path, the complete RPC's
 * idempotent replay plus the superseded-sibling logic keep a retried
 * turn from double-writing the transcript.
 */

import {
  claimMessengerJob,
  completeMessengerJob,
  failMessengerJob,
  getMessengerConversationById,
  listMessengerMessages,
  messengerWindowOpen,
  reclaimStaleMessengerJobs,
  requeueMessengerJob,
  updateMessengerConversationContact,
  type MessengerConversationRow,
  type MessengerJobRow,
  type MessengerMessageRow
} from "@/lib/messenger/db";
import {
  runMessengerGeminiTurn,
  type MessengerGeminiTurnResult,
  type RunMessengerGeminiTurnArgs
} from "@/lib/messenger/engine";
import {
  runMessengerStaffTurn,
  type MessengerStaffTurnArgs,
  type MessengerStaffTurnOutcome
} from "@/lib/messenger/staff-turn";
import { getActiveMetaConnectionByPageId } from "@/lib/db/meta-connections";
import { getActiveWhatsAppConnectionByPhoneNumberId } from "@/lib/db/whatsapp-connections";
import {
  getMessengerProfile,
  sendMessengerMessage,
  sendWhatsAppMessage
} from "@/lib/meta/client";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import type { PlanTier } from "@/lib/plans/tier";
import { messengerAllowedForTier } from "@/lib/messenger/tier-gate";
import { logger } from "@/lib/logger";
import { isMetaTokenDead } from "@/lib/meta/client";
import { reportMetaCallFailure } from "@/lib/meta/token-health";

export const MESSENGER_WORKER_ID = "platform-messenger-worker";

/** Jobs per invocation, sized against the route's wall-clock budget. */
export const MESSENGER_WORKER_BATCH_LIMIT = 8;

/**
 * Platform-normalized send credentials for a conversation: the Page token
 * (messenger/instagram) or the Cloud API business token (whatsapp), both
 * keyed by the conversation's stored account key (page_id column).
 */
export type ResolvedSendAccount = { token: string };

/* c8 ignore start -- thin resolution over tested db modules; covered via injected deps */
async function resolveSendAccountDefault(
  platform: MessengerConversationRow["platform"],
  accountKey: string
): Promise<ResolvedSendAccount | null> {
  if (platform === "whatsapp") {
    const connection = await getActiveWhatsAppConnectionByPhoneNumberId(accountKey);
    return connection?.accessToken ? { token: connection.accessToken } : null;
  }
  const connection = await getActiveMetaConnectionByPageId(accountKey);
  return connection?.pageToken ? { token: connection.pageToken } : null;
}

async function sendDefault(
  platform: MessengerConversationRow["platform"],
  accountKey: string,
  token: string,
  recipientId: string,
  text: string
): Promise<{ messageId: string | null }> {
  if (platform === "whatsapp") {
    return sendWhatsAppMessage(accountKey, token, recipientId, text);
  }
  return sendMessengerMessage(accountKey, token, recipientId, text);
}
/* c8 ignore stop */

/* c8 ignore start -- thin service-client read; covered via injected deps */
async function fetchBusinessTier(businessId: string): Promise<PlanTier | null> {
  const db = await createSupabaseServiceClient();
  const { data } = await db
    .from("businesses")
    .select("tier")
    .eq("id", businessId)
    .maybeSingle();
  return ((data as { tier?: PlanTier | null } | null)?.tier ?? null) as PlanTier | null;
}
/* c8 ignore stop */

export type MessengerWorkerDeps = {
  reclaimStale?: typeof reclaimStaleMessengerJobs;
  claimJob?: (workerId: string) => Promise<MessengerJobRow | null>;
  getConversation?: (id: string) => Promise<MessengerConversationRow | null>;
  listMessages?: (conversationId: string) => Promise<MessengerMessageRow[]>;
  resolveSendAccount?: (
    platform: MessengerConversationRow["platform"],
    accountKey: string
  ) => Promise<ResolvedSendAccount | null>;
  fetchTier?: (businessId: string) => Promise<PlanTier | null>;
  fetchProfileName?: (
    pageToken: string,
    userId: string,
    platform: MessengerConversationRow["platform"]
  ) => Promise<{ name: string | null }>;
  updateContact?: typeof updateMessengerConversationContact;
  runTurn?: (args: RunMessengerGeminiTurnArgs) => Promise<MessengerGeminiTurnResult>;
  runStaffTurn?: (args: MessengerStaffTurnArgs) => Promise<MessengerStaffTurnOutcome>;
  send?: (
    platform: MessengerConversationRow["platform"],
    accountKey: string,
    token: string,
    recipientId: string,
    text: string
  ) => Promise<{ messageId: string | null }>;
  complete?: typeof completeMessengerJob;
  fail?: typeof failMessengerJob;
  requeue?: typeof requeueMessengerJob;
  now?: () => Date;
};

export type MessengerWorkerSummary = {
  requeued: number;
  claimed: number;
  replied: number;
  failed: number;
};

/** Drain up to `limit` queued reply jobs. Never throws per-job. */
export async function processMessengerJobs(
  opts: { limit?: number } = {},
  deps: MessengerWorkerDeps = {}
): Promise<MessengerWorkerSummary> {
  /* c8 ignore start -- production default deps; tests inject explicit deps */
  const reclaimStale = deps.reclaimStale ?? reclaimStaleMessengerJobs;
  const claimJob =
    deps.claimJob ?? ((workerId: string) => claimMessengerJob(workerId));
  const getConversation = deps.getConversation ?? getMessengerConversationById;
  const listMessages =
    deps.listMessages ?? ((id: string) => listMessengerMessages(id));
  const resolveSendAccount = deps.resolveSendAccount ?? resolveSendAccountDefault;
  const fetchTier = deps.fetchTier ?? fetchBusinessTier;
  const fetchProfileName = deps.fetchProfileName ?? getMessengerProfile;
  const updateContact = deps.updateContact ?? updateMessengerConversationContact;
  const runTurn = deps.runTurn ?? runMessengerGeminiTurn;
  const runStaffTurn = deps.runStaffTurn ?? runMessengerStaffTurn;
  const send = deps.send ?? sendDefault;
  const complete = deps.complete ?? completeMessengerJob;
  const fail = deps.fail ?? failMessengerJob;
  const requeue = deps.requeue ?? requeueMessengerJob;
  const now = deps.now ?? (() => new Date());
  /* c8 ignore stop */

  const limit = opts.limit ?? MESSENGER_WORKER_BATCH_LIMIT;
  const summary: MessengerWorkerSummary = {
    requeued: 0,
    claimed: 0,
    replied: 0,
    failed: 0
  };

  try {
    summary.requeued = await reclaimStale();
  } catch (err) {
    logger.warn("messenger worker: stale reclaim failed; continuing", {
      error: err instanceof Error ? err.message : String(err)
    });
  }

  for (let i = 0; i < limit; i++) {
    let job: MessengerJobRow | null = null;
    try {
      job = await claimJob(MESSENGER_WORKER_ID);
    } catch (err) {
      logger.error("messenger worker: claim failed; stopping batch", {
        error: err instanceof Error ? err.message : String(err)
      });
      break;
    }
    if (!job) break;
    summary.claimed += 1;

    const claimedAt = job.claimed_at ?? now().toISOString();
    const failJob = async (code: string, detail: string) => {
      summary.failed += 1;
      try {
        await fail(job.id, code, detail, claimedAt);
      } catch (err) {
        logger.error("messenger worker: error-flip failed", {
          jobId: job.id,
          code,
          error: err instanceof Error ? err.message : String(err)
        });
      }
    };

    // Hoisted out of the try so the catch below can tell a Meta failure from
    // a WhatsApp one: they use different credentials and only one of them
    // lives in meta_connections.
    let jobPlatform: MessengerConversationRow["platform"] | null = null;
    try {
      const conversation = await getConversation(job.conversation_id);
      if (!conversation) {
        await failJob("conversation_missing", job.conversation_id);
        continue;
      }
      jobPlatform = conversation.platform;

      // Meta policy: replies only inside the 24h standard messaging
      // window. Nudges beyond it ride SMS (once a phone is captured).
      if (!messengerWindowOpen(conversation, now())) {
        await failJob("window_expired", conversation.last_user_message_at);
        continue;
      }

      const account = await resolveSendAccount(conversation.platform, conversation.page_id);
      if (!account) {
        await failJob("not_connected", conversation.page_id);
        continue;
      }

      // Best-effort display name backfill on first touch, the preamble
      // and inbox both read better with a real name. WhatsApp skips this:
      // the sender's profile name arrived with the webhook delivery.
      let conversationForTurn = conversation;
      if (!conversation.display_name && conversation.platform !== "whatsapp") {
        const profile = await fetchProfileName(
          account.token,
          conversation.psid,
          conversation.platform
        );
        if (profile.name) {
          try {
            await updateContact(conversation.id, { name: profile.name });
            conversationForTurn = { ...conversation, display_name: profile.name };
          } catch (err) {
            logger.warn("messenger worker: display-name merge failed", {
              conversationId: conversation.id,
              error: err instanceof Error ? err.message : String(err)
            });
          }
        }
      }

      const history = await listMessages(conversation.id);
      const historyMaxMessageId = history.reduce(
        (max, m) => (m.id > max ? m.id : max),
        job.user_message_id
      );

      const tier = await fetchTier(job.business_id);
      // Standard+ only for automatic Gemini replies. Inbox ingest and owner
      // manual send stay on Starter; fail terminal so reclaim does not loop.
      if (!messengerAllowedForTier(tier)) {
        await failJob("tier_blocked", "messenger_ai_requires_standard");
        continue;
      }

      // Staff first. On WhatsApp the sender's number is verified by WhatsApp
      // itself, so the owner or a roster member reaching their own business
      // number gets the OWNER coworker, not the customer sales assistant
      // that used to pitch them and file them as a lead.
      //
      // Deliberately AFTER the tier gate, so this changes nothing about who
      // is billed for an AI reply.
      const staff = await runStaffTurn({
        businessId: job.business_id,
        conversation: conversationForTurn,
        history
      });
      if (staff.kind === "silent") {
        // The owner turned this surface off. Terminal and quiet: no reply,
        // no retry, and above all no fall-through to the customer engine,
        // which would pitch them.
        await failJob("staff_mode_off", staff.reason);
        continue;
      }
      if (staff.kind === "failed") {
        // Terminal outcomes ("nothing to answer", "over the spend cap")
        // cannot be changed by retrying, so they must not burn three
        // attempts and then dead-letter under a misleading turn_failed.
        // Everything else is thrown so the existing retry ladder owns it. A
        // failed staff turn must never degrade into a customer reply.
        if (staff.terminal) {
          await failJob(staff.detail, staff.detail);
          continue;
        }
        throw new Error(staff.detail);
      }

      const reply =
        staff.kind === "reply"
          ? staff.reply
          : (
              await runTurn({
                businessId: job.business_id,
                conversation: conversationForTurn,
                history,
                tier
              })
            ).reply;

      await send(
        conversation.platform,
        conversation.page_id,
        account.token,
        conversation.psid,
        reply
      );

      try {
        await complete(job.id, reply, historyMaxMessageId);
      } catch (err) {
        // The reply already reached the lead. The job must NOT stay
        // 'processing': the stale reclaim would requeue it and a retry
        // would run a second turn and send a duplicate reply. Flip it to a
        // terminal error instead, the assistant row is missing from the
        // transcript (loud log), but the lead never sees a double-send.
        logger.error("messenger worker: commit failed AFTER send; failing job to prevent duplicate reply", {
          jobId: job.id,
          conversationId: conversation.id,
          error: err instanceof Error ? err.message : String(err)
        });
        await failJob("commit_failed_after_send", err instanceof Error ? err.message : String(err));
        continue;
      }
      summary.replied += 1;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      // Terminal conditions must not burn retries: no_input means there is
      // nothing to answer (e.g. the owner's manual reply is the newest
      // turn), no_key means the platform is misconfigured, retrying
      // cannot change either.
      // A dead Meta token is terminal for EVERY job in the outage, not just
      // the one that noticed first: retrying cannot mint a credential.
      //
      // The terminal test is isMetaTokenDead, not reportMetaCallFailure's
      // return value. That return means "I was the first to notice", so
      // using it here made every job after the first fall through to the
      // normal three-attempt requeue and dead-letter as turn_failed.
      //
      // WhatsApp is excluded on purpose. It also goes through graphRequest
      // and can throw a 190, but that is the WhatsApp credential, held in
      // whatsapp_connections. Flagging meta_connections for it would tell
      // the owner their FACEBOOK connection died when it had not.
      if (jobPlatform !== "whatsapp" && isMetaTokenDead(err)) {
        await reportMetaCallFailure(job.business_id, err, { surface: "messenger_send" });
        await failJob("meta_token_expired", detail);
        continue;
      }
      if (detail === "messenger_engine_no_input" || detail === "messenger_engine_no_key") {
        await failJob(detail === "messenger_engine_no_input" ? "no_input" : "no_api_key", detail);
        continue;
      }
      // Transient failure (Gemini blip, Send API 5xx): requeue while the
      // claim RPC's attempts bound still allows retries; the final
      // attempt's failure sticks as an error.
      if (job.attempts < 3) {
        summary.failed += 1;
        try {
          await requeue(job.id, claimedAt);
        } catch (requeueErr) {
          logger.error("messenger worker: requeue failed", {
            jobId: job.id,
            error:
              requeueErr instanceof Error ? requeueErr.message : String(requeueErr)
          });
        }
        logger.warn("messenger worker: turn failed; requeued", {
          jobId: job.id,
          attempts: job.attempts,
          error: detail
        });
      } else {
        await failJob("turn_failed", detail);
      }
    }
  }

  return summary;
}
