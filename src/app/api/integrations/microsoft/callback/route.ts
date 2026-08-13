/**
 * Microsoft OAuth callback (first-party flow). Microsoft redirects the owner's
 * browser here with ?code & ?state after consent; this route verifies the
 * signed state, exchanges the code, asks Graph WHICH mailbox was actually
 * connected, and then either updates an existing row in place or inserts a new
 * one.
 *
 * Auth is TWO-factor by design, matching the Zoom callback: the signed state
 * proves the flow started from our connect route for this business, AND the
 * browser session must hold manage_settings on that business. A leaked
 * callback URL alone cannot attach a mailbox to someone else's workspace.
 *
 * PROBE BEFORE WRITE. The /v1.0/me call happens before any DB write, which is
 * what lets this route skip the TENTATIVE-ROW dance the Nango complete route
 * performs (inserting first, then consolidating, with
 * over-cap-awaiting-consolidation bookkeeping). That complexity exists only
 * because Nango's identity probe needs the row to already exist. We own the
 * whole flow, so by the time anything is written we already know whether this
 * is a reconnect (no new seat) or a genuinely new mailbox.
 *
 * It does NOT skip `settleWorkspaceConnectionInsert`. Knowing the account up
 * front removes the consolidation bookkeeping, but not the insert race: the
 * cap check reads a count and inserts without a transaction, so two parallel
 * callbacks can both pass it. The settlement after the insert is what keeps a
 * tenant from ending up above their cap.
 *
 * RECONNECT IS CROSS-TRANSPORT, and that is the point. An owner whose Outlook
 * is still on Nango who connects here gets their EXISTING row flipped to
 * `direct` in place, same row id. Every AiFlow mailbox binding, email trigger,
 * and shared-calendar id survives, and each reconnect quietly migrates one
 * more tenant off Nango.
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
  exchangeMicrosoftAuthCode,
  fetchMicrosoftIdentity,
  MicrosoftOAuthError,
  verifyMicrosoftOAuthState
} from "@/lib/microsoft/oauth";
import {
  findDuplicateRow,
  findReconnectTarget,
  resolveUnlabeledReconnect,
  OUTLOOK_KEY,
  OUTLOOK_KEYS
} from "@/lib/workspace/reconnect";
import { fetchProviderAccountIdentity } from "@/lib/nango/account-identity";
import { logger } from "@/lib/logger";
import { randomUUID } from "crypto";

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
  const adminConsent = url.searchParams.get("admin_consent");

  // The admin-consent leg returns here with admin_consent=True and NO code.
  // That is a SUCCESS (an admin just granted the tenant), not a cancellation:
  // send the owner back through the normal authorize leg to actually get a
  // grant of their own.
  if (!code && adminConsent) {
    const verified = state ? verifyMicrosoftOAuthState(state) : null;
    if (verified) {
      return NextResponse.redirect(
        new URL(
          `/api/integrations/microsoft/connect?businessId=${encodeURIComponent(verified.businessId)}`,
          request.url
        )
      );
    }
    return dashboardRedirect(request, {
      error: "Admin consent granted. Please connect Outlook again."
    });
  }

  if (oauthError) {
    // A tenant that disables user consent bounces here with AADSTS65001 /
    // AADSTS90094 in the description. Say what to do about it, rather than
    // reporting a generic failure the owner cannot act on.
    const description = url.searchParams.get("error_description") ?? "";
    const needsAdmin =
      oauthError === "consent_required" ||
      oauthError === "interaction_required" ||
      /AADSTS65001|AADSTS90094/.test(description);
    return dashboardRedirect(request, {
      error: needsAdmin
        ? "Your Microsoft administrator must approve New Coworker before you can connect Outlook."
        : "Outlook connection was cancelled"
    });
  }

  if (!code || !state) {
    return dashboardRedirect(request, { error: "Outlook connection was cancelled" });
  }

  const verified = verifyMicrosoftOAuthState(state);
  if (!verified) {
    return dashboardRedirect(request, {
      error: "Outlook connection expired, please try again"
    });
  }

  const user = await getAuthUser();
  if (!user?.email) {
    // Preserve the one-time code + state through sign-in: login pushes the
    // browser back to this exact callback URL, so the exchange still happens
    // (the state carries its own 10-minute expiry).
    const resume = `/api/integrations/microsoft/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`;
    return NextResponse.redirect(
      new URL(`/login?redirectTo=${encodeURIComponent(resume)}`, request.url)
    );
  }

  try {
    if (!user.isAdmin) {
      await requireBusinessRole(verified.businessId, "manage_settings");
    }

    const tokens = await exchangeMicrosoftAuthCode(code);

    // Who did they actually connect? Not necessarily their dashboard login.
    // Unlike Zoom, this is NOT best-effort labeling: the reconnect match is
    // keyed on it, so without an identity we cannot tell a reconnect from a
    // second mailbox, and guessing wrong either strands a flow or burns a seat.
    const identity = await fetchMicrosoftIdentity(tokens.accessToken, tokens.idTokenEmail);
    if (!identity?.email) {
      return dashboardRedirect(request, {
        error: "Could not read the Outlook account, please try again"
      });
    }
    const accountEmail = identity.email.toLowerCase();

    const capState = await resolveWorkspaceConnectionCapState(verified.businessId);
    let decision = findReconnectTarget(
      await listWorkspaceOAuthConnections(verified.businessId),
      accountEmail,
      capState.max,
      OUTLOOK_KEYS,
      identity.accountId
    );

    if (decision.kind === "verify") {
      // An unlabeled row with room for more than one mailbox: whether this is a
      // reconnect or a genuine second mailbox is unknowable from the row, so
      // ask the row's own grant who it belongs to rather than guessing. A
      // failed probe resolves to "new" (see resolveUnlabeledReconnect): a
      // duplicate is recoverable, re-pointing a live flow at a different
      // mailbox is not.
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
        logger.warn("microsoft reconnect: identity probe on the unlabeled row failed", {
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
      connected_via: "microsoft_oauth",
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
        tokens
      });
      logger.info("microsoft connection reconnected", {
        businessId: verified.businessId,
        connectionRowId: existing.id,
        fromTransport: existing.transport,
        // An unlabeled adoption is a judgement call, so leave a trail.
        matchedBy
      });
    } else {
      // A genuinely new mailbox does consume a seat. Re-check here rather than
      // trusting the pre-consent check: the tenant may have connected something
      // else in another tab while this owner sat on the consent screen.
      await assertWorkspaceConnectionAllowed(verified.businessId);

      const connectionId = `direct:${randomUUID()}`;
      const inserted = await insertDirectWorkspaceConnection({
        businessId: verified.businessId,
        providerConfigKey: OUTLOOK_KEY,
        connectionId,
        metadata,
        tokens
      });

      // The identity probe runs BEFORE the insert, so two callbacks for the
      // same mailbox can both find no existing row and both insert. Left alone
      // that is duplicate rows for one account, with bindings split across them
      // and an ambiguous resolver. The row that lost the race backs itself out
      // and the older one is flipped instead, so the account still ends on one
      // row and that row is the one flows have had longest to bind to.
      const duplicateOf = findDuplicateRow(
        await listWorkspaceOAuthConnections(verified.businessId),
        inserted.id,
        accountEmail,
        OUTLOOK_KEYS
      );
      if (duplicateOf) {
        await deleteWorkspaceOAuthConnection(verified.businessId, inserted.id);
        await flipWorkspaceConnectionToDirect({
          id: duplicateOf.id,
          businessId: verified.businessId,
          connectionId: `direct:${randomUUID()}`,
          metadata: { ...duplicateOf.metadata, ...metadata },
          tokens
        });
        logger.info("microsoft connect consolidated onto an older row for the same account", {
          businessId: verified.businessId,
          keptRowId: duplicateOf.id,
          discardedRowId: inserted.id
        });
        return dashboardRedirect(request, { workspace: "connected" });
      }

      // The cap check above reads a count and inserts without a transaction, so
      // two parallel callbacks can BOTH pass it. Settle after the insert,
      // exactly as the Nango complete route does: re-read in deterministic
      // order and evict our own row if it landed past the cap. Seats belong to
      // the earliest rows, so racers can never end above the cap.
      const settlement = await settleWorkspaceConnectionInsert(verified.businessId, {
        providerConfigKey: OUTLOOK_KEY,
        connectionId
      });
      if (settlement.evictRowId) {
        await deleteWorkspaceOAuthConnection(verified.businessId, settlement.evictRowId);
        logger.warn("microsoft connect lost a cap race; evicted the new row", {
          businessId: verified.businessId,
          connectionRowId: inserted.id
        });
        // Nothing to revoke on Microsoft's side: there is no scoped revoke
        // endpoint, and deleting the row already destroyed the ciphertext.
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
    if (err instanceof MicrosoftOAuthError) {
      logger.warn("microsoft oauth callback failed", {
        businessId: verified.businessId,
        code: err.code,
        error: err.message
      });
      return dashboardRedirect(request, {
        error:
          err.code === "invalid_grant"
            ? "Microsoft rejected the authorization, please try connecting again"
            : err.code === "consent_required"
              ? "Your Microsoft administrator must approve New Coworker before you can connect Outlook."
              : "Outlook connection failed, please try again"
      });
    }
    logger.error("microsoft oauth callback error", { error: (err as Error).message });
    return dashboardRedirect(request, { error: "Outlook connection failed" });
  }
}
