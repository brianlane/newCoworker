import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import {
  getWorkspaceOAuthConnectionByNangoIds,
  upsertWorkspaceOAuthConnection
} from "@/lib/db/workspace-oauth-connections";
import {
  getNangoClient,
  readConnectionEndUserId,
  workspaceConnectionMetadataFromNangoConnection
} from "@/lib/nango/server";
import {
  fetchProviderAccountIdentity,
  nangoIdentityPatchBody,
  providerAccountMetadata
} from "@/lib/nango/account-identity";
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
    await requireBusinessRole(parsed.businessId, "manage_settings");

    const nango = getNangoClient();
    const connection = await nango.getConnection(parsed.providerConfigKey, parsed.connectionId);
    const endUserId = readConnectionEndUserId(connection);

    if (endUserId !== parsed.businessId) {
      return errorResponse("FORBIDDEN", "Connection does not belong to this workspace");
    }

    // Re-completing an existing connection must MERGE metadata, not replace
    // it: app-owned keys written after the original connect (the shared
    // NewCoworker calendar id + ACL grants) would otherwise be dropped on
    // every reconnect, orphaning the real shared calendar and letting the
    // next booking create a duplicate.
    const existing = await getWorkspaceOAuthConnectionByNangoIds(
      parsed.businessId,
      parsed.providerConfigKey,
      parsed.connectionId
    );
    const mergedMetadata = {
      ...(existing?.metadata ?? {}),
      ...workspaceConnectionMetadataFromNangoConnection(connection)
    };
    await upsertWorkspaceOAuthConnection({
      businessId: parsed.businessId,
      providerConfigKey: parsed.providerConfigKey,
      connectionId: parsed.connectionId,
      metadata: mergedMetadata
    });

    // Nango's end_user is whoever was logged into OUR dashboard — not the
    // account picked on the provider's consent screen. Ask the provider for
    // the real account identity so two connections on the same integration
    // are distinguishable. Best-effort AFTER the row exists (the proxy
    // verifies the link against the stored row); a failed probe just leaves
    // the provider-name fallback label.
    const identity = await fetchProviderAccountIdentity(parsed.businessId, {
      connectionId: parsed.connectionId,
      providerConfigKey: parsed.providerConfigKey
    });
    const identityMetadata = providerAccountMetadata(identity);
    if (Object.keys(identityMetadata).length > 0) {
      // Re-read the row: the probe was a network round-trip, and app-owned
      // keys (e.g. the shared-calendar id) may have been written concurrently
      // — merge onto the FRESH metadata, not the pre-probe snapshot.
      const current = await getWorkspaceOAuthConnectionByNangoIds(
        parsed.businessId,
        parsed.providerConfigKey,
        parsed.connectionId
      );
      const base = { ...(current?.metadata ?? mergedMetadata) };
      // A reconnect can be a DIFFERENT account: a resolved identity replaces
      // the provider_account_* pair wholesale, so a partial probe (e.g. Graph
      // display name without mail) can't leave the previous grant's email.
      delete base.provider_account_email;
      delete base.provider_account_display_name;
      await upsertWorkspaceOAuthConnection({
        businessId: parsed.businessId,
        providerConfigKey: parsed.providerConfigKey,
        connectionId: parsed.connectionId,
        metadata: { ...base, ...identityMetadata }
      });

      // Push the real account onto NANGO's record too, so its dashboard's
      // "Customer" column shows the connected mailbox instead of whichever
      // dashboard login started the session. Cosmetic on Nango's side —
      // never fail the connect over it.
      const patch = nangoIdentityPatchBody(parsed.businessId, identity);
      if (patch) {
        try {
          await nango.patchConnection(
            {
              connectionId: parsed.connectionId,
              provider_config_key: parsed.providerConfigKey
            },
            patch
          );
        } catch (patchErr) {
          console.error(
            "nango/complete: identity tag push failed (non-fatal)",
            patchErr instanceof Error ? patchErr.message : patchErr
          );
        }
      }
    }

    return successResponse({ connected: true });
  } catch (err) {
    return handleRouteError(err);
  }
}
