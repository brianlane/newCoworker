/**
 * Internal, worker-triggered endpoint that runs the dashboard chat
 * thread summarizer.
 *
 * Why this exists: the rolling summary used to fire from the POST
 * /api/dashboard/chat route after the assistant message was streamed
 * back. PR #79 moved generation off Vercel onto the per-tenant VPS
 * chat-worker, which means the route now returns BEFORE the assistant
 * turn is persisted. Firing the summarizer from the route at that
 * point would build a summary missing the latest assistant turn —
 * Bugbot Medium-severity finding on PR #79. Moving the trigger here
 * (called by the worker AFTER it persists the assistant message)
 * keeps the summarizer logic in TypeScript on Vercel without porting
 * it to the worker, while restoring "summary always reflects the
 * latest persisted turn" semantics.
 *
 * Call chain:
 *   VPS chat-worker (after assistant insert) → this route
 *     → shouldSummarize → summarizeThreadAndLog
 *
 * Auth: `Authorization: Bearer <INTERNAL_CRON_SECRET>` — same shape
 * and same secret as the other /api/internal/* endpoints (trusted
 * internal traffic only, never reachable through the public CDN
 * surface; the worker holds the secret as WORKER_VERCEL_BEARER).
 *
 * Fire-and-forget contract: the worker does NOT await this call's
 * outcome. shouldSummarize is a cheap gate (one SELECT count) so
 * non-trigger turns return ~instantly; trigger turns kick off
 * summarizeThreadAndLog which itself catches all errors internally
 * (returns ok:false rather than throwing). A 5xx from this route
 * means the next turn re-evaluates shouldSummarize and the work just
 * happens one turn later — self-healing.
 */

import { z } from "zod";
import { assertCronAuth } from "@/lib/cron-auth";
import { errorResponse, successResponse } from "@/lib/api-response";
import { logger } from "@/lib/logger";
import { getThreadById, listMessages } from "@/lib/db/dashboard-chat";
import {
  shouldSummarize,
  summarizeThread
} from "@/lib/dashboard-chat/summarizer";

// summarizeThread internally caps Rowboat at 60s; add 30s for DB
// reads/writes. We're well below Vercel's Hobby ceiling and this
// call is sequential per (thread, turn) so even a handful of slow
// tenants here can't backpressure live POST traffic.
export const maxDuration = 90;
export const runtime = "nodejs";

const bodySchema = z.object({
  businessId: z.string().uuid(),
  threadId: z.string().uuid()
});

export async function POST(request: Request): Promise<Response> {
  if (!assertCronAuth(request)) {
    return errorResponse("FORBIDDEN", "Invalid cron bearer", 403);
  }

  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await request.json());
  } catch (err) {
    return errorResponse(
      "VALIDATION_ERROR",
      err instanceof Error ? err.message : "invalid body",
      400
    );
  }

  const startedAt = Date.now();

  // Confirm the thread still exists and belongs to the claimed
  // business — protects against a bogus worker payload poking at
  // someone else's thread. shouldSummarize() and summarizeThread()
  // both trust their (businessId, threadId) input, so we own the
  // gating here.
  const thread = await getThreadById(body.threadId);
  if (!thread || thread.business_id !== body.businessId) {
    logger.warn("dashboard-chat-summarize thread mismatch", {
      threadId: body.threadId,
      claimedBusinessId: body.businessId,
      actualBusinessId: thread?.business_id ?? null
    });
    return errorResponse("NOT_FOUND", "Thread not found for business", 404);
  }

  const messages = await listMessages(body.threadId);
  if (!shouldSummarize(thread, messages.length)) {
    // Cheap gate — most worker calls land here and exit quickly.
    return successResponse({
      triggered: false,
      messageCount: messages.length,
      durationMs: Date.now() - startedAt
    });
  }

  // Threshold tripped: regenerate the summary. summarizeThread
  // catches its own errors and returns a discriminated result; we
  // log either way for ops visibility but never throw.
  const result = await summarizeThread(body.businessId, body.threadId);
  const durationMs = Date.now() - startedAt;

  if (result.ok) {
    logger.info("dashboard-chat-summarize ok", {
      businessId: body.businessId,
      threadId: body.threadId,
      messageCount: messages.length,
      summaryChars: result.summary.length,
      durationMs
    });
  } else {
    logger.warn("dashboard-chat-summarize skipped/failed", {
      businessId: body.businessId,
      threadId: body.threadId,
      reason: result.reason,
      detail: "detail" in result ? result.detail : undefined,
      durationMs
    });
  }

  // Surface failure as an error envelope so the wire shape's outer
  // `ok` field is the source of truth (no nested `ok: false` inside
  // `data`). The worker fire-and-forgets this call, so the outcome
  // wire shape only matters for ops/curl debugging.
  if (!result.ok) {
    return errorResponse(
      "INTERNAL_SERVER_ERROR",
      `summarize_failed:${result.reason}`,
      500
    );
  }

  return successResponse({
    triggered: true,
    summaryChars: result.summary.length,
    durationMs
  });
}
