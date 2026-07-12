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

    return successResponse({ status, marginAlert });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return errorResponse("VALIDATION_ERROR", err.issues[0]?.message ?? "Invalid body");
    }
    return handleRouteError(err);
  }
}
