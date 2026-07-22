import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import {
  deleteWorkspaceOAuthConnection,
  getWorkspaceOAuthConnection,
  listWorkspaceOAuthConnections
} from "@/lib/db/workspace-oauth-connections";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import {
  connectionInUseMessage,
  flowsReferencingWorkspaceConnection
} from "@/lib/ai-flows/mailbox-steps";
import { getNangoClient } from "@/lib/nango/server";
import { z } from "zod";

const businessIdSchema = z.string().uuid();

const deleteBodySchema = z.object({
  businessId: z.string().uuid(),
  id: z.string().uuid()
});

export async function GET(request: Request) {
  try {
    const user = await getAuthUser();
    if (!user?.email) {
      return errorResponse("UNAUTHORIZED", "Authentication required");
    }

    const url = new URL(request.url);
    const businessId = url.searchParams.get("businessId");
    const parsed = businessIdSchema.safeParse(businessId);
    if (!parsed.success) {
      return errorResponse("VALIDATION_ERROR", "businessId is required");
    }

    await requireBusinessRole(parsed.data, "manage_settings");
    const rows = await listWorkspaceOAuthConnections(parsed.data);
    return successResponse(
      rows.map((r) => ({
        id: r.id,
        providerConfigKey: r.provider_config_key,
        connectionId: r.connection_id,
        createdAt: r.created_at,
        metadata: r.metadata
      }))
    );
  } catch (err) {
    return handleRouteError(err);
  }
}

export async function DELETE(request: Request) {
  try {
    const user = await getAuthUser();
    if (!user) {
      return errorResponse("UNAUTHORIZED", "Authentication required");
    }

    const body = deleteBodySchema.parse(await request.json());

    if (!user.isAdmin) {
      await requireBusinessRole(body.businessId, "manage_settings");
    }

    const row = await getWorkspaceOAuthConnection(body.businessId, body.id);
    if (!row) {
      return errorResponse("NOT_FOUND", "Connection not found");
    }

    // Fail closed: a connection some flow still sends from (or triggers on)
    // must not be silently orphaned — every later run would die at send time
    // with connection_not_found (the KYP Jul 22 2026 incident class). The
    // owner re-points or removes those flows first.
    const referencingFlows = await flowsReferencingWorkspaceConnection(body.businessId, body.id);
    if (referencingFlows.length > 0) {
      return errorResponse("CONFLICT", connectionInUseMessage(referencingFlows), 409);
    }

    if (process.env.NANGO_SECRET_KEY) {
      try {
        const nango = getNangoClient();
        await nango.deleteConnection(row.provider_config_key, row.connection_id);
      } catch (err) {
        console.error("deleteConnection failed:", err);
        return errorResponse("INTERNAL_SERVER_ERROR", "Could not revoke connection with provider");
      }
    }

    const removed = await deleteWorkspaceOAuthConnection(body.businessId, body.id);
    if (!removed) {
      return errorResponse("NOT_FOUND", "Connection not found");
    }
    return successResponse({ deleted: true });
  } catch (err) {
    return handleRouteError(err);
  }
}
