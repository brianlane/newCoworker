/**
 * Starts the first-party Cal.com OAuth flow. Browser-navigated, so failures
 * land back on the integrations page as a banner.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { buildCalAuthorizeUrl, CalOAuthError, createCalOAuthState } from "@/lib/cal/oauth";
import { logger } from "@/lib/logger";

const businessIdSchema = z.string().uuid();

function dashboardRedirect(request: Request, params: Record<string, string>) {
  const url = new URL("/dashboard/integrations/cal", request.url);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return NextResponse.redirect(url);
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const parsed = businessIdSchema.safeParse(url.searchParams.get("businessId"));
    if (!parsed.success) {
      return dashboardRedirect(request, { error: "A business is required to connect Cal.com" });
    }
    const user = await getAuthUser();
    if (!user?.email) {
      return NextResponse.redirect(new URL("/login?redirectTo=/dashboard/integrations/cal", request.url));
    }
    if (!user.isAdmin) {
      await requireBusinessRole(parsed.data, "manage_settings");
    }
    const state = createCalOAuthState(parsed.data);
    return NextResponse.redirect(buildCalAuthorizeUrl(state));
  } catch (err) {
    if (err instanceof CalOAuthError && err.code === "not_configured") {
      return dashboardRedirect(request, { error: "Cal.com is not configured on this server" });
    }
    const status = (err as Error & { status?: number }).status;
    if (status === 401 || status === 403) {
      return dashboardRedirect(request, {
        error: "You don't have permission to connect Cal.com for this business"
      });
    }
    logger.error("cal connect start failed", { error: (err as Error).message });
    return dashboardRedirect(request, { error: "Could not start the Cal.com connection" });
  }
}
