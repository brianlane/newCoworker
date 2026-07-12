/**
 * Admin config for the margin alert (Admin → Costs card).
 *
 * GET  → current config (defaults when the row is missing).
 * POST → update toggle / threshold. Values round-trip through the SAME
 *        parser the daily cost-sync watchdog uses
 *        (src/lib/admin/margin-alert.ts), so what the admin saves is
 *        exactly what the next sync enforces — no redeploy needed.
 */

import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import {
  getAdminPlatformSetting,
  upsertAdminPlatformSetting
} from "@/lib/admin/platform-settings";
import {
  MARGIN_ALERT_SETTINGS_KEY,
  MAX_THRESHOLD_CENTS,
  MIN_THRESHOLD_CENTS,
  parseMarginAlertConfig,
  serializeMarginAlertConfig
} from "@/lib/admin/margin-alert";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await requireAdmin();
    const stored = await getAdminPlatformSetting(MARGIN_ALERT_SETTINGS_KEY);
    return successResponse({ config: parseMarginAlertConfig(stored) });
  } catch (err) {
    return handleRouteError(err);
  }
}

const bodySchema = z.object({
  enabled: z.boolean(),
  thresholdCents: z
    .number()
    .int()
    .min(MIN_THRESHOLD_CENTS, "Threshold must be at least -$1,000")
    .max(MAX_THRESHOLD_CENTS, "Threshold must be at most $1,000")
});

export async function POST(request: Request) {
  try {
    await requireAdmin();
    const body = bodySchema.parse(await request.json());
    // Round-trip through the shared parser so the persisted jsonb is
    // guaranteed to read back as exactly what was saved.
    const config = parseMarginAlertConfig(
      serializeMarginAlertConfig({
        enabled: body.enabled,
        thresholdCents: body.thresholdCents
      })
    );
    await upsertAdminPlatformSetting(
      MARGIN_ALERT_SETTINGS_KEY,
      serializeMarginAlertConfig(config)
    );
    return successResponse({ config });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return errorResponse("VALIDATION_ERROR", err.issues[0]?.message ?? "Invalid body");
    }
    return handleRouteError(err);
  }
}
