/**
 * Reconnect continuity for workspace OAuth connections.
 *
 * A reconnect mints a NEW Nango connection id, which used to insert a NEW
 * `workspace_oauth_connections` row — churning the row id that AiFlow
 * mailbox bindings reference (send_email `fromConnectionId`, quiet-hours
 * email fallback, email triggers, `email_extract`). Every flow pointing at
 * the mailbox then failed at send time with `connection_not_found` — the
 * KYP Ads Jul 22 2026 incident class.
 *
 * After the account-identity probe resolves a newly completed connection's
 * provider account email, this consolidation checks whether an OLDER row on
 * the same provider already represents the same account. If so, the older
 * row — whose id the flows bind — is KEPT and re-pointed at the fresh Nango
 * connection; the freshly inserted duplicate row is deleted, and the
 * superseded Nango-side connection is deleted best-effort (freeing a seat
 * on the account-wide Nango connection quota).
 */

import {
  deleteWorkspaceOAuthConnection,
  getWorkspaceOAuthConnectionByNangoIds,
  listWorkspaceOAuthConnections,
  updateWorkspaceOAuthConnectionLink
} from "@/lib/db/workspace-oauth-connections";

export type ConsolidateReconnectDeps = {
  /** Injectable db accessors (tests). */
  fetchConnections?: typeof listWorkspaceOAuthConnections;
  fetchByNangoIds?: typeof getWorkspaceOAuthConnectionByNangoIds;
  removeRow?: typeof deleteWorkspaceOAuthConnection;
  updateLink?: typeof updateWorkspaceOAuthConnectionLink;
};

export type ConsolidateReconnectResult =
  | { consolidated: false }
  | { consolidated: true; keptRowId: string; supersededNangoConnectionId: string };

/**
 * Consolidate a just-completed connection onto the OLDEST existing row that
 * represents the same provider account (same provider config key + same
 * provider account email, case-insensitive). No-op when the account is new
 * to the business or the identity probe resolved nothing.
 *
 * Ordering: the duplicate row is deleted BEFORE the keeper is re-pointed
 * (the unique index on business/provider/nango-id forbids the other order).
 * A crash between the two leaves the keeper on the superseded grant — the
 * owner recovers by simply reconnecting again; nothing is lost.
 */
export async function consolidateReconnectedWorkspaceConnection(
  args: {
    businessId: string;
    providerConfigKey: string;
    /** The just-completed (new) Nango connection id. */
    newConnectionId: string;
    /** Provider account email the identity probe resolved. */
    accountEmail: string;
    /** Best-effort Nango-side delete for the superseded grant. */
    deleteNangoConnection: (providerConfigKey: string, connectionId: string) => Promise<unknown>;
  },
  deps: ConsolidateReconnectDeps = {}
): Promise<ConsolidateReconnectResult> {
  /* c8 ignore start -- production defaults; tests inject */
  const fetchConnections = deps.fetchConnections ?? listWorkspaceOAuthConnections;
  const fetchByNangoIds = deps.fetchByNangoIds ?? getWorkspaceOAuthConnectionByNangoIds;
  const removeRow = deps.removeRow ?? deleteWorkspaceOAuthConnection;
  const updateLink = deps.updateLink ?? updateWorkspaceOAuthConnectionLink;
  /* c8 ignore stop */

  const wanted = args.accountEmail.trim().toLowerCase();
  if (!wanted) return { consolidated: false };

  const rows = await fetchConnections(args.businessId);
  const siblings = rows.filter((row) => {
    if (row.provider_config_key !== args.providerConfigKey) return false;
    if (row.connection_id === args.newConnectionId) return false;
    const email = row.metadata?.provider_account_email;
    return typeof email === "string" && email.trim().toLowerCase() === wanted;
  });
  if (siblings.length === 0) return { consolidated: false };

  // listWorkspaceOAuthConnections orders created_at ASC — the FIRST sibling
  // is the oldest row, i.e. the id existing flow bindings point at.
  const keeper = siblings[0];

  const newRow = await fetchByNangoIds(
    args.businessId,
    args.providerConfigKey,
    args.newConnectionId
  );
  // Raced away (parallel completes / cap eviction) — nothing to consolidate.
  if (!newRow) return { consolidated: false };

  // Keeper's app-owned metadata keys survive; the fresh row's identity and
  // Nango-derived labels win.
  const metadata = { ...keeper.metadata, ...newRow.metadata };

  await removeRow(args.businessId, newRow.id);
  const superseded = keeper.connection_id;
  await updateLink({
    businessId: args.businessId,
    id: keeper.id,
    connectionId: args.newConnectionId,
    metadata
  });

  // The old grant is dead weight on Nango's account-wide connection quota —
  // delete it best-effort (it may already be gone on the provider side).
  try {
    await args.deleteNangoConnection(args.providerConfigKey, superseded);
  } catch (err) {
    console.error(
      "connection continuity: superseded Nango connection delete failed (leaks quota)",
      err instanceof Error ? err.message : err
    );
  }

  return { consolidated: true, keptRowId: keeper.id, supersededNangoConnectionId: superseded };
}
