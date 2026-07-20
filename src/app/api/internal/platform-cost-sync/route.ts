/**
 * Internal, cron-triggered platform cost sync.
 *
 * Call chain: pg_cron (daily) → Edge fn `platform-cost-sync` → this route.
 * Bearer: `Authorization: Bearer <INTERNAL_CRON_SECRET>`.
 *
 * Pulls Telnyx detail-record actuals (rolling last-7-days window by
 * default; body `{ "telnyxRange": "last_90_days" }` for a backfill) and
 * snapshots the Hostinger billing subscriptions. The admin Costs/Usage
 * pages and the margin engine read the resulting tables. See
 * src/lib/admin/cost-sync.ts.
 */

import { z } from "zod";
import { assertCronAuth } from "@/lib/cron-auth";
import { errorResponse, successResponse, handleRouteError } from "@/lib/api-response";
import { logger } from "@/lib/logger";
import { runProductionPlatformCostSync } from "@/lib/admin/cost-sync-runner";
import { runProductionMarginAlert } from "@/lib/admin/margin-alert-runner";
import type { MarginAlertRunResult } from "@/lib/admin/margin-alert";
import { runProductionGeminiBilledSync } from "@/lib/admin/gemini-billed-sync-runner";
import type { GeminiBilledSyncStatus } from "@/lib/admin/gemini-billed-sync";
import { pruneGeminiSpendEvents } from "@/lib/db/gemini-spend";

// Telnyx MDR paging over a 90-day backfill plus the Hostinger list can take
// minutes on slow vendor days; same ceiling as vps-billing-posture.
export const maxDuration = 300;
export const runtime = "nodejs";

const bodySchema = z.object({
  telnyxRange: z.enum(["last_7_days", "last_30_days", "last_90_days"]).optional()
});

export async function POST(request: Request): Promise<Response> {
  if (!assertCronAuth(request)) {
    return errorResponse("FORBIDDEN", "Invalid cron bearer", 403);
  }
  try {
    const raw = await request.text();
    const body = bodySchema.parse(raw.trim().length > 0 ? JSON.parse(raw) : {});
    const status = await runProductionPlatformCostSync({ telnyxRange: body.telnyxRange });
    logger.info("platform cost sync complete", {
      ok: status.ok,
      telnyxRows: status.telnyxRows,
      telnyxError: status.telnyxError,
      hostingerRows: status.hostingerRows,
      hostingerError: status.hostingerError
    });

    // Margin watchdog rides the sync (freshest vendor numbers) —
    // best-effort: an alert failure must never fail the sync itself.
    let marginAlert: MarginAlertRunResult | null = null;
    try {
      marginAlert = await runProductionMarginAlert();
      if (marginAlert.emailed) {
        logger.info("margin alert digest sent", {
          breaches: marginAlert.breaches.length,
          thresholdCents: marginAlert.thresholdCents
        });
      }
    } catch (err) {
      logger.warn("margin alert run failed", {
        message: err instanceof Error ? err.message : String(err)
      });
    }

    // Gemini billed actuals (Cloud Billing BigQuery export) ride the same
    // daily sync — best-effort like the margin alert, and a recorded skip
    // (not a failure) until the operator finishes the one-time setup.
    let geminiBilled: GeminiBilledSyncStatus | null = null;
    try {
      geminiBilled = await runProductionGeminiBilledSync();
      logger.info("gemini billed sync complete", {
        ok: geminiBilled.ok,
        configured: geminiBilled.configured,
        rows: geminiBilled.rows,
        error: geminiBilled.error
      });
    } catch (err) {
      logger.warn("gemini billed sync failed", {
        message: err instanceof Error ? err.message : String(err)
      });
    }

    // Ledger retention rides the daily sync too (best-effort).
    try {
      const pruned = await pruneGeminiSpendEvents();
      if (pruned > 0) logger.info("gemini spend events pruned", { pruned });
    } catch (err) {
      logger.warn("gemini spend events prune failed", {
        message: err instanceof Error ? err.message : String(err)
      });
    }

    return successResponse({ status, marginAlert, geminiBilled });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return errorResponse("VALIDATION_ERROR", err.issues[0]?.message ?? "Invalid body");
    }
    return handleRouteError(err);
  }
}
