/**
 * Google OAuth callback (first-party workspace flow). Google redirects the
 * owner's browser here with ?code & ?state after consent; this route verifies
 * the signed state, exchanges the code, asks Google WHICH account was actually
 * connected, and then either updates an existing row in place or inserts a new
 * one.
 *
 * ## Why this path, and not /api/integrations/google/callback
 *
 * `https://www.newcoworker.com/api/auth/callback/google` is ALREADY a registered
 * redirect URI on the verified OAuth client (confirmed in the Cloud Console on
 * 2026-08-11). It outlived the direct-Google code deleted in Apr 2026. Reusing
 * it means this whole flow ships with NO console change, which matters because
 * authorized domains are derived from the redirect URI list and editing that
 * list is a consent-screen change requiring fresh verification.
 *
 * It sits alongside `/api/auth/callback`, the Supabase Auth callback for "Log in
 * with Google". Distinct routes, same client, different purpose: that one signs
 * a person in, this one attaches a mailbox to a business.
 *
 * Auth is TWO-factor by design, matching the Microsoft and Zoom callbacks: the
 * signed state proves the flow started from our connect route for this business,
 * AND the browser session must hold manage_settings on that business. A leaked
 * callback URL alone cannot attach a mailbox to someone else's workspace.
 *
 * PROBE BEFORE WRITE, as in the Microsoft callback: the userinfo call happens
 * before any DB write, so by the time anything is written we already know
 * whether this is a reconnect (no new seat) or a genuinely new account. That is
 * what lets this route skip the tentative-row dance the Nango complete route
 * performs, which exists only because Nango's identity probe needs the row to
 * exist first.
 *
 * RECONNECT IS CROSS-TRANSPORT, and that is the point. An owner whose Gmail is
 * still on Nango who connects here gets their EXISTING row flipped to `direct`
 * in place, same row id. Every AiFlow mailbox binding, email trigger, and
 * shared-calendar id survives, and each reconnect quietly migrates one more
 * tenant off Nango.
 */
import { NextResponse } from "next/server";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import {
  deleteWorkspaceOAuthConnection,
  flipWorkspaceConnectionToDirect,
  insertDirectWorkspaceConnection,
  listWorkspaceOAuthConnections
} from "@/lib/db/workspace-oauth-connections";
import {
  assertWorkspaceConnectionAllowed,
  resolveWorkspaceConnectionCapState,
  settleWorkspaceConnectionInsert,
  workspaceConnectionCapMessage,
  WorkspaceConnectionCapError
} from "@/lib/nango/connection-cap";
import {
  exchangeGoogleAuthCode,
  fetchGoogleIdentity,
  GoogleOAuthError,
  revokeGoogleToken,
  verifyGoogleOAuthState
} from "@/lib/google/oauth";
import {
  findDuplicateRow,
  findReconnectTarget,
  resolveUnlabeledReconnect,
  GOOGLE_KEYS
} from "@/lib/workspace/reconnect";
import { fetchProviderAccountIdentity } from "@/lib/nango/account-identity";
import { logger } from "@/lib/logger";
import { randomUUID } from "crypto";

/**
 * The provider key a first-party Google connection uses.
 *
 * `google` rather than a `google-direct` synthetic key, deliberately. The key is
 * identical across both transports, which is what keeps every resolver, cap,
 * cleanup path and AiFlow mailbox binding transport-blind. Only the row's
 * `transport` column decides who serves the request.
 */
const GOOGLE_KEY = "google";

/**
 * Adapt a Google token set to the storage shape.
 *
 * Two narrowings, both deliberate rather than casts:
 *
 * `refreshToken` is nullable on `GoogleTokenSet` because a REFRESH returns none.
 * A code exchange always carries one, since `exchangeGoogleAuthCode` throws
 * otherwise, but the type cannot say so, and asserting with `!` would silently
 * write "null" into the column the row's check constraint depends on if that
 * guarantee ever changed. Return null instead and let the caller refuse.
 *
 * `scope` is stored as whatever GOOGLE reported, never as the scope set we
 * requested. Recording the request would claim capabilities the owner may have
 * unticked at the consent screen, and the stored value is the only thing
 * capability gating can honestly consult. An absent scope is therefore recorded
 * as empty rather than backfilled, and logged, because on a code exchange it
 * should not happen.
 */
