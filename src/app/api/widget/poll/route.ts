/**
 * GET /api/widget/poll — reply delivery for the website chat widget.
 *
 * The widget calls this ONLY while a job is in flight AND the tab is
 * visible (see public/widget frame JS), with backoff — there is no
 * standing poll loop. Anonymous visitors can't use Supabase Realtime
 * (deny-by-default RLS), so this is the delivery path.
 *
 * Query: key, jobId (optional), after (message-id cursor, 0 for none).
 * Without a jobId this is a plain history read — the frame uses it to
 * re-hydrate the transcript when a returning visitor reopens the widget.
 * Auth: public site key + per-session bearer; the job must belong to the
 * bearer's session, so one visitor can never watch another's turn.
 *
 * Gemini reply engine (chat_widget_settings.reply_engine='gemini'): for
 * tenants answered centrally instead of by a box chat-worker, THIS route
 * is the engine's trigger — the first poll that sees the job still queued
 * claims it (conditional UPDATE, race-safe) and runs the direct-Gemini
 * turn inline, so the same request usually returns the finished reply.
 * Tenants on the default 'vps' engine are untouched.
 */

import { z } from "zod";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import {
  claimWebchatJobForPlatform,
  completeWebchatJobFromPlatform,
  failWebchatJobFromPlatform,
  getWebchatJobById,
  listWebchatMessagesSince,
  reclaimStaleWebchatJobForPlatform,
  serializeWebchatMessages,
  webchatReplyEngine,
  type WebchatJobRow
} from "@/lib/webchat/db";
import { resolveWidgetContext, verifyWebchatSession } from "@/lib/webchat/service";
import { runWebchatGeminiTurn } from "@/lib/webchat/gemini-engine";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import type { PlanTier } from "@/lib/plans/tier";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";
// The inline Gemini turn (tool rounds included) needs more than the
// default budget; the engine's own deadline is 30s, well inside this.
export const maxDuration = 60;

const querySchema = z.object({
  key: z.string().max(200),
  jobId: z.string().uuid().optional(),
  after: z.coerce.number().int().min(0).default(0)
});

/** Visitor-facing copy for a failed turn — never the raw error taxonomy. */
const JOB_ERROR_MESSAGE =
  "Sorry — I couldn't get a reply just now. Please try sending that again.";

/**
 * Claim + answer one queued job with the direct-Gemini engine. Returns the
 * job's resulting status. Every failure path flips the job to 'error' so
 * the widget stops polling with honest copy instead of spinning out its
 * full five-minute window.
 */
async function runPlatformEngineTurn(
  job: WebchatJobRow,
  business: { id: string; tier: string | null }
): Promise<"done" | "error" | null> {
  // Queued → normal claim. Processing → steal only a STALE platform claim
  // (route crashed mid-turn, or the error-flip below failed) so a wedged
  // job gets retried on a later poll instead of spinning out the widget's
  // whole window; a healthy in-flight claim is never stolen.
  const claimed =
    job.status === "queued"
      ? await claimWebchatJobForPlatform(job.id)
      : await reclaimStaleWebchatJobForPlatform(job.id);
  if (!claimed) return null; // lost the race / claim still healthy — re-read below

  const t0 = Date.now();
  let outcome: "done" | "error" = "error";
  let toolRounds = 0;
  let refusedOverCap = false;
  let errorMessage: string | null = null;
  try {
    const inputMessages =
      claimed.stateless_input_messages ?? claimed.input_messages ?? [];
    const result = await runWebchatGeminiTurn({
      businessId: business.id,
      inputMessages,
      tier: (business.tier as PlanTier | null) ?? null
    });
    toolRounds = result.toolRounds;
    refusedOverCap = result.refusedOverCap;
    await completeWebchatJobFromPlatform(claimed, result.reply);
    outcome = "done";
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : String(err);
    logger.error("widget/poll: gemini engine turn failed", {
      businessId: business.id,
      jobId: job.id,
      error: errorMessage
    });
    try {
      await failWebchatJobFromPlatform(job.id, errorMessage.split(":")[0], errorMessage);
    } catch (failErr) {
      // The job stays 'processing'; the widget's poll window ends with its
      // generic slow-turn copy. Loud log — nothing else to do inline.
      logger.error("widget/poll: gemini engine job fail-flip failed", {
        jobId: job.id,
        error: failErr instanceof Error ? failErr.message : String(failErr)
      });
    }
  }

  // Best-effort telemetry — dashboards/alerts key off this event type.
  try {
    const db = await createSupabaseServiceClient();
    await db.rpc("telemetry_record", {
      p_event_type: "webchat_gemini_engine_turn",
      p_payload: {
        business_id: business.id,
        job_id: job.id,
        ok: outcome === "done",
        duration_ms: Date.now() - t0,
        tool_rounds: toolRounds,
        refused_over_cap: refusedOverCap,
        error: errorMessage
      }
    });
  } catch (err) {
    logger.warn("widget/poll: engine telemetry emit failed", {
      jobId: job.id,
      error: err instanceof Error ? err.message : String(err)
    });
  }

  return outcome;
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const query = querySchema.parse({
      key: url.searchParams.get("key") ?? "",
      jobId: url.searchParams.get("jobId") ?? undefined,
      after: url.searchParams.get("after") ?? "0"
    });

    const ctx = await resolveWidgetContext({ key: query.key });
    if (!ctx.ok) {
      if (ctx.reason === "offline") {
        return errorResponse("CONFLICT", "Chat is offline right now.");
      }
      return errorResponse("UNAUTHORIZED", "This chat widget is not available.");
    }

    const session = await verifyWebchatSession({
      authorizationHeader: request.headers.get("authorization"),
      businessId: ctx.business.id
    });
    if (!session) {
      return errorResponse("UNAUTHORIZED", "Chat session expired. Please start a new chat.");
    }

    let jobStatus: string | null = null;
    if (query.jobId) {
      const job = await getWebchatJobById(query.jobId);
      if (!job || job.session_id !== session.id) {
        // Same response for "not yours" and "doesn't exist".
        return errorResponse("NOT_FOUND", "Unknown chat turn.");
      }
      jobStatus = job.status;

      if (
        (job.status === "queued" || job.status === "processing") &&
        webchatReplyEngine(ctx.settings) === "gemini"
      ) {
        const outcome = await runPlatformEngineTurn(job, ctx.business);
        if (outcome) {
          jobStatus = outcome;
        } else {
          // Claim lost / still healthy — someone is answering; report
          // their progress.
          const reread = await getWebchatJobById(query.jobId);
          jobStatus = reread?.status ?? jobStatus;
        }
      }
    }

    const messages = await listWebchatMessagesSince(session.id, query.after);

    return successResponse({
      status: jobStatus,
      errorMessage: jobStatus === "error" ? JOB_ERROR_MESSAGE : null,
      messages: serializeWebchatMessages(messages)
    });
  } catch (err) {
    return handleRouteError(err);
  }
}
