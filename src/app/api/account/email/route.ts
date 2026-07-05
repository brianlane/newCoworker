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
import { isViewAsActive } from "@/lib/admin/view-as";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { createSupabaseServerClient, createSupabaseServiceClient } from "@/lib/supabase/server";

const schema = z.object({
  email: z.string().trim().toLowerCase().email("Enter a valid email")
});

export async function POST(request: Request) {
  try {
    const user = await getAuthUser();
    // View-as is read-only: this route resolves the business from the
    // SIGNED-IN user's email, so an impersonating admin's write would land
    // on the wrong business. Refuse instead (see isViewAsActive).
    if (await isViewAsActive(user)) {
      return errorResponse("FORBIDDEN", "View-as is read-only — exit view-as to make changes", 403);
    }
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
    // the reconciler to sync, stranding owner_email on the old address. A pending
    // row written when updateUser later fails is harmless — the reconciler only
    // acts once the auth email actually moves off old_email (which never happens
    // for a rejected change), and the next attempt upserts over it.
    const { error: pendErr } = await service.from("pending_email_changes").upsert({
      user_id: user.userId,
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
      // Deliberately DO NOT delete the pending row here. Supabase can return an
      // error to us yet still have accepted the change and sent the confirmation
      // email; deleting would then strand the confirmed email with no row for the
      // reconciler to sync. A pending row for a genuinely-rejected change is
      // harmless — the reconciler only acts once the live auth email equals
      // new_email (which never happens for a rejected change), and the next
      // attempt upserts over it.
      return errorResponse("CONFLICT", updErr.message || "Could not start the email change");
    }

    return successResponse({ pending: newEmail });
  } catch (err) {
    return handleRouteError(err);
  }
}