function toDirectTokens(
  tokens: { accessToken: string; refreshToken: string | null; expiresAt: Date; grantedScope: string | null },
  businessId: string
): { accessToken: string; refreshToken: string; expiresAt: Date; scope: string } | null {
  if (!tokens.refreshToken) return null;
  if (!tokens.grantedScope) {
    logger.warn("google code exchange returned no granted scope", { businessId });
  }
  return {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt,
    scope: tokens.grantedScope ?? ""
  };
}

function dashboardRedirect(request: Request, params: Record<string, string>) {
  const url = new URL("/dashboard/integrations/workspace", request.url);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return NextResponse.redirect(url);
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const oauthError = url.searchParams.get("error");

  if (oauthError) {
    // access_denied is the owner clicking Cancel, or unticking every box.
    return dashboardRedirect(request, {
      error:
        oauthError === "access_denied"
          ? "Google connection was cancelled"
          : "Google connection failed, please try again"
    });
  }

  if (!code || !state) {
    return dashboardRedirect(request, { error: "Google connection was cancelled" });
  }

  const verified = verifyGoogleOAuthState(state);
  if (!verified) {
    return dashboardRedirect(request, {
      error: "Google connection expired, please try again"
    });
  }

  const user = await getAuthUser();
  if (!user?.email) {
    // Preserve the one-time code + state through sign-in: login pushes the
    // browser back to this exact callback URL, so the exchange still happens
    // (the state carries its own 10-minute expiry).
    const resume = `/api/auth/callback/google?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`;
    return NextResponse.redirect(
      new URL(`/login?redirectTo=${encodeURIComponent(resume)}`, request.url)
    );
  }

  try {
    if (!user.isAdmin) {
      await requireBusinessRole(verified.businessId, "manage_settings");
    }

    const tokens = await exchangeGoogleAuthCode(code);

    // Who did they actually connect? Not necessarily their dashboard login. The
    // reconnect match is keyed on it, so without an identity we cannot tell a
    // reconnect from a second account, and guessing wrong either strands a flow
    // or burns a seat.
    const identity = await fetchGoogleIdentity(tokens.accessToken);
    if (!identity?.email) {
      // Nothing has been written yet, so the grant we just took is unusable and
      // unreferenced. Hand it back rather than leaving it live on the owner's
      // account with nothing on our side pointing at it.
      await revokeGoogleToken(tokens.refreshToken ?? tokens.accessToken);
      return dashboardRedirect(request, {
        error: "Could not read the Google account, please try again"
      });
    }
    const accountEmail = identity.email.toLowerCase();

    const directTokens = toDirectTokens(tokens, verified.businessId);
    if (!directTokens) {
      // Unreachable while exchangeGoogleAuthCode enforces it, and kept anyway:
      // storing a row without a refresh token would violate the direct-tokens
      // check constraint, and a connection that cannot refresh dies within the
      // hour with no signal the owner could act on.
      await revokeGoogleToken(tokens.accessToken);
      return dashboardRedirect(request, {
        error: "Google did not return a refresh token, please try connecting again"
      });
    }

    const capState = await resolveWorkspaceConnectionCapState(verified.businessId);
    let decision = findReconnectTarget(
      await listWorkspaceOAuthConnections(verified.businessId),
      accountEmail,
      capState.max,
      GOOGLE_KEYS
    );

    if (decision.kind === "verify") {
      // An unlabeled row with room for more than one account: whether this is a
      // reconnect or a genuine second account is unknowable from the row, so ask
      // the row's own grant who it belongs to rather than guessing. A failed
      // probe resolves to "new" (see resolveUnlabeledReconnect): a duplicate is
      // recoverable, re-pointing a live flow at a different mailbox is not.
      const candidate = decision.row;
      let probed: string | null = null;
      try {
        probed = (
          await fetchProviderAccountIdentity(verified.businessId, {
            connectionId: candidate.connection_id,
            providerConfigKey: candidate.provider_config_key
          })
        ).email;
      } catch (err) {
        logger.warn("google reconnect: identity probe on the unlabeled row failed", {
          businessId: verified.businessId,
          connectionRowId: candidate.id,
          error: (err as Error).message
        });
      }
      decision = resolveUnlabeledReconnect(candidate, probed, accountEmail);
    }

    const existing = decision.kind === "reconnect" ? decision.row : undefined;
    const matchedBy = decision.kind === "reconnect" ? decision.matchedBy : null;

    const metadata: Record<string, unknown> = {
      // App-owned keys (the shared-calendar id and its ACL) must survive a
      // reconnect, so start from what the row already had.
      ...(existing?.metadata ?? {}),
      connected_via: "google_oauth",
      provider_account_email: identity.email,
      ...(identity.displayName ? { provider_account_display_name: identity.displayName } : {}),
      ...(identity.accountId ? { provider_account_id: identity.accountId } : {})
    };

    if (existing) {
      // Reconnect: same row id, so every AiFlow binding survives. No cap check,
      // this consumes no new seat.
      await flipWorkspaceConnectionToDirect({
        id: existing.id,
        businessId: verified.businessId,
        // A direct row's connection_id is synthetic: it exists only to satisfy
        // NOT NULL and the (business, provider, connection) unique key. A fresh
        // value avoids colliding with the Nango id we are replacing.
        connectionId: `direct:${randomUUID()}`,
        metadata,
        tokens: directTokens
      });
      logger.info("google connection reconnected", {
        businessId: verified.businessId,
        connectionRowId: existing.id,
        fromTransport: existing.transport,
        fromProviderKey: existing.provider_config_key,
        // An unlabeled adoption is a judgement call, so leave a trail.
        matchedBy
      });
    } else {
      // A genuinely new account does consume a seat. Re-check here rather than
      // trusting the pre-consent check: the tenant may have connected something
      // else in another tab while this owner sat on the consent screen.
      await assertWorkspaceConnectionAllowed(verified.businessId);

      const connectionId = `direct:${randomUUID()}`;
      const inserted = await insertDirectWorkspaceConnection({
        businessId: verified.businessId,
        providerConfigKey: GOOGLE_KEY,
        connectionId,
        metadata,
        tokens: directTokens
      });

      // The identity probe runs BEFORE the insert, so two callbacks for the same
      // account can both find no existing row and both insert. Left alone that
      // is duplicate rows for one account, with bindings split across them and
      // an ambiguous resolver. The row that lost the race backs itself out and
      // the older one is flipped instead, so the account still ends on one row
      // and that row is the one flows have had longest to bind to.
      const duplicateOf = findDuplicateRow(
        await listWorkspaceOAuthConnections(verified.businessId),
        inserted.id,
        accountEmail,
        GOOGLE_KEYS
      );
      if (duplicateOf) {
        await deleteWorkspaceOAuthConnection(verified.businessId, inserted.id);
        await flipWorkspaceConnectionToDirect({
          id: duplicateOf.id,
          businessId: verified.businessId,
          connectionId: `direct:${randomUUID()}`,
          metadata: { ...duplicateOf.metadata, ...metadata },
          tokens: directTokens
        });
        logger.info("google connect consolidated onto an older row for the same account", {
          businessId: verified.businessId,
          keptRowId: duplicateOf.id,
          discardedRowId: inserted.id
        });
        return dashboardRedirect(request, { workspace: "connected" });
      }

      // The cap check above reads a count and inserts without a transaction, so
      // two parallel callbacks can BOTH pass it. Settle after the insert,
      // exactly as the Nango complete route does: re-read in deterministic order
      // and evict our own row if it landed past the cap. Seats belong to the
      // earliest rows, so racers can never end above the cap.
      const settlement = await settleWorkspaceConnectionInsert(verified.businessId, {
        providerConfigKey: GOOGLE_KEY,
        connectionId
      });
      if (settlement.evictRowId) {
        await deleteWorkspaceOAuthConnection(verified.businessId, settlement.evictRowId);
        // Unlike Microsoft, Google HAS a revoke endpoint, so an evicted grant is
        // handed back instead of left live on the owner's account pointing at a
        // row we just deleted.
        await revokeGoogleToken(tokens.refreshToken ?? tokens.accessToken);
        logger.warn("google connect lost a cap race; evicted the new row", {
          businessId: verified.businessId,
          connectionRowId: inserted.id
        });
        return dashboardRedirect(request, {
          error: workspaceConnectionCapMessage(settlement.state)
        });
      }
    }

    return dashboardRedirect(request, { workspace: "connected" });
  } catch (err) {
    if (err instanceof WorkspaceConnectionCapError) {
      return dashboardRedirect(request, { error: err.message });
    }
    if (err instanceof GoogleOAuthError) {
      logger.warn("google oauth callback failed", {
        businessId: verified.businessId,
        code: err.code,
        error: err.message
      });
      return dashboardRedirect(request, {
        error:
          err.code === "invalid_grant"
            ? "Google rejected the authorization, please try connecting again"
            : "Google connection failed, please try again"
      });
    }
    logger.error("google oauth callback error", { error: (err as Error).message });
    return dashboardRedirect(request, { error: "Google connection failed" });
  }
}
