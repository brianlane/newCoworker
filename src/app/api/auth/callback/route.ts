import { createSupabaseServerClient } from "@/lib/supabase/server";
import { NextResponse, type NextRequest } from "next/server";

function getSafeRedirectTarget(request: NextRequest, redirectTo: string): URL {
  const fallback = new URL("/dashboard", request.nextUrl.origin);

  // Only allow app-relative redirects and reject protocol-relative values.
  if (!redirectTo.startsWith("/") || redirectTo.startsWith("//")) {
    return fallback;
  }

  try {
    const candidate = new URL(redirectTo, request.nextUrl.origin);
    if (candidate.origin !== request.nextUrl.origin) {
      return fallback;
    }
    return candidate;
  } catch {
    return fallback;
  }
}

export async function GET(request: NextRequest) {
  const url = request.nextUrl;
  const code = url.searchParams.get("code");
  const redirectTo = url.searchParams.get("redirectTo") ?? "/dashboard";

  if (code) {
    const supabase = await createSupabaseServerClient();
    await supabase.auth.exchangeCodeForSession(code);
  }

  const target = getSafeRedirectTarget(request, redirectTo);
  return NextResponse.redirect(target);
}
