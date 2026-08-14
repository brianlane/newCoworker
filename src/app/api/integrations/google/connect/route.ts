/**
 * Starts the first-party Google OAuth flow: authorizes the signed-in owner or
 * manager for the business, checks the tier cap BEFORE sending anyone through
 * consent, then 302s the browser to Google with an HMAC-signed state binding
 * the round-trip to the business.
 *
 * Browser-navigated (not fetch), so failures land back on the workspace
 * integration page as a ?error= banner instead of a JSON body.
 *
 * Mirrors /api/integrations/microsoft/connect. The one Google-specific
 * difference is that there is no `reconnect=1` parameter: the authorize URL
 * always sends `prompt=consent`, because that is what makes Google return a
 * refresh token at all, so every Google authorize is already a forced consent.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { listWorkspaceOAuthConnections } from "@/lib/db/workspace-oauth-connections";
import {
  resolveWorkspaceConnectionCapState,
  workspaceConnectionCapMessage,
  WorkspaceConnectionCapError
} from "@/lib/nango/connection-cap";
import {
  buildGoogleAuthorizeUrl,
  createGoogleOAuthState,
  GoogleOAuthError
} from "@/lib/google/oauth";
import { GOOGLE_KEYS } from "@/lib/workspace/reconnect";
import { logger } from "@/lib/logger";

const businessIdSchema = z.string().uuid();

function dashboardRedirect(request: Request, params: Record<string, string>) {
  const url = new URL("/dashboard/integrations/google", request.url);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return NextResponse.redirect(url);
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  try {
    const parsed = businessIdSchema.safeParse(url.searchParams.get("businessId"));
    if (!parsed.success) {
      return dashboardRedirect(request, {
        error: "A business is required to connect Google"
      });
    }

    const user = await getAuthUser();
    if (!user?.email) {
      const resume = `/api/integrations/google/connect?businessId=${encodeURIComponent(parsed.data)}`;
      return NextResponse.redirect(
        new URL(`/login?redirectTo=${encodeURIComponent(resume)}`, request.url)
      );
    }
    if (!user.isAdmin) {
      await requireBusinessRole(parsed.data, "manage_settings");
    }

    // Check the cap BEFORE consent, but only where the answer is unambiguous.
    //
    // Walking an owner through Google's consent screen only to refuse the result
    // is the worst ordering: they granted access we then threw away. So refuse
    // early WHEN WE CAN.
    //
    // We cannot always. A reconnect consumes no seat (the callback updates the
    // existing row in place), and which account they will pick is unknowable
    // until after consent. Refusing every at-cap owner would block the case this
    // migration depends on most: a Starter tenant whose cap is 1, already
    // holding one Nango Google row, trying to move it to first-party. They would
    // be permanently stuck on Nango.
    //
    // So: refuse early only when the business has NO Google row at all, where
    // the request can only be a new connection. Otherwise let the flow run and
    // let the callback settle it against the real account identity.
    const capState = await resolveWorkspaceConnectionCapState(parsed.data);
    if (capState.atCap) {
      const rows = await listWorkspaceOAuthConnections(parsed.data);
      const couldBeReconnect = rows.some((r) =>
        (GOOGLE_KEYS as readonly string[]).includes(r.provider_config_key)
      );
      if (!couldBeReconnect) {
        return dashboardRedirect(request, {
          error: workspaceConnectionCapMessage(capState)
        });
      }
    }

    return NextResponse.redirect(buildGoogleAuthorizeUrl(createGoogleOAuthState(parsed.data)));
  } catch (err) {
    if (err instanceof WorkspaceConnectionCapError) {
      return dashboardRedirect(request, { error: err.message });
    }
    if (err instanceof GoogleOAuthError && err.code === "not_configured") {
      return dashboardRedirect(request, {
        error: "Google is not configured on this server"
      });
    }
    const status = (err as Error & { status?: number }).status;
    if (status === 401 || status === 403) {
      return dashboardRedirect(request, {
        error: "You don't have permission to connect Google for this business"
      });
    }
    logger.error("google connect start failed", { error: (err as Error).message });
    return dashboardRedirect(request, { error: "Could not start the Google connection" });
  }
}
