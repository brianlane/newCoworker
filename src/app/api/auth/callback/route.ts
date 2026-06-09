import { createSupabaseServerClient } from "@/lib/supabase/server";
import { NextResponse, type NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { reconcilePendingEmailChange } from "@/lib/account/email-change";

/**
 * Fast path for syncing `businesses.owner_email` after a self-serve email
 * change is confirmed in the same browser (PKCE code exchange succeeds here).
 * The dashboard layout runs the same reconciler on every authenticated render,
 * so cross-device confirmations and password sign-ins are still covered.
 * Best-effort: a failure here must not break the redirect/login.
 */
async function syncPendingEmailChange(ssr: SupabaseClient): Promise<void> {
  try {
    const {
      data: { user }
    } = await ssr.auth.getUser();
    await reconcilePendingEmailChange(user?.id, user?.email);
  } catch (e) {
    console.error("syncPendingEmailChange", e);
  }
}

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
    await syncPendingEmailChange(supabase);
  }

  const target = getSafeRedirectTarget(request, redirectTo);
  return NextResponse.redirect(target);
}
