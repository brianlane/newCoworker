/**
 * Operator action: send an impersonated tenant a password-reset email.
 *
 * The support case this exists for: a customer is locked out, the operator is
 * already in view-as on their tenant, and the fix is for the customer to set a
 * new password themselves.
 *
 * Deliberately a RESET, not a set. There is an admin API that would write a
 * password directly (`auth.admin.updateUserById({ password })`), and it is not
 * used here: it would leave the operator holding a live customer credential,
 * which they would then have to transmit somehow. Sending Supabase's recovery
 * email keeps the secret between the tenant and their own inbox, and the
 * operator learns nothing. It also composes with `/api/account/email`: if the
 * tenant has lost the mailbox too, the operator changes the address first and
 * then sends the reset.
 *
 * View-as ONLY. A signed-in owner changing their own password uses the card on
 * /dashboard/settings/account, and a signed-out one uses "Forgot password" on
 * /login. Neither needs this route, so it stays a narrow operator surface
 * rather than a second self-serve path.
 *
 * The email is sent through the ANON client on purpose: `resetPasswordForEmail`
 * is the same public endpoint /login's forgot-password uses, so the tenant gets
 * the identical template and the identical `/reset-password` landing. The
 * service client cannot send it.
 *
 * Audited (`logAdminAction`), because this is an operator touching a customer's
 * credentials and the view-as cookie alone does not say which tenant was acted
 * on or when.
 */
import { createClient } from "@supabase/supabase-js";
import { getAuthUser } from "@/lib/auth";
import { resolveViewAsTargetUser } from "@/lib/admin/view-as";
import { resolveActiveBusinessId } from "@/lib/dashboard/active-business";
import { logAdminAction } from "@/lib/admin/audit";
import { readSupabaseEnv } from "@/lib/supabase/env";
import { rateLimitDurable } from "@/lib/rate-limit";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";

/**
 * Per-TARGET, not per-caller: the thing worth protecting is a customer's inbox
 * from a mis-clicking operator, and there is only ever one admin. Generous
 * enough that a legitimate "it did not arrive, send it again" retry never hits
 * it.
 */
const RESET_RATE = { interval: 15 * 60 * 1000, maxRequests: 5 };

export async function POST(request: Request) {
  try {
    const user = await getAuthUser();
    if (!user?.email) return errorResponse("UNAUTHORIZED", "Authentication required");

    const target = await resolveViewAsTargetUser(user);
    if (!target.impersonating) {
      return errorResponse(
        "FORBIDDEN",
        "This action is for sending a tenant their reset while viewing as them. To change your own password, use the password card.",
        403
      );
    }
    if (!target.userId || !target.email) {
      return errorResponse(
        "NOT_FOUND",
        "This tenant's owner has no login yet, so there is no password to reset",
        404
      );
    }

    const limiter = await rateLimitDurable(
      `account-password-reset:${target.email.toLowerCase()}`,
      RESET_RATE
    );
    if (!limiter.success) {
      return errorResponse(
        "CONFLICT",
        "A reset was just sent to this tenant. Wait a few minutes before sending another.",
        429
      );
    }

    // Anon client, no session persistence: this is the public recovery
    // endpoint, and we must not attach it to the operator's own session.
    const env = readSupabaseEnv();
    const anon = createClient(env.url, env.anonKey, {
      auth: { persistSession: false, autoRefreshToken: false }
    });
    const origin = new URL(request.url).origin;
    const { error } = await anon.auth.resetPasswordForEmail(target.email, {
      // Same landing as /login's forgot-password: the callback exchanges the
      // recovery code and drops the tenant on /reset-password.
      redirectTo: `${origin}/api/auth/callback?redirectTo=${encodeURIComponent("/reset-password")}`
    });
    if (error) {
      return errorResponse("CONFLICT", error.message || "Could not send the reset email");
    }

    // Best-effort: the email is already out, so an audit hiccup must not turn
    // a completed action into an error the operator retries.
    const businessId = await resolveActiveBusinessId(user).catch(() => null);
    void logAdminAction({
      adminEmail: user.email,
      action: "tenant_password_reset_sent",
      businessId,
      detail: { ownerEmail: target.email }
    });

    return successResponse({ sentTo: target.email });
  } catch (err) {
    return handleRouteError(err);
  }
}
