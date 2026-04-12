import { getAuthUser, requireOwner } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { upsertWorkspaceOAuthConnection } from "@/lib/db/workspace-oauth-connections";
import {
  getNangoClient,
  readConnectionEndUserId,
  workspaceConnectionMetadataFromNangoConnection
} from "@/lib/nango/server";
import { z } from "zod";

const bodySchema = z.object({
  businessId: z.string().uuid(),
  connectionId: z.string().min(1),
  providerConfigKey: z.string().min(1)
});

export async function POST(request: Request) {
  try {
    const user = await getAuthUser();
    if (!user?.email) {
      return errorResponse("UNAUTHORIZED", "Authentication required");
    }

    if (!process.env.NANGO_SECRET_KEY) {
      return errorResponse(
        "INTERNAL_SERVER_ERROR",
        "Workspace connections are not available (service misconfigured)",
        503
      );
    }

    const parsed = bodySchema.parse(await request.json());
    await requireOwner(parsed.businessId);

    const nango = getNangoClient();
    const connection = await nango.getConnection(parsed.providerConfigKey, parsed.connectionId);
    const endUserId = readConnectionEndUserId(connection);

    if (endUserId !== parsed.businessId) {
      return errorResponse("FORBIDDEN", "Connection does not belong to this workspace");
    }

    await upsertWorkspaceOAuthConnection({
      businessId: parsed.businessId,
      providerConfigKey: parsed.providerConfigKey,
      connectionId: parsed.connectionId,
      metadata: workspaceConnectionMetadataFromNangoConnection(connection)
    });

    return successResponse({ connected: true });
  } catch (err) {
    return handleRouteError(err);
  }
}
