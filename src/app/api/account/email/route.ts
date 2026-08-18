/**
 * Owner-facing: change an account's login email.
 *
 * Businesses are keyed by `owner_email` and there is no stable owner_user_id,
 * so we must NOT flip owner_email until the new email is actually confirmed,
 * otherwise the owner is locked out the instant they request a change. For the
 * owner changing their OWN email:
 *
 *   1. Call supabase.auth.updateUser({ email }) AS the user (cookie session) so
 *      Supabase sends its confirmation email(s). The auth email is unchanged
 *      until the user clicks the link.
 *   2. Record a pending_email_changes row so /api/auth/callback can sync
 *      businesses.owner_email once the confirmed session's email == new_email.
 *
 * The pending row is written only AFTER updateUser succeeds, so a rejected
 * request (e.g. email already in use) never leaves a dangling sync record.
 *
 * ## Admin view-as
 *
 * This is a USER-scoped route, so an admin impersonating a tenant is
 * retargeted at the tenant's OWNER auth user (`resolveViewAsTargetUser`) and
 * takes a different path: the admin cannot click a confirmation link sent to
 * the tenant's mailbox, so the change is applied IMMEDIATELY through
 * `auth.admin.updateUserById` and `businesses.owner_email` moves in the same
 * request (`moveBusinessesToNewOwnerEmail`). No pending row is involved:
 * there is nothing to reconcile later. The tenant's next sign-in uses the new
 * address, which is the point of the operator performing the change for them.
 */
import { z } from "zod";
import { getAuthUser } from "@/lib/auth";
import { resolveViewAsTargetUser } from "@/lib/admin/view-as";
import { moveBusinessesToNewOwnerEmail } from "@/lib/account/email-change";
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

    // Whose login is being changed: the caller's, or (under view-as) the
    // impersonated tenant owner's. A tenant with no auth user behind its
    // owner_email has no login to rename, so refuse rather than fall back to
    // renaming the admin's own account.
    const target = await resolveViewAsTargetUser(user);
    if (!target.userId || !target.email) {
      return errorResponse(
        "NOT_FOUND",
        "This tenant's owner has no login yet, so there is no account email to change",
        404
      );
    }
    if (newEmail === target.email.toLowerCase()) {
      return errorResponse(
        "VALIDATION_ERROR",
        target.impersonating
          ? "That is already this account's email"
          : "That is already your account email"
      );
    }

    const service = await createSupabaseServiceClient();

    // Admin acting for the tenant: apply it now, in one request. The auth
    // email moves first (Supabase still enforces uniqueness and rejects a
    // taken address), then the businesses follow it. Ordering matters the
    // same way as below: a business moved onto an email no login holds
    // would strand the tenant.
    if (target.impersonating) {
      const { error: updErr } = await service.auth.admin.updateUserById(target.userId, {
        email: newEmail,
        // The operator vouches for the address; there is no link for the
        // tenant to click and leaving it unconfirmed would keep the
        // dashboard's verify-your-email banner up on a correct address.
        email_confirm: true
      });
      if (updErr) {
        return errorResponse("CONFLICT", updErr.message || "Could not change the account email");
      }
      const moved = await moveBusinessesToNewOwnerEmail(target.email, newEmail, service);
      return successResponse({ changed: newEmail, businessesMoved: moved });
    }

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
    // row written when updateUser later fails is harmless, the reconciler only
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

    // Supabase is the source of truth for email uniqueness, updateUser rejects
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
      // harmless, the reconciler only acts once the live auth email equals
      // new_email (which never happens for a rejected change), and the next
      // attempt upserts over it.
      return errorResponse("CONFLICT", updErr.message || "Could not start the email change");
    }

    return successResponse({ pending: newEmail });
  } catch (err) {
    return handleRouteError(err);
  }
}
