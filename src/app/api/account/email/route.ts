/**
 * Owner-facing: change the signed-in account's login email.
 *
 * Businesses are keyed by `owner_email` and there is no stable owner_user_id,
 * so we must NOT flip owner_email until the new email is actually confirmed —
 * otherwise the owner is locked out the instant they request a change. Instead:
 *
 *   1. Call supabase.auth.updateUser({ email }) AS the user (cookie session) so
 *      Supabase sends its confirmation email(s). The auth email is unchanged
 *      until the user clicks the link.
 *   2. Record a pending_email_changes row so /api/auth/callback can sync
 *      businesses.owner_email once the confirmed session's email == new_email.
 *
 * The pending row is written only AFTER updateUser succeeds, so a rejected
 * request (e.g. email already in use) never leaves a dangling sync record.
 */
import { z } from "zod";
import { getAuthUser } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { createSupabaseServerClient, createSupabaseServiceClient } from "@/lib/supabase/server";

const schema = z.object({
  email: z.string().trim().toLowerCase().email("Enter a valid email")
});

export async function POST(request: Request) {
  try {
    const user = await getAuthUser();
    if (!user?.email) return errorResponse("UNAUTHORIZED", "Authentication required");

    const { email: newEmail } = schema.parse(await request.json());
    if (newEmail === user.email.toLowerCase()) {
      return errorResponse("VALIDATION_ERROR", "That is already your account email");
    }

    const service = await createSupabaseServiceClient();
    const { data: biz } = await service
      .from("businesses")
      .select("id")
      .eq("owner_email", user.email)
      .limit(1)
      .maybeSingle();
    if (!biz) return errorResponse("NOT_FOUND", "No business found for this account");

    // Record the pending change BEFORE asking Supabase to send the confirmation
    // email. Ordering matters for lockout-safety: if the confirmation went out
    // first and this insert then failed, the user could confirm with no row for
    // the callback to sync, stranding owner_email on the old address. A pending
    // row written when updateUser later fails is harmless — the callback only
    // acts once the auth email actually equals new_email (which never happens
    // for a rejected change), and the next attempt upserts over it.
    const { error: pendErr } = await service.from("pending_email_changes").upsert({
      user_id: user.userId,
      business_id: (biz as { id: string }).id,
      old_email: user.email,
      new_email: newEmail
    });
    if (pendErr) {
      return errorResponse("DB_ERROR", "Could not record the email change");
    }

    // Supabase is the source of truth for email uniqueness — updateUser rejects
    // a taken address. Performed via the cookie-session client so it runs as the
    // user and triggers the confirmation email; the auth email stays put until
    // the link is clicked.
    const ssr = await createSupabaseServerClient();
    const origin = new URL(request.url).origin;
    const { error: updErr } = await ssr.auth.updateUser(
      { email: newEmail },
      { emailRedirectTo: `${origin}/api/auth/callback?redirectTo=/dashboard/settings` }
    );
    if (updErr) {
      // Clear the row we just wrote so a rejected change leaves no stale record.
      await service.from("pending_email_changes").delete().eq("user_id", user.userId);
      return errorResponse("CONFLICT", updErr.message || "Could not start the email change");
    }

    return successResponse({ pending: newEmail });
  } catch (err) {
    return handleRouteError(err);
  }
}
