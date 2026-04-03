import { NextRequest, NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth";
import { cookies } from "next/headers";
import { randomBytes } from "crypto";
import { createGoogleOAuthStateToken } from "@/lib/integrations/google-oauth-state";
import { z } from "zod";

const COOKIE_NAME = "nc_google_oauth";
const COOKIE_MAX_AGE = 600;

const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/drive.readonly"
].join(" ");

export async function GET(request: NextRequest) {
  const businessId = request.nextUrl.searchParams.get("businessId");
  const parsed = z.string().uuid().safeParse(businessId);
  if (!parsed.success) {
    return NextResponse.redirect(
      new URL("/dashboard/integrations?error=invalid_business", request.nextUrl.origin)
    );
  }

  try {
    await requireOwner(parsed.data);
  } catch {
    return NextResponse.redirect(
      new URL("/dashboard/integrations?error=forbidden", request.nextUrl.origin)
    );
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    return NextResponse.redirect(
      new URL("/dashboard/integrations?error=missing_google_config", request.nextUrl.origin)
    );
  }

  const origin = request.nextUrl.origin;
  const redirectUri = `${origin}/api/auth/callback/google`;
  const state = randomBytes(24).toString("hex");

  const cookieStore = await cookies();
  cookieStore.set(
    COOKIE_NAME,
    createGoogleOAuthStateToken({ businessId: parsed.data, state }),
    {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: COOKIE_MAX_AGE,
      path: "/"
    }
  );

  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", GOOGLE_SCOPES);
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "consent");
  authUrl.searchParams.set("state", state);

  return NextResponse.redirect(authUrl.toString());
}
