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
 * what lets this route skip the whole tentative-row dance the Nango complete
 * route performs (`settleWorkspaceConnectionInsert` and its
 * over-cap-awaiting-consolidation bookkeeping). That complexity exists only
 * because Nango's identity probe needs the row to already exist. We own the
 * whole flow, so by the time anything is written we already know whether this
 * is a reconnect (no new seat) or a genuinely new mailbox.
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
  flipWorkspaceConnectionToDirect,
  insertDirectWorkspaceConnection,
  listWorkspaceOAuthConnections
} from "@/lib/db/workspace-oauth-connections";
import {
  assertWorkspaceConnectionAllowed,
  WorkspaceConnectionCapError
} from "@/lib/nango/connection-cap";
import {
  exchangeMicrosoftAuthCode,
  fetchMicrosoftIdentity,
  MicrosoftOAuthError,
  verifyMicrosoftOAuthState
} from "@/lib/microsoft/oauth";
import { logger } from "@/lib/logger";
import { randomUUID } from "crypto";

/** The Nango provider key an Outlook mailbox uses, on BOTH transports. */
const OUTLOOK_KEY = "outlook";

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
    const identity = await fetchMicrosoftIdentity(tokens.accessToken);
    if (!identity?.email) {
      return dashboardRedirect(request, {
        error: "Could not read the Outlook account, please try again"
      });
    }
    const accountEmail = identity.email.toLowerCase();

    const existing = (await listWorkspaceOAuthConnections(verified.businessId)).find((row) => {
      if (row.provider_config_key !== OUTLOOK_KEY) return false;
      const rowEmail = row.metadata?.provider_account_email;
      return typeof rowEmail === "string" && rowEmail.toLowerCase() === accountEmail;
    });

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
        fromTransport: existing.transport
      });
    } else {
      // A genuinely new mailbox does consume a seat. Re-check here rather than
      // trusting the pre-consent check: the tenant may have connected something
      // else in another tab while this owner sat on the consent screen.
      await assertWorkspaceConnectionAllowed(verified.businessId);
      await insertDirectWorkspaceConnection({
        businessId: verified.businessId,
        providerConfigKey: OUTLOOK_KEY,
        connectionId: `direct:${randomUUID()}`,
        metadata,
        tokens
      });
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
