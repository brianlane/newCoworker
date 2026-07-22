import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import {
  deleteWorkspaceOAuthConnection,
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
import {
  resolveWorkspaceConnectionCapState,
  settleWorkspaceConnectionInsert,
  workspaceConnectionCapMessage
} from "@/lib/nango/connection-cap";
import { consolidateReconnectedWorkspaceConnection } from "@/lib/nango/connection-continuity";
import { maybeSendNangoQuotaAlert } from "@/lib/nango/account-usage";
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

    // Defensive tier-cap re-check for NEW connections only (the session
    // route is the primary gate, but a Connect UI opened before the cap was
    // reached could complete after it). Re-completing an EXISTING row must
    // stay allowed — that's the reconnect path. The OAuth grant already
    // created the connection on Nango's side, so a refusal deletes it there
    // too or it would silently burn account-wide quota.
    if (!existing) {
      const capState = await resolveWorkspaceConnectionCapState(parsed.businessId);
      if (capState.atCap) {
        try {
          await nango.deleteConnection(parsed.providerConfigKey, parsed.connectionId);
        } catch (delErr) {
          console.error(
            "nango/complete: over-cap connection delete failed (leaks account quota)",
            delErr instanceof Error ? delErr.message : delErr
          );
        }
        return errorResponse("FORBIDDEN", workspaceConnectionCapMessage(capState), 403);
      }
    }

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

    // Post-insert settle: the pre-insert cap check is a read followed by an
    // upsert with no transaction, so PARALLEL connects can all pass it. Now
    // that the row exists, re-read in deterministic order — if this row
    // landed past the cap, evict it (row + Nango side) and refuse. Seats
    // belong to the earliest rows, so racers can never end above the cap.
    if (!existing) {
      const settlement = await settleWorkspaceConnectionInsert(parsed.businessId, {
        providerConfigKey: parsed.providerConfigKey,
        connectionId: parsed.connectionId
      });
      if (settlement.evictRowId) {
        await deleteWorkspaceOAuthConnection(parsed.businessId, settlement.evictRowId);
        try {
          await nango.deleteConnection(parsed.providerConfigKey, parsed.connectionId);
        } catch (delErr) {
          console.error(
            "nango/complete: raced over-cap connection delete failed (leaks account quota)",
            delErr instanceof Error ? delErr.message : delErr
          );
        }
        return errorResponse("FORBIDDEN", workspaceConnectionCapMessage(settlement.state), 403);
      }
    }

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

    // Reconnect continuity: if this NEW connection is the same provider
    // account an OLDER row already represents, keep the old row's id (the id
    // AiFlow mailbox bindings and email triggers reference) and re-point it
    // at this fresh grant — deleting the duplicate row and the superseded
    // Nango connection. Best-effort: a failure leaves two working rows, the
    // pre-continuity behavior.
    if (!existing && identity.email) {
      try {
        const consolidation = await consolidateReconnectedWorkspaceConnection({
          businessId: parsed.businessId,
          providerConfigKey: parsed.providerConfigKey,
          newConnectionId: parsed.connectionId,
          accountEmail: identity.email,
          deleteNangoConnection: (pck, connId) => nango.deleteConnection(pck, connId)
        });
        if (consolidation.consolidated) {
          console.log(
            `nango/complete: reconnect consolidated onto row ${consolidation.keptRowId} (superseded ${consolidation.supersededNangoConnectionId})`
          );
        }
      } catch (contErr) {
        console.error(
          "nango/complete: reconnect consolidation failed (two rows remain)",
          contErr instanceof Error ? contErr.message : contErr
        );
      }
    }

    // A NEW connection consumed account-wide Nango quota — check platform
    // headroom and alert ops when it's nearly gone (deduped, best-effort).
    if (!existing) {
      await maybeSendNangoQuotaAlert();
    }

    return successResponse({ connected: true });
  } catch (err) {
    return handleRouteError(err);
  }
}
