/**
 * Admin "Sync now" for the platform cost tables (Admin → Costs page).
 *
 * POST → runs the same sync the daily cron performs (Telnyx detail
 * records + Hostinger billing snapshot) and returns the recorded status.
 * Body `{ "telnyxRange": "last_90_days" }` widens the Telnyx window for a
 * one-time backfill; default is the rolling last-7-days window.
 */

import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { errorResponse, successResponse, handleRouteError } from "@/lib/api-response";
import { runProductionPlatformCostSync } from "@/lib/admin/cost-sync-runner";

// Same ceiling as the internal cron route — a 90-day Telnyx backfill pages
// through thousands of MDRs and Hostinger can take 10-30s per call.
export const maxDuration = 300;
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  telnyxRange: z.enum(["last_7_days", "last_30_days", "last_90_days"]).optional()
});

export async function POST(request: Request) {
  try {
    await requireAdmin();
    const raw = await request.text();
    const body = bodySchema.parse(raw.trim().length > 0 ? JSON.parse(raw) : {});
    const status = await runProductionPlatformCostSync({ telnyxRange: body.telnyxRange });
    return successResponse({ status });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return errorResponse("VALIDATION_ERROR", err.issues[0]?.message ?? "Invalid body");
    }
    return handleRouteError(err);
  }
}
