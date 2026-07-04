/**
 * Internal, cron-triggered endpoint that generates the AI summary + sentiment
 * for a single voice call transcript (Standard/Enterprise perk).
 *
 * Why this exists: the summarizer lives in src/lib (Next.js runtime) — it
 * needs the Gemini key and meterGeminiSpendForBusiness, which aren't
 * available from a Deno Edge function. The Edge cron sweep
 * (`call-summary-sweep`) scans eligible rows and posts here once per row.
 *
 * Call chain:
 *   pg_cron → Edge `call-summary-sweep`
 *           → this route (one row at a time) → summarizeCallTranscript
 *
 * Auth: `Authorization: Bearer <INTERNAL_CRON_SECRET>` (same shape as the
 * other /api/internal/* endpoints; trusted internal traffic only).
 */

import { z } from "zod";
import { assertCronAuth } from "@/lib/cron-auth";
import { errorResponse, successResponse } from "@/lib/api-response";
import { logger } from "@/lib/logger";
import { summarizeCallTranscript } from "@/lib/call-summaries/summarizer";

// The summarizer aborts its Gemini call at 25s (CALL_SUMMARY_GEMINI_TIMEOUT_MS),
// so 30s covers the model call plus the handful of DB reads/writes. Keeping
// this tight is what lets the sweep's wall-clock budget guarantee a run fits
// inside the pg_net cron timeout.
export const maxDuration = 30;
export const runtime = "nodejs";

const bodySchema = z.object({
  businessId: z.string().uuid(),
  transcriptId: z.string().uuid(),
  // Telemetry hint ("cron_sweep" today; free-form so future sources don't
  // require a schema change).
  source: z.string().max(64).optional()
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
  const result = await summarizeCallTranscript(body.businessId, body.transcriptId);
  const durationMs = Date.now() - startedAt;

  if (result.ok) {
    logger.info("summarize-call ok", {
      businessId: body.businessId,
      transcriptId: body.transcriptId,
      source: body.source ?? "unknown",
      sentiment: result.sentiment,
      summaryChars: result.summary.length,
      turnCount: result.turnCount,
      durationMs
    });
  } else {
    // Expected skips (tier, already done, empty call) log at info; real
    // failures at warn so they show up in alerting.
    const isExpectedSkip =
      result.reason === "tier" ||
      result.reason === "already_summarized" ||
      result.reason === "claimed_elsewhere" ||
      result.reason === "not_completed" ||
      result.reason === "empty_transcript";
    const log = isExpectedSkip ? logger.info : logger.warn;
    log.call(logger, "summarize-call skipped/failed", {
      businessId: body.businessId,
      transcriptId: body.transcriptId,
      source: body.source ?? "unknown",
      reason: result.reason,
      detail: result.detail,
      durationMs
    });
  }

  return successResponse({
    ok: result.ok,
    durationMs,
    ...(result.ok
      ? { sentiment: result.sentiment, summaryChars: result.summary.length }
      : { reason: result.reason, detail: result.detail })
  });
}
