/**
 * Starts the first-party Microsoft OAuth flow: authorizes the signed-in owner
 * or manager for the business, checks the tier cap BEFORE sending anyone
 * through consent, then 302s the browser to login.microsoftonline.com with an
 * HMAC-signed state binding the round-trip to the business.
 *
 * Browser-navigated (not fetch), so failures land back on the workspace
 * integration page as a ?error= banner instead of a JSON body.
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
  buildMicrosoftAuthorizeUrl,
  createMicrosoftOAuthState,
  MicrosoftOAuthError
} from "@/lib/microsoft/oauth";
import { logger } from "@/lib/logger";

const businessIdSchema = z.string().uuid();

/** The provider key an Outlook mailbox uses, on BOTH transports. */
const OUTLOOK_KEY = "outlook";

function dashboardRedirect(request: Request, params: Record<string, string>) {
  const url = new URL("/dashboard/integrations/microsoft", request.url);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return NextResponse.redirect(url);
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  try {
    const parsed = businessIdSchema.safeParse(url.searchParams.get("businessId"));
    if (!parsed.success) {
      return dashboardRedirect(request, {
        error: "A business is required to connect Outlook"
      });
    }

    const user = await getAuthUser();
    if (!user?.email) {
      const resume = `/api/integrations/microsoft/connect?businessId=${encodeURIComponent(parsed.data)}`;
      return NextResponse.redirect(
        new URL(`/login?redirectTo=${encodeURIComponent(resume)}`, request.url)
      );
    }
    if (!user.isAdmin) {
      await requireBusinessRole(parsed.data, "manage_settings");
    }

    // Check the cap BEFORE consent, but only where the answer is unambiguous.
    //
    // Walking an owner through the Microsoft consent screen only to refuse the
    // result is the worst ordering: they granted access we then threw away. So
    // refuse early WHEN WE CAN.
    //
    // We cannot always. A reconnect consumes no seat (the callback updates the
    // existing row in place), and which account they will pick is unknowable
    // until after consent. Refusing every at-cap owner would block the single
    // most important case this whole migration depends on: a Starter tenant
    // whose cap is 1, already holding one Nango Outlook row, trying to move it
    // to first-party. They would be permanently stuck on Nango.
    //
    // So: refuse early only when the business has NO Outlook row at all, where
    // the request can only be a new connection. Otherwise let the flow run and
    // let the callback settle it against the real account identity.
    const capState = await resolveWorkspaceConnectionCapState(parsed.data);
    if (capState.atCap) {
      const rows = await listWorkspaceOAuthConnections(parsed.data);
      const couldBeReconnect = rows.some((r) => r.provider_config_key === OUTLOOK_KEY);
      if (!couldBeReconnect) {
        return dashboardRedirect(request, {
          error: workspaceConnectionCapMessage(capState)
        });
      }
    }

    const state = createMicrosoftOAuthState(parsed.data);
    // `reconnect=1` forces the consent prompt, which re-issues a refresh token
    // even when Microsoft already has a live grant for this account.
    const forceConsent = url.searchParams.get("reconnect") === "1";
    return NextResponse.redirect(buildMicrosoftAuthorizeUrl(state, { forceConsent }));
  } catch (err) {
    if (err instanceof WorkspaceConnectionCapError) {
      return dashboardRedirect(request, { error: err.message });
    }
    if (err instanceof MicrosoftOAuthError && err.code === "not_configured") {
      return dashboardRedirect(request, {
        error: "Outlook is not configured on this server"
      });
    }
    const status = (err as Error & { status?: number }).status;
    if (status === 401 || status === 403) {
      return dashboardRedirect(request, {
        error: "You don't have permission to connect Outlook for this business"
      });
    }
    logger.error("microsoft connect start failed", { error: (err as Error).message });
    return dashboardRedirect(request, { error: "Could not start the Outlook connection" });
  }
}
