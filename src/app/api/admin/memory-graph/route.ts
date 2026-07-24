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
 *     within the resolver's ~60s cache, and every inherit-mode tenant's
 *     on-box projection ships/wipes immediately via a scheduled vault sync
 *     fan-out (explicit-mode tenants are untouched by a default change, so
 *     syncing them would be wasted SSH).
 */

import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { successResponse, errorResponse, handleRouteError } from "@/lib/api-response";
import { getBusiness, listBusinesses } from "@/lib/db/businesses";
import { getBusinessConfig, patchBusinessConfig } from "@/lib/db/configs";
import { upsertAdminPlatformSetting } from "@/lib/admin/platform-settings";
import {
  MEMORY_GRAPH_DEFAULT_MODE_KEY,
  resetMemoryGraphDefaultCache
} from "@/lib/memory/graph-db";
import { scheduleVaultSync } from "@/lib/vps/schedule-vault-sync";
import { logger } from "@/lib/logger";

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

      // Ship/wipe every INHERIT tenant's on-box projection now instead of
      // waiting for each tenant's next organic vault sync. Best-effort: the
      // default is already persisted above. A tenant whose config read
      // fails is treated as inherit, which errs toward syncing — the sync
      // itself resolves the true mode, so a spurious sync is harmless while
      // a skipped one would leave a stale projection.
      let synced = 0;
      try {
        const businesses = await listBusinesses();
        for (const biz of businesses) {
          const config = await getBusinessConfig(biz.id).catch(() => null);
          const stored = config?.memory_graph_mode ?? "inherit";
          if (stored !== "off" && stored !== "shadow" && stored !== "active") {
            scheduleVaultSync(biz.id);
            synced += 1;
          }
        }
      } catch (err) {
        logger.warn("admin memory-graph: fleet sync fan-out failed; boxes refresh on next sync", {
          error: err instanceof Error ? err.message : String(err)
        });
      }

      return successResponse({ defaultMode: body.defaultMode, syncedTenants: synced });
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
