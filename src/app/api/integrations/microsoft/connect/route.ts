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
import {
  assertWorkspaceConnectionAllowed,
  WorkspaceConnectionCapError
} from "@/lib/nango/connection-cap";
import {
  buildMicrosoftAuthorizeUrl,
  createMicrosoftOAuthState,
  MicrosoftOAuthError
} from "@/lib/microsoft/oauth";
import { logger } from "@/lib/logger";

const businessIdSchema = z.string().uuid();

function dashboardRedirect(request: Request, params: Record<string, string>) {
  const url = new URL("/dashboard/integrations/workspace", request.url);
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

    // Check the cap BEFORE consent. Walking an owner through the Microsoft
    // consent screen only to refuse the result at the callback is the worst
    // possible ordering: they granted access we then threw away.
    //
    // A RECONNECT of a mailbox they already have does not consume a seat, but
    // we cannot know which account they will pick until after consent. So this
    // gate is deliberately the "adding one" question, and the callback settles
    // the truth once /me says who it is: a reconnect updates in place and never
    // re-checks.
    await assertWorkspaceConnectionAllowed(parsed.data);

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
