/**
 * Admin config for the Gemini spend-velocity alert (Admin → System card).
 *
 * GET  → current config (defaults when the row is missing).
 * POST → update toggle / threshold / window. Values are validated and
 *        clamped by the SAME parser the Edge cron uses
 *        (_shared/spend_velocity.ts), so what the admin saves is exactly
 *        what the watchdog enforces on its next 10-minute tick — no
 *        redeploy needed.
 */

import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import {
  getAdminPlatformSetting,
  upsertAdminPlatformSetting
} from "@/lib/admin/platform-settings";
import {
  MAX_WINDOW_MINUTES,
  MIN_THRESHOLD_MICROS,
  MIN_WINDOW_MINUTES,
  SPEND_VELOCITY_SETTINGS_KEY,
  parseSpendVelocityConfig,
  serializeSpendVelocityConfig
} from "../../../../../supabase/functions/_shared/spend_velocity";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await requireAdmin();
    const stored = await getAdminPlatformSetting(SPEND_VELOCITY_SETTINGS_KEY);
    return successResponse({ config: parseSpendVelocityConfig(stored) });
  } catch (err) {
    return handleRouteError(err);
  }
}

const bodySchema = z.object({
  enabled: z.boolean(),
  thresholdMicros: z
    .number()
    .int()
    .min(MIN_THRESHOLD_MICROS, "Threshold must be at least $0.10")
    .max(1_000_000_000, "Threshold must be at most $1,000"),
  windowMinutes: z
    .number()
    .int()
    .min(MIN_WINDOW_MINUTES, `Window must be at least ${MIN_WINDOW_MINUTES} minutes`)
    .max(MAX_WINDOW_MINUTES, "Window must be at most 24 hours")
});

export async function POST(request: Request) {
  try {
    await requireAdmin();
    const body = bodySchema.parse(await request.json());
    // Round-trip through the shared parser so the persisted jsonb is
    // guaranteed to read back as exactly what was saved.
    const config = parseSpendVelocityConfig(
      serializeSpendVelocityConfig({
        enabled: body.enabled,
        thresholdMicros: body.thresholdMicros,
        windowMinutes: body.windowMinutes
      })
    );
    await upsertAdminPlatformSetting(
      SPEND_VELOCITY_SETTINGS_KEY,
      serializeSpendVelocityConfig(config)
    );
    return successResponse({ config });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return errorResponse("VALIDATION_ERROR", err.issues[0]?.message ?? "Invalid body");
    }
    return handleRouteError(err);
  }
}
