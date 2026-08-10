/**
 * Starts the Slack OAuth v2 install flow: authorizes the signed-in owner /
 * manager for the business, gates on the Standard+ tier, then 302s the
 * browser to slack.com/oauth/v2/authorize with an HMAC-signed state binding
 * the round-trip to the business.
 *
 * Browser-navigated (not fetch), so failures land back on the integrations
 * page as a ?error= banner instead of a JSON body (Zoom connect precedent).
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import {
  buildSlackAuthorizeUrl,
  createSlackOAuthState,
  SlackOAuthError
} from "@/lib/slack/oauth";
import { slackAllowedForBusiness, SLACK_UPGRADE_MESSAGE } from "@/lib/slack/tier-gate";
import { logger } from "@/lib/logger";

const businessIdSchema = z.string().uuid();

function dashboardRedirect(request: Request, params: Record<string, string>) {
  const url = new URL("/dashboard/integrations/slack", request.url);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return NextResponse.redirect(url);
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const parsed = businessIdSchema.safeParse(url.searchParams.get("businessId"));
    if (!parsed.success) {
      return dashboardRedirect(request, { error: "A business is required to connect Slack" });
    }

    const user = await getAuthUser();
    if (!user?.email) {
      return NextResponse.redirect(
        new URL("/login?redirectTo=/dashboard/integrations/slack", request.url)
      );
    }
    if (!user.isAdmin) {
      await requireBusinessRole(parsed.data, "manage_settings");
    }

    if (!(await slackAllowedForBusiness(parsed.data))) {
      return dashboardRedirect(request, { error: SLACK_UPGRADE_MESSAGE });
    }

    const state = createSlackOAuthState(parsed.data);
    return NextResponse.redirect(buildSlackAuthorizeUrl(state));
  } catch (err) {
    // Browser navigation, not fetch: every failure becomes a banner on the
    // integrations page rather than a JSON body.
    if (err instanceof SlackOAuthError && err.code === "not_configured") {
      return dashboardRedirect(request, { error: "Slack is not configured on this server" });
    }
    const status = (err as Error & { status?: number }).status;
    if (status === 401 || status === 403) {
      return dashboardRedirect(request, {
        error: "You don't have permission to connect Slack for this business"
      });
    }
    logger.error("slack connect start failed", { error: (err as Error).message });
    return dashboardRedirect(request, { error: "Could not start the Slack connection" });
  }
}
