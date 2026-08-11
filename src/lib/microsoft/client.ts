/**
 * Microsoft Graph access-token manager for direct (first-party OAuth) rows.
 *
 * `getMicrosoftAccessToken` returns a live token for one connection,
 * refreshing when under a minute of validity remains. Microsoft ROTATES
 * refresh tokens, so the new pair is persisted BEFORE the access token is
 * handed out: two callers racing a rotation would otherwise strand the
 * connection on a refresh token that is already dead upstream.
 *
 * Two layers of race protection, both lifted from src/lib/zoom/client.ts:
 *
 *   - an in-process single-flight map, so concurrent callers in one instance
 *     share a single rotation. It is keyed by CONNECTION ROW ID, not by
 *     business: unlike Zoom (one connection per business), a business can hold
 *     several Microsoft mailboxes, and keying by business would make two
 *     mailboxes refreshing at once share one another's result.
 *   - an optimistic-concurrency fence on `updated_at` for cross-instance
 *     races, which the in-process map cannot see. A losing refresher re-reads
 *     and adopts the winner's rotation instead of clobbering it or
 *     deactivating a healthy connection.
 */
import { logger } from "@/lib/logger";
import {
  getWorkspaceConnectionSecrets,
  setWorkspaceConnectionActive,
  updateWorkspaceConnectionTokens,
  type WorkspaceConnectionSecrets
} from "@/lib/db/workspace-oauth-connections";
import { MicrosoftOAuthError, refreshMicrosoftTokens } from "@/lib/microsoft/oauth";

/** Refresh when less than this much validity remains. */
export const MICROSOFT_TOKEN_REFRESH_MARGIN_MS = 60_000;

/**
 * In-flight refreshes keyed by connection row id, so concurrent callers await
 * the same rotation instead of burning the rotated refresh token twice.
 */
const inflightRefreshes = new Map<string, Promise<string | null>>();

/** Test-only: reset the single-flight table between cases. */
export function resetMicrosoftRefreshStateForTests(): void {
  inflightRefreshes.clear();
}

async function refreshAndPersist(row: WorkspaceConnectionSecrets): Promise<string | null> {
  let tokens;
  try {
    tokens = await refreshMicrosoftTokens(row.refreshToken);
  } catch (err) {
    if (err instanceof MicrosoftOAuthError && err.code === "invalid_grant") {
      // Microsoft rejected the grant itself: the owner revoked access, changed
      // their password, an admin revoked it, or ANOTHER INSTANCE already
      // rotated this token (the in-process map cannot see other servers).
      // Re-read before concluding: if the row rotated since we read it, use the
      // newer pair rather than deactivating a healthy connection.
      const latest = await getWorkspaceConnectionSecrets(row.id);
      if (latest && latest.isActive && latest.updatedAt !== row.updatedAt) {
        return latest.accessToken;
      }
      logger.warn("microsoft refresh token rejected; deactivating connection", {
        connectionId: row.id
      });
      await setWorkspaceConnectionActive(row.id, false);
      return null;
    }
    throw err;
  }

  // Persist the rotated pair BEFORE handing the access token out: the old
  // refresh token is already dead on Microsoft's side. The updated_at fence
  // keeps a slower concurrent refresher from clobbering a newer rotation.
  const stored = await updateWorkspaceConnectionTokens(row.id, tokens, row.updatedAt);
  if (!stored) {
    const latest = await getWorkspaceConnectionSecrets(row.id);
    if (latest && latest.isActive) return latest.accessToken;
  }
  return tokens.accessToken;
}

/**
 * A live Graph access token for one direct connection, or null when there is
 * no usable connection (not a direct row, soft-disabled, no stored pair, or
 * the refresh grant was rejected). Transient refresh failures throw.
 */
export async function getMicrosoftAccessToken(
  connectionRowId: string,
  now = Date.now()
): Promise<string | null> {
  const row = await getWorkspaceConnectionSecrets(connectionRowId);
  if (!row || !row.isActive) return null;

  const expiresAt = new Date(row.tokenExpiresAt).getTime();
  if (Number.isFinite(expiresAt) && expiresAt - now > MICROSOFT_TOKEN_REFRESH_MARGIN_MS) {
    return row.accessToken;
  }

  const existing = inflightRefreshes.get(connectionRowId);
  if (existing) return existing;

  const refresh = refreshAndPersist(row).finally(() => {
    inflightRefreshes.delete(connectionRowId);
  });
  inflightRefreshes.set(connectionRowId, refresh);
  return refresh;
}
