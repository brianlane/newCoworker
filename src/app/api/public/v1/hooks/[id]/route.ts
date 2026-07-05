/**
 * DELETE /api/public/v1/hooks/:id — unsubscribe a REST hook.
 *
 * Zapier calls this when a Zap is turned off. Hard delete (business-scoped);
 * deleting an already-gone hook returns 404, which Zapier treats as success.
 *
 * Auth: `Authorization: Bearer nck_…` (public API key).
 */

import { z } from "zod";
import { authenticatePublicApiRequest } from "@/lib/public-api/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { deleteWebhookSubscription } from "@/lib/db/webhook-subscriptions";

export const dynamic = "force-dynamic";

const paramsSchema = z.object({ id: z.string().uuid("Invalid hook id") });

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await authenticatePublicApiRequest(request);
    if (!auth) return errorResponse("UNAUTHORIZED", "Invalid or missing API key");

    const { id } = paramsSchema.parse(await context.params);
    const deleted = await deleteWebhookSubscription(auth.businessId, id);
    if (!deleted) return errorResponse("NOT_FOUND", "Hook not found");

    return successResponse({ deleted: true });
  } catch (err) {
    return handleRouteError(err);
  }
}
