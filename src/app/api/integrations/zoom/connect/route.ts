/**
 * Starts the first-party Zoom OAuth flow: authorizes the signed-in owner /
 * manager for the business, then 302s the browser to zoom.us/oauth/authorize
 * with an HMAC-signed state binding the round-trip to the business.
 *
 * Browser-navigated (not fetch), so failures land back on the integrations
 * page as a ?error= banner instead of a JSON body.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { buildZoomAuthorizeUrl, createZoomOAuthState, ZoomOAuthError } from "@/lib/zoom/oauth";
import { logger } from "@/lib/logger";

const businessIdSchema = z.string().uuid();

function dashboardRedirect(request: Request, params: Record<string, string>) {
  const url = new URL("/dashboard/integrations/zoom", request.url);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return NextResponse.redirect(url);
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const parsed = businessIdSchema.safeParse(url.searchParams.get("businessId"));
    if (!parsed.success) {
      return dashboardRedirect(request, { error: "A business is required to connect Zoom" });
    }

    const user = await getAuthUser();
    if (!user?.email) {
      return NextResponse.redirect(
        new URL("/login?redirectTo=/dashboard/integrations/zoom", request.url)
      );
    }
    if (!user.isAdmin) {
      await requireBusinessRole(parsed.data, "manage_settings");
    }

    const state = createZoomOAuthState(parsed.data);
    return NextResponse.redirect(buildZoomAuthorizeUrl(state));
  } catch (err) {
    // Browser navigation, not fetch: every failure becomes a banner on the
    // integrations page rather than a JSON body.
    if (err instanceof ZoomOAuthError && err.code === "not_configured") {
      return dashboardRedirect(request, { error: "Zoom is not configured on this server" });
    }
    const status = (err as Error & { status?: number }).status;
    if (status === 401 || status === 403) {
      return dashboardRedirect(request, {
        error: "You don't have permission to connect Zoom for this business"
      });
    }
    logger.error("zoom connect start failed", { error: (err as Error).message });
    return dashboardRedirect(request, { error: "Could not start the Zoom connection" });
  }
}
