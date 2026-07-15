/**
 * GET /api/integrations/meta/connect?businessId=… — start the Facebook
 * Login dance for the direct Meta Lead Ads connection.
 *
 * Auth mirrors the other integration routes (owner/manager session with
 * `manage_settings`; admins bypass), then 302s to the Facebook Login
 * dialog with an HMAC-signed `state` that binds the callback to this
 * business. The registered redirect URI is /api/integrations/meta/callback
 * on the app's public origin.
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { errorResponse, handleRouteError } from "@/lib/api-response";
import {
  buildMetaLoginUrl,
  createMetaOAuthState,
  metaCallbackUrl
} from "@/lib/meta/client";

export const dynamic = "force-dynamic";

const businessIdSchema = z.string().uuid();

export async function GET(request: NextRequest) {
  try {
    const parsed = businessIdSchema.safeParse(
      request.nextUrl.searchParams.get("businessId")
    );
    if (!parsed.success) {
      return errorResponse("VALIDATION_ERROR", "businessId is required");
    }
    const user = await getAuthUser();
    if (!user?.email) return errorResponse("UNAUTHORIZED", "Authentication required");
    if (!user.isAdmin) {
      await requireBusinessRole(parsed.data, "manage_settings");
    }

    const loginUrl = buildMetaLoginUrl({
      redirectUri: metaCallbackUrl(request.nextUrl.origin),
      state: createMetaOAuthState(parsed.data)
    });
    return NextResponse.redirect(loginUrl);
  } catch (err) {
    return handleRouteError(err);
  }
}
