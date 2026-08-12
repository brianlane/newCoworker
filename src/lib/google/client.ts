/**
 * Google access-token manager for direct (first-party OAuth) connection rows.
 *
 * `getGoogleAccessToken` returns a live token for one connection, refreshing
 * when under a minute of validity remains. It is the `getAccessToken` the
 * direct arm of `src/lib/workspace/proxy.ts` calls, so every Gmail and Calendar
 * request for a migrated row comes through here.
 *
 * ## Deliberately simpler than the Microsoft and Zoom managers
 *
 * Google does NOT rotate refresh tokens. The stored one keeps working, and two
 * concurrent refreshes yield two independently valid access tokens. That removes
 * the hazard the other two managers are built around, so this module omits their
 * optimistic-concurrency fence on `updated_at`.
 *
 * Do not add one back by analogy. In `src/lib/microsoft/client.ts` the fence
 * exists because a losing refresher would otherwise persist a refresh token that
 * upstream has already killed, stranding the connection. Here there is no lost
 * update to lose: last-write-wins on the access token is correct, and the
 * refresh token is never written at all (see
 * `updateWorkspaceConnectionAccessToken`).
 *
 * The in-process single-flight map IS kept, for a smaller reason: it stops one
 * instance making N identical token calls when N pollers wake together. It is
 * keyed by CONNECTION ROW ID rather than by business, because a business can
 * hold several Google accounts and keying by business would make two mailboxes
 * share one another's token.
 *
 * ## invalid_grant is the only code that may deactivate
 *
 * All three live Google accounts are consumer Gmail, so revocation is ordinary
 * rather than exceptional: a consumer password change revokes the grant, and a
 * refresh token dies after roughly six months unused. When Google says
 * `invalid_grant` the grant is genuinely gone and the row is soft-disabled so
 * the dashboard can show "Reconnect".
 *
 * `invalid_client` must never reach that path. It means OUR credentials are
 * wrong, which is exactly what a botched client-secret rotation looks like, and
 * treating it as a dead grant would soft-disable every tenant at once while
 * their grants were perfectly healthy. `src/lib/google/oauth.ts` classifies it
 * as `request_failed` for that reason, and this module only inspects
 * `invalid_grant`.
 */
import { logger } from "@/lib/logger";
import {
  getWorkspaceConnectionSecrets,
  setWorkspaceConnectionActive,
  updateWorkspaceConnectionAccessToken,
  type WorkspaceConnectionSecrets
} from "@/lib/db/workspace-oauth-connections";
import { GoogleOAuthError, refreshGoogleTokens } from "@/lib/google/oauth";

/** Refresh when less than this much validity remains. */
export const GOOGLE_TOKEN_REFRESH_MARGIN_MS = 60_000;

/**
 * In-flight refreshes keyed by connection row id, so pollers waking together
 * make one token call instead of N.
 */
const inflightRefreshes = new Map<string, Promise<string | null>>();

/** Test-only: reset the single-flight table between cases. */
export function resetGoogleRefreshStateForTests(): void {
  inflightRefreshes.clear();
}

async function refreshAndPersist(row: WorkspaceConnectionSecrets): Promise<string | null> {
  let tokens;
  try {
    tokens = await refreshGoogleTokens(row.refreshToken);
  } catch (err) {
    if (err instanceof GoogleOAuthError && err.code === "invalid_grant") {
      logger.warn("google refresh token rejected; deactivating connection", {
        connectionId: row.id
      });
      await setWorkspaceConnectionActive(row.id, false);
      return null;
    }
    // Transient (timeout, 5xx) or our own misconfiguration (invalid_client).
    // Propagate: the caller degrades this request, and the connection stays
    // enabled so it recovers on its own once the cause is fixed.
    throw err;
  }

  // Persist before handing the token out, so a second caller a moment later
  // reads the fresh one instead of refreshing again. A failed write is not
  // fatal here: unlike a rotating provider, the token we hold is still valid, so
  // return it and let the next call retry the write.
  const stored = await updateWorkspaceConnectionAccessToken(row.id, {
    accessToken: tokens.accessToken,
    expiresAt: tokens.expiresAt,
    scope: tokens.grantedScope
  });
  if (!stored) {
    logger.warn("google access token refreshed but not persisted; row may be gone", {
      connectionId: row.id
    });
  }
  return tokens.accessToken;
}

/**
 * A live Google access token for one direct connection, or null when there is
 * no usable connection: the row is missing, is a Nango row, is soft-disabled,
 * carries no stored pair, or its refresh grant was rejected. Transient refresh
 * failures throw.
 *
 * Null is the "not connected" signal the proxy turns into `email_not_connected`,
 * which is why a dead grant returns it rather than raising.
 */
export async function getGoogleAccessToken(
  connectionRowId: string,
  now = Date.now()
): Promise<string | null> {
  const row = await getWorkspaceConnectionSecrets(connectionRowId);
  if (!row || !row.isActive) return null;

  const expiresAt = new Date(row.tokenExpiresAt).getTime();
  if (Number.isFinite(expiresAt) && expiresAt - now > GOOGLE_TOKEN_REFRESH_MARGIN_MS) {
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
