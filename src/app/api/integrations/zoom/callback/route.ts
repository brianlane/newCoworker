/**
 * Zoom OAuth callback (first-party flow). Zoom redirects the owner's browser
 * here with ?code & ?state after consent; this route verifies the signed
 * state, exchanges the code for the token pair, captures the connected
 * account's identity (users/me), stores everything encrypted, and lands the
 * owner back on /dashboard/integrations.
 *
 * Auth is TWO-factor by design: the signed state proves the flow started
 * from our connect route for this business, AND the browser session must
 * hold manage_settings on that business — a leaked callback URL alone can't
 * attach a Zoom account to someone else's workspace.
 */
import { NextResponse } from "next/server";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { upsertZoomConnection } from "@/lib/db/zoom-connections";
import {
  exchangeZoomAuthCode,
  fetchZoomUserProfile,
  verifyZoomOAuthState,
  ZoomOAuthError
} from "@/lib/zoom/oauth";
import { logger } from "@/lib/logger";

function dashboardRedirect(request: Request, params: Record<string, string>) {
  const url = new URL("/dashboard/integrations", request.url);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return NextResponse.redirect(url);
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  if (!code || !state) {
    // Owner declined on Zoom's consent screen (or Zoom reported an error).
    return dashboardRedirect(request, { error: "Zoom connection was cancelled" });
  }

  const verified = verifyZoomOAuthState(state);
  if (!verified) {
    return dashboardRedirect(request, {
      error: "Zoom connection expired - please try again"
    });
  }

  const user = await getAuthUser();
  if (!user?.email) {
    // Preserve the one-time code + state through sign-in: login pushes the
    // browser back to this exact callback URL, so the exchange still happens
    // (the state carries its own 10-minute expiry).
    const resume = `/api/integrations/zoom/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`;
    return NextResponse.redirect(
      new URL(`/login?redirectTo=${encodeURIComponent(resume)}`, request.url)
    );
  }

  try {
    if (!user.isAdmin) {
      await requireBusinessRole(verified.businessId, "manage_settings");
    }

    const tokens = await exchangeZoomAuthCode(code);
    // Identity is best-effort labeling: a users/me hiccup must not strand a
    // successfully-issued grant.
    let profile = null;
    try {
      profile = await fetchZoomUserProfile(tokens.accessToken);
    } catch (err) {
      logger.warn("zoom users/me failed after connect; storing unlabeled", {
        businessId: verified.businessId,
        error: (err as Error).message
      });
    }

    await upsertZoomConnection({
      businessId: verified.businessId,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
      zoomUserId: profile?.zoomUserId ?? null,
      accountEmail: profile?.email ?? null,
      accountName: profile?.displayName ?? null
    });

    return dashboardRedirect(request, { workspace: "connected" });
  } catch (err) {
    if (err instanceof ZoomOAuthError) {
      logger.warn("zoom oauth callback failed", {
        businessId: verified.businessId,
        code: err.code,
        error: err.message
      });
      return dashboardRedirect(request, {
        error:
          err.code === "invalid_grant"
            ? "Zoom rejected the authorization - please try connecting again"
            : "Zoom connection failed - please try again"
      });
    }
    logger.error("zoom oauth callback error", { error: (err as Error).message });
    return dashboardRedirect(request, { error: "Zoom connection failed" });
  }
}
