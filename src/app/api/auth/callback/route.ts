import { createSupabaseServerClient, createSupabaseServiceClient } from "@/lib/supabase/server";
import { NextResponse, type NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Sync `businesses.owner_email` after a self-serve email change is confirmed.
 *
 * `/api/account/email` records a pending_email_changes row and asks Supabase to
 * email a confirmation link. That link lands here; once the code is exchanged
 * the session's email is the NEW address. We then point the owner's business at
 * the new email and clear the pending row. Guard on `session.email === new_email`
 * so we only ever move owner_email once the auth email has genuinely flipped —
 * a magic-link / recovery callback (no pending row, or email not yet confirmed)
 * is a no-op. Best-effort: failures here must not break the redirect/login.
 */
async function syncPendingEmailChange(ssr: SupabaseClient): Promise<void> {
  try {
    const {
      data: { user }
    } = await ssr.auth.getUser();
    if (!user?.email) return;

    const service = await createSupabaseServiceClient();
    const { data: pendingRow } = await service
      .from("pending_email_changes")
      .select("user_id, business_id, new_email")
      .eq("user_id", user.id)
      .maybeSingle();
    const pending = pendingRow as
      | { user_id: string; business_id: string; new_email: string }
      | null;
    if (!pending) return;

    // Only sync once the auth email actually equals the requested new email.
    if (user.email.toLowerCase() !== pending.new_email.toLowerCase()) return;

    // Store the authoritative Supabase email (exact case) so requireOwner's
    // `owner_email = auth.email()` comparison continues to match.
    const { error: updateError } = await service
      .from("businesses")
      .update({ owner_email: user.email })
      .eq("id", pending.business_id);
    // Only retire the pending row once owner_email is actually updated. If the
    // update failed, KEEP the row: the auth email is already new while
    // owner_email is stale (a lockout), so a later callback must be able to
    // retry the sync rather than losing the record forever.
    if (updateError) {
      console.error("syncPendingEmailChange owner_email update failed", updateError);
      return;
    }
    await service.from("pending_email_changes").delete().eq("user_id", pending.user_id);
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
