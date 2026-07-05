/**
 * DELETE /api/dashboard/api-keys/:id — revoke a public API key.
 *
 * Soft revoke (revoked_at stamp): the row stays for the audit trail and the
 * dashboard list, but findActiveApiKeyByHash stops matching immediately, so
 * any Zapier connection using the key gets 401 on its next call.
 *
 * Auth: session owner (admins may target any business). Body: { businessId }.
 */

import { z } from "zod";
import { getAuthUser, requireOwner } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { revokeApiKey } from "@/lib/db/api-keys";

export const dynamic = "force-dynamic";

const bodySchema = z.object({ businessId: z.string().uuid() });
const idSchema = z.string().uuid("Invalid key id");

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const user = await getAuthUser();
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");

    const { id } = await context.params;
    const keyId = idSchema.parse(id);
    const json = (await request.json().catch(() => null)) as unknown;
    const { businessId } = bodySchema.parse(json);
    if (!user.isAdmin) await requireOwner(businessId);

    const revoked = await revokeApiKey(businessId, keyId);
    if (!revoked) return errorResponse("NOT_FOUND", "API key not found");

    return successResponse({ revoked: true });
  } catch (err) {
    return handleRouteError(err);
  }
}
