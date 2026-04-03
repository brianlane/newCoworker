import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { requireOwner } from "@/lib/auth";
import { upsertIntegration } from "@/lib/db/integrations";
import { parseGoogleOAuthStateToken } from "@/lib/integrations/google-oauth-state";

const COOKIE_NAME = "nc_google_oauth";

export async function GET(request: NextRequest) {
  const url = request.nextUrl;
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const oauthError = url.searchParams.get("error");

  const fail = (reason: string) =>
    NextResponse.redirect(new URL(`/dashboard/integrations?error=${encodeURIComponent(reason)}`, url.origin));

  if (oauthError) {
    return fail(oauthError);
  }

  if (!code || !state) {
    return fail("missing_code_or_state");
  }

  const cookieStore = await cookies();
  const raw = cookieStore.get(COOKIE_NAME)?.value;
  cookieStore.delete(COOKIE_NAME);

  if (!raw) {
    return fail("oauth_session_expired");
  }

  const payload = parseGoogleOAuthStateToken(raw);
  if (!payload) {
    return fail("invalid_oauth_cookie");
  }

  if (payload.state !== state) {
    return fail("state_mismatch");
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return fail("missing_google_config");
  }

  const redirectUri = `${url.origin}/api/auth/callback/google`;

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code"
    })
  });

  if (!tokenRes.ok) {
    const errText = await tokenRes.text();
    console.error("Google token exchange failed:", tokenRes.status, errText);
    return fail("token_exchange_failed");
  }

  const tokens = (await tokenRes.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
  };

  if (!tokens.access_token) {
    return fail("no_access_token");
  }

  const expiresAt =
    typeof tokens.expires_in === "number"
      ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
      : null;

  const scopes = tokens.scope ? tokens.scope.split(/[\s,]+/).filter(Boolean) : null;

  try {
    await requireOwner(payload.businessId);
  } catch {
    return fail("forbidden");
  }

  try {
    await upsertIntegration({
      businessId: payload.businessId,
      provider: "google",
      authType: "oauth",
      status: "connected",
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? null,
      tokenExpiresAt: expiresAt,
      scopes,
      metadata: { connected_via: "dashboard_oauth" }
    });
  } catch (error) {
    console.error("Google integration storage failed:", error);
    return fail("integration_store_failed");
  }

  return NextResponse.redirect(new URL("/dashboard/integrations?google=connected", url.origin));
}
