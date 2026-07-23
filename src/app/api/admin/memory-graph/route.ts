/**
 * Admin control for the memory knowledge-graph rollout.
 *
 * Two actions on one route (both admin-only):
 *   { businessId, mode }  — per-tenant override ('inherit' follows the
 *     fleet default). Schedules a vault sync so the on-box projection
 *     ships (shadow/active) or wipes (off) immediately — the same step the
 *     CLI flips ran manually.
 *   { defaultMode }       — the fleet-wide default every 'inherit' tenant
 *     follows (admin_platform_settings key). Retrieval/ingest pick it up
 *     within the resolver's ~60s cache; each inherit-tenant's on-box
 *     projection refreshes on its next vault sync.
 */

import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { successResponse, errorResponse, handleRouteError } from "@/lib/api-response";
import { getBusiness } from "@/lib/db/businesses";
import { patchBusinessConfig } from "@/lib/db/configs";
import { upsertAdminPlatformSetting } from "@/lib/admin/platform-settings";
import {
  MEMORY_GRAPH_DEFAULT_MODE_KEY,
  resetMemoryGraphDefaultCache
} from "@/lib/memory/graph-db";
import { scheduleVaultSync } from "@/lib/vps/schedule-vault-sync";

// The vault sync (after()) SSHes into the tenant box; budget like the other
// sync-scheduling routes.
export const runtime = "nodejs";
export const maxDuration = 120;

const bodySchema = z.union([
  z.object({
    businessId: z.string().uuid(),
    mode: z.enum(["inherit", "off", "shadow", "active"])
  }),
  z.object({
    defaultMode: z.enum(["off", "shadow", "active"])
  })
]);

export async function POST(request: Request) {
  try {
    await requireAdmin();

    const body = bodySchema.parse(await request.json());

    if ("defaultMode" in body) {
      await upsertAdminPlatformSetting(MEMORY_GRAPH_DEFAULT_MODE_KEY, body.defaultMode);
      // This serverless instance serves the new default immediately; other
      // instances converge within the resolver's ~60s cache TTL.
      resetMemoryGraphDefaultCache();
      return successResponse({ defaultMode: body.defaultMode });
    }

    const business = await getBusiness(body.businessId);
    if (!business) return errorResponse("NOT_FOUND", "Business not found");

    await patchBusinessConfig(body.businessId, { memory_graph_mode: body.mode });
    // Ship or wipe the on-box projection to match the new effective mode.
    scheduleVaultSync(body.businessId);

    return successResponse({ businessId: body.businessId, mode: body.mode });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return errorResponse("VALIDATION_ERROR", err.issues[0]?.message ?? "Invalid body");
    }
    return handleRouteError(err);
  }
}
