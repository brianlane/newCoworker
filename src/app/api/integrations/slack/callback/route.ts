/**
 * Slack OAuth v2 callback. Slack redirects the owner's browser here with
 * ?code & ?state after consent; this route verifies the signed state,
 * exchanges the code at oauth.v2.access, and stores the workspace's bot
 * token encrypted, landing the owner back on /dashboard/integrations/slack.
 *
 * Auth is TWO-factor by design (Zoom callback precedent): the signed state
 * proves the flow started from our connect route for this business, AND the
 * browser session must hold manage_settings on that business, so a leaked
 * callback URL alone can't attach a Slack workspace to someone else's
 * account.
 */
import { NextResponse } from "next/server";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import {
  SlackWorkspaceAlreadyLinkedError,
  upsertSlackConnection
} from "@/lib/db/slack-connections";
import {
  exchangeSlackAuthCode,
  verifySlackOAuthState,
  SlackOAuthError
} from "@/lib/slack/oauth";
import { logger } from "@/lib/logger";

function dashboardRedirect(request: Request, params: Record<string, string>) {
  const url = new URL("/dashboard/integrations/slack", request.url);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return NextResponse.redirect(url);
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  if (!code || !state) {
    // Owner declined on Slack's consent screen (Slack sends ?error=access_denied).
    return dashboardRedirect(request, { error: "Slack connection was cancelled" });
  }

  const verified = verifySlackOAuthState(state);
  if (!verified) {
    return dashboardRedirect(request, {
      error: "Slack connection expired - please try again"
    });
  }

  const user = await getAuthUser();
  if (!user?.email) {
    // Preserve the one-time code + state through sign-in: login pushes the
    // browser back to this exact callback URL, so the exchange still happens
    // (the state carries its own 10-minute expiry).
    const resume = `/api/integrations/slack/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`;
    return NextResponse.redirect(
      new URL(`/login?redirectTo=${encodeURIComponent(resume)}`, request.url)
    );
  }

  try {
    if (!user.isAdmin) {
      await requireBusinessRole(verified.businessId, "manage_settings");
    }

    const install = await exchangeSlackAuthCode(code);

    await upsertSlackConnection({
      businessId: verified.businessId,
      teamId: install.teamId,
      teamName: install.teamName,
      enterpriseId: install.enterpriseId,
      botUserId: install.botUserId,
      appId: install.appId,
      botToken: install.accessToken,
      scopes: install.scopes,
      installedByUserId: user.userId ?? null
    });

    return dashboardRedirect(request, { workspace: "connected" });
  } catch (err) {
    if (err instanceof SlackWorkspaceAlreadyLinkedError) {
      return dashboardRedirect(request, {
        error: "That Slack workspace is already connected to a different business"
      });
    }
    if (err instanceof SlackOAuthError) {
      logger.warn("slack oauth callback failed", {
        businessId: verified.businessId,
        code: err.code,
        error: err.message
      });
      return dashboardRedirect(request, {
        error:
          err.code === "invalid_grant"
            ? "Slack rejected the authorization - please try connecting again"
            : "Slack connection failed - please try again"
      });
    }
    logger.error("slack oauth callback error", { error: (err as Error).message });
    return dashboardRedirect(request, { error: "Slack connection failed" });
  }
}
