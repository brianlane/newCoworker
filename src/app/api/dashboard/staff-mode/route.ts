/**
 * Per-surface staff mode (public.coworker_staff_mode).
 *
 * "When you or a team member reaches your coworker HERE, does it answer you
 * as staff?" One row per coworker surface, written from Settings → Coworker.
 *
 * OFF means the coworker does not answer staff on that surface. It never
 * means "answer them as a customer", which is the behavior the surface
 * registry exists to remove.
 */

import { z } from "zod";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { setStaffMode } from "@/lib/owner-surfaces/staff-mode";
import { OWNER_SURFACES, type OwnerSurfaceKey } from "@/lib/owner-surfaces/registry";

// Derived from the registry rather than restated, so a newly registered
// surface is writable without touching this route.
const surfaceKeys = OWNER_SURFACES.map((s) => s.key) as [OwnerSurfaceKey, ...OwnerSurfaceKey[]];

const bodySchema = z.object({
  businessId: z.string().uuid(),
  surfaceKey: z.enum(surfaceKeys),
  enabled: z.boolean()
});

export async function PUT(request: Request) {
  try {
    const user = await getAuthUser();
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");

    const body = bodySchema.parse(await request.json());
    if (!user.isAdmin) await requireBusinessRole(body.businessId, "manage_settings");

    const enabled = await setStaffMode(body.businessId, body.surfaceKey, body.enabled);
    return successResponse({ surfaceKey: body.surfaceKey, enabled });
  } catch (err) {
    return handleRouteError(err);
  }
}
