/**
 * Messenger reply worker — the processing loop behind
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
 * is logged loudly and left to the reclaim path — the complete RPC's
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
  getActiveMetaConnectionByPageId,
  type MetaConnectionRow
} from "@/lib/db/meta-connections";
import { getMessengerProfile, sendMessengerMessage } from "@/lib/meta/client";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import type { PlanTier } from "@/lib/plans/tier";
import { logger } from "@/lib/logger";

export const MESSENGER_WORKER_ID = "platform-messenger-worker";

/** Jobs per invocation — sized against the route's wall-clock budget. */
export const MESSENGER_WORKER_BATCH_LIMIT = 8;

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
  getConnection?: (pageId: string) => Promise<MetaConnectionRow | null>;
  fetchTier?: (businessId: string) => Promise<PlanTier | null>;
  fetchProfileName?: (
    pageToken: string,
    userId: string,
    platform: MessengerConversationRow["platform"]
  ) => Promise<{ name: string | null }>;
  updateContact?: typeof updateMessengerConversationContact;
  runTurn?: (args: RunMessengerGeminiTurnArgs) => Promise<MessengerGeminiTurnResult>;
  send?: typeof sendMessengerMessage;
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
  const getConnection = deps.getConnection ?? getActiveMetaConnectionByPageId;
  const fetchTier = deps.fetchTier ?? fetchBusinessTier;
  const fetchProfileName = deps.fetchProfileName ?? getMessengerProfile;
  const updateContact = deps.updateContact ?? updateMessengerConversationContact;
  const runTurn = deps.runTurn ?? runMessengerGeminiTurn;
  const send = deps.send ?? sendMessengerMessage;
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

    try {
      const conversation = await getConversation(job.conversation_id);
      if (!conversation) {
        await failJob("conversation_missing", job.conversation_id);
        continue;
      }

      // Meta policy: replies only inside the 24h standard messaging
      // window. Nudges beyond it ride SMS (once a phone is captured).
      if (!messengerWindowOpen(conversation, now())) {
        await failJob("window_expired", conversation.last_user_message_at);
        continue;
      }

      const connection = await getConnection(conversation.page_id);
      if (!connection?.pageToken || !connection.page_id) {
        await failJob("not_connected", conversation.page_id);
        continue;
      }

      // Best-effort display name backfill on first touch — the preamble
      // and inbox both read better with a real name.
      let conversationForTurn = conversation;
      if (!conversation.display_name) {
        const profile = await fetchProfileName(
          connection.pageToken,
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
      const turn = await runTurn({
        businessId: job.business_id,
        conversation: conversationForTurn,
        history,
        tier
      });

      await send(connection.page_id, connection.pageToken, conversation.psid, turn.reply);

      try {
        await complete(job.id, turn.reply, historyMaxMessageId);
      } catch (err) {
        // The reply already reached the lead. The job must NOT stay
        // 'processing': the stale reclaim would requeue it and a retry
        // would run a second turn and send a duplicate reply. Flip it to a
        // terminal error instead — the assistant row is missing from the
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
      // turn), no_key means the platform is misconfigured — retrying
      // cannot change either.
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
