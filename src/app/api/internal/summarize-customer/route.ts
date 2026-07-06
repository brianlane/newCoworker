/**
 * Internal, cron-triggered endpoint that runs the cross-channel
 * customer memory summarizer for a single (business_id, customer_e164)
 * pair.
 *
 * Why this exists: the summarizer module lives in src/lib (Next.js
 * runtime) — it imports the platform Supabase client, the Rowboat
 * chat client, the business-config helper, etc. that aren't
 * available from a Deno Edge function. The Edge cron sweep
 * (`customer-memory-summarize-sweep`) walks the queue and posts here
 * once per eligible row.
 *
 * Call chain:
 *   pg_cron → Edge `customer-memory-summarize-sweep`
 *           → this route (one row at a time) → summarizeCustomerMemoryAndLog
 *
 * Auth: `Authorization: Bearer <INTERNAL_CRON_SECRET>` (same shape as
 * the other /api/internal/* endpoints; trusted internal traffic only,
 * never wired to public CDN).
 *
 * Response shape: forwards the SummarizeResult so the cron sweep's
 * telemetry includes per-row outcomes, not just an http status.
 */

import { z } from "zod";
import { assertCronAuth } from "@/lib/cron-auth";
import { errorResponse, successResponse } from "@/lib/api-response";
import { logger } from "@/lib/logger";
import { summarizeCustomerMemory } from "@/lib/customer-memory/summarizer";

// Per-call ceiling. The summarizer's own SUMMARY_TIMEOUT_MS is 60s
// for the Rowboat hop; we add ~30s for DB reads + writes and cap
// well under Vercel's free-tier maxDuration. Cron is sequential so
// even a handful of slow tenants here just stretches the next sweep
// window, never blocks live traffic.
export const maxDuration = 90;
export const runtime = "nodejs";

const bodySchema = z.object({
  businessId: z.string().uuid(),
  customerE164: z.string().regex(/^\+[1-9]\d{6,15}$/),
  // Telemetry hint so the summarizer log line distinguishes nightly
  // sweep retries from live fire-and-forget calls. Free-form so
  // future sources ("manual_owner_refresh", etc.) don't require a
  // schema change.
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
  const result = await summarizeCustomerMemory(body.businessId, body.customerE164);
  const durationMs = Date.now() - startedAt;

  if (result.ok) {
    logger.info("summarize-customer ok", {
      businessId: body.businessId,
      customerE164: body.customerE164,
      source: body.source ?? "unknown",
      voiceTurnCount: result.voiceTurnCount,
      smsTurnCount: result.smsTurnCount,
      summaryChars: result.summary.length,
      durationMs
    });
  } else {
    // info for expected skips so we don't pager on quiet rows; warn
    // for actual failures so they show up in alerting.
    const isExpectedSkip =
      result.reason === "below_threshold" ||
      result.reason === "debounced" ||
      result.reason === "no_customer_content";
    const log = isExpectedSkip ? logger.info : logger.warn;
    log.call(logger, "summarize-customer skipped/failed", {
      businessId: body.businessId,
      customerE164: body.customerE164,
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
      ? {
          voiceTurnCount: result.voiceTurnCount,
          smsTurnCount: result.smsTurnCount,
          summaryChars: result.summary.length
        }
      : { reason: result.reason, detail: result.detail })
  });
}
