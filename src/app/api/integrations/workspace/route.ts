import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import {
  deleteWorkspaceOAuthConnection,
  getWorkspaceConnectionSecrets,
  getWorkspaceOAuthConnection,
  listWorkspaceOAuthConnections
} from "@/lib/db/workspace-oauth-connections";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import {
  connectionInUseMessage,
  flowsReferencingWorkspaceConnection
} from "@/lib/ai-flows/mailbox-steps";
import { getNangoClient } from "@/lib/nango/server";
import { revokeGoogleToken } from "@/lib/google/oauth";
import { providerFromKey } from "@/lib/voice-tools/connections";
import { logger } from "@/lib/logger";
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
    // must not be silently orphaned: every later run would die at send time
    // with connection_not_found (the KYP Jul 22 2026 incident class). The
    // owner re-points or removes those flows first.
    const referencingFlows = await flowsReferencingWorkspaceConnection(body.businessId, body.id);
    if (referencingFlows.length > 0) {
      return errorResponse("CONFLICT", connectionInUseMessage(referencingFlows), 409);
    }

    // Only a Nango row has anything on Nango's side to revoke. A direct row's
    // connection_id is a synthetic `direct:<uuid>` that Nango has never heard
    // of, so calling deleteConnection with it fails and would 500 every single
    // direct disconnect.
    if (row.transport === "nango" && process.env.NANGO_SECRET_KEY) {
      try {
        const nango = getNangoClient();
        await nango.deleteConnection(row.provider_config_key, row.connection_id);
      } catch (err) {
        console.error("deleteConnection failed:", err);
        return errorResponse("INTERNAL_SERVER_ERROR", "Could not revoke connection with provider");
      }
    }

    // A direct row's tokens have to be read BEFORE the row goes away, because
    // deleting the row deletes the only copy of the ciphertext. Google publishes
    // a scoped revoke endpoint, so for Google "disconnected" can mean revoked
    // rather than merely forgotten. Microsoft publishes no equivalent of Zoom's
    // POST /oauth/revoke (see docs/OUTLOOK-INTEGRATION.md), so an Outlook row's
    // teardown IS deleting the ciphertext: its access token dies within the hour
    // and its refresh token at the tenant's inactivity window, and an owner who
    // wants the grant gone immediately does it at account.live.com/consent/Manage
    // or myapps.microsoft.com.
    const revocable =
      row.transport === "direct" && providerFromKey(row.provider_config_key) === "google"
        ? await getWorkspaceConnectionSecrets(row.id)
        : null;

    const removed = await deleteWorkspaceOAuthConnection(body.businessId, body.id);
    if (!removed) {
      return errorResponse("NOT_FOUND", "Connection not found");
    }

    // Revoke AFTER the row is gone, never before, matching the snapshot-then-
    // delete-then-revoke ordering in src/lib/nango/cleanup.ts: a failed delete
    // must leave the tenant fully intact rather than holding a row whose grant
    // we already killed. Best-effort by design, so a Google outage cannot stop
    // an owner from disconnecting. Revoking the refresh token kills the whole
    // grant, access token included.
    if (revocable) {
      const revoked = await revokeGoogleToken(revocable.refreshToken);
      if (!revoked) {
        logger.warn("google.revoke_failed", {
          businessId: body.businessId,
          connectionId: row.id
        });
      }
    }
    return successResponse({ deleted: true });
  } catch (err) {
    return handleRouteError(err);
  }
}
