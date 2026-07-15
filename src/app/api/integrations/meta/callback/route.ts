/**
 * GET /api/integrations/meta/callback — Facebook Login redirect target.
 *
 * Validates the HMAC-signed `state` (binds the code to a business and a
 * 15-minute window), exchanges the code for a long-lived user token, and
 * stores a `pending` meta_connection. The owner finishes on
 * /dashboard/integrations, where the Meta card lists their Pages for the
 * final pick (which activates the connection and subscribes leadgen).
 *
 * Always redirects back to the integrations page — errors land as a
 * `?error=` banner, never a JSON 500, because this URL is user-facing.
 */
import { NextResponse, type NextRequest } from "next/server";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import {
  exchangeCodeForToken,
  exchangeForLongLivedToken,
  getUserName,
  metaCallbackUrl,
  unsubscribePage,
  verifyMetaOAuthState
} from "@/lib/meta/client";
import {
  getMetaConnection,
  savePendingMetaConnection
} from "@/lib/db/meta-connections";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

function dashboardRedirect(request: NextRequest, params: Record<string, string>) {
  const url = new URL("/dashboard/integrations", request.nextUrl.origin);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return NextResponse.redirect(url);
}

export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams;

  // The user clicked "Cancel" on the Facebook dialog.
  if (q.get("error")) {
    return dashboardRedirect(request, {
      error: q.get("error_description") ?? "Facebook connection was cancelled"
    });
  }

  const code = q.get("code");
  const state = q.get("state");
  if (!code || !state) {
    return dashboardRedirect(request, { error: "Missing Facebook login response" });
  }

  const businessId = verifyMetaOAuthState(state);
  if (!businessId) {
    return dashboardRedirect(request, {
      error: "Facebook login session expired - please try connecting again"
    });
  }

  try {
    // Same session gate as the connect route: the signed state alone stops
    // cross-business forgery, but the browser completing the dance must
    // also hold a session allowed to manage this business.
    const user = await getAuthUser();
    if (!user?.email) {
      return dashboardRedirect(request, { error: "Sign in and try connecting again" });
    }
    if (!user.isAdmin) {
      await requireBusinessRole(businessId, "manage_settings");
    }

    const shortLived = await exchangeCodeForToken(
      code,
      metaCallbackUrl(request.nextUrl.origin)
    );
    const longLived = await exchangeForLongLivedToken(shortLived);
    const accountName = await getUserName(longLived).catch(() => null);

    // A reconnect resets an ACTIVE connection back to pending, which clears
    // its Page — unsubscribe that Page first (best-effort, like DELETE) so
    // Meta stops delivering leadgen events nobody will route, and the Page
    // is genuinely released before another pick.
    const existing = await getMetaConnection(businessId);
    if (existing?.page_id && existing.pageToken) {
      await unsubscribePage(existing.page_id, existing.pageToken);
    }

    await savePendingMetaConnection({ businessId, userToken: longLived, accountName });

    return dashboardRedirect(request, { meta: "connected" });
  } catch (err) {
    logger.warn("meta oauth callback failed", {
      businessId,
      error: err instanceof Error ? err.message : String(err)
    });
    return dashboardRedirect(request, {
      error: "Could not complete the Facebook connection - please try again"
    });
  }
}
