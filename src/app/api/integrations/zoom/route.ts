/**
 * Owner-facing management for the business's DIRECT Zoom connection
 * (first-party OAuth, the Nango-free path, mirroring
 * /api/integrations/calendly).
 *
 *   GET    ?businessId=…       → connection state (masked; no token material)
 *   PATCH  {businessId, isActive?, autoImportTranscripts?}
 *                              → soft-disable / re-enable, and/or flip the
 *                                webhook auto-import switch.
 *   DELETE {businessId}        → best-effort token revoke at Zoom, then
 *                                remove the connection entirely.
 *
 * Connect/reconnect is the browser-navigated OAuth flow under
 * /api/integrations/zoom/connect, there is no token-paste path.
 */
import { z } from "zod";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import {
  deleteZoomConnection,
  getPublicZoomConnection,
  getZoomConnection,
  setZoomConnectionActive,
  setZoomConnectionAutoImport
} from "@/lib/db/zoom-connections";
import { backfillZoomIdentityIfMissing } from "@/lib/zoom/client";
import { revokeZoomToken } from "@/lib/zoom/oauth";

const businessIdSchema = z.string().uuid();

const patchSchema = z
  .object({
    businessId: z.string().uuid(),
    isActive: z.boolean().optional(),
    autoImportTranscripts: z.boolean().optional()
  })
  .refine((body) => body.isActive !== undefined || body.autoImportTranscripts !== undefined, {
    message: "isActive or autoImportTranscripts is required"
  });

async function authorize(businessId: string) {
  const user = await getAuthUser();
  if (!user?.email) return null;
  if (!user.isAdmin) {
    await requireBusinessRole(businessId, "manage_settings");
  }
  return user;
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const parsed = businessIdSchema.safeParse(url.searchParams.get("businessId"));
    if (!parsed.success) {
      return errorResponse("VALIDATION_ERROR", "businessId is required");
    }
    const user = await authorize(parsed.data);
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");
    // Heal a connect that raced a users/me failure: without zoom_user_id,
    // webhook host routing (auto-import, deauthorization) misses the tenant.
    await backfillZoomIdentityIfMissing(parsed.data);
    const row = await getPublicZoomConnection(parsed.data);
    return successResponse(row);
  } catch (err) {
    return handleRouteError(err);
  }
}

export async function PATCH(request: Request) {
  try {
    const body = patchSchema.parse(await request.json());
    const user = await authorize(body.businessId);
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");
    const existing = await getPublicZoomConnection(body.businessId);
    if (!existing) return errorResponse("NOT_FOUND", "No Zoom connection");
    if (body.isActive !== undefined) {
      await setZoomConnectionActive(body.businessId, body.isActive);
    }
    if (body.autoImportTranscripts !== undefined) {
      await setZoomConnectionAutoImport(body.businessId, body.autoImportTranscripts);
    }
    const row = await getPublicZoomConnection(body.businessId);
    return successResponse(row);
  } catch (err) {
    return handleRouteError(err);
  }
}

export async function DELETE(request: Request) {
  try {
    const body = z
      .object({ businessId: z.string().uuid() })
      .parse(await request.json());
    const user = await authorize(body.businessId);
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");

    // Best-effort revoke so the grant doesn't linger on the Zoom account;
    // deletion proceeds regardless (revoke can 4xx on already-dead tokens).
    const row = await getZoomConnection(body.businessId).catch(() => null);
    if (row) {
      // Revoke with the client that minted the grant: the wrong pair gets a
      // 401 invalid_client, which revokeZoomToken swallows, leaving the app
      // still authorized on the user's Zoom account after they disconnected.
      await revokeZoomToken(row.accessToken, row.oauth_client_env);
    }

    await deleteZoomConnection(body.businessId);
    return successResponse({ deleted: true });
  } catch (err) {
    return handleRouteError(err);
  }
}
