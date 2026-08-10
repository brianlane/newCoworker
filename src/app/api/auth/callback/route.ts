import { createSupabaseServerClient, createSupabaseServiceClient } from "@/lib/supabase/server";
import { NextResponse, type NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { reconcilePendingEmailChange } from "@/lib/account/email-change";
import { safeInternalPath } from "@/lib/auth/safe-redirect";
import {
  evaluateSignIn,
  NO_ACCOUNT_ERROR,
  type AccountLookupClient
} from "@/lib/auth/account-gate";
import { logger } from "@/lib/logger";

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

/**
 * Refuse a sign-in that Google (or any future OAuth provider) just invented an
 * account for. See `src/lib/auth/account-gate.ts` for why this lives here:
 * Supabase mints the `auth.users` row during the code exchange above, so the
 * earliest we can see the address is after the session exists. Returns the
 * path to redirect to when the sign-in is refused, or null to let it through.
 *
 * Fail-open on every unexpected error: this is the login path, and locking a
 * paying owner out is worse than letting one empty account through.
 */
async function rejectAccountlessOAuthSignIn(ssr: SupabaseClient): Promise<string | null> {
  try {
    const {
      data: { user }
    } = await ssr.auth.getUser();
    if (!user) return null;

    const db = await createSupabaseServiceClient();
    const decision = await evaluateSignIn(user, db as unknown as AccountLookupClient);
    if (decision.allowed) return null;

    logger.warn("auth callback: refused OAuth sign-in with no New Coworker account", {
      userId: user.id,
      email: user.email,
      deleted: decision.deleteUserId !== null
    });

    // Best-effort, and deliberately not allowed to abort the rejection: the
    // route handler's cookie writes ride out on the redirect response, and if
    // the revoke call itself fails we still refuse and (when it is ours to
    // remove) delete the row, which invalidates the session anyway.
    try {
      await ssr.auth.signOut();
    } catch (e) {
      logger.error("auth callback: signOut failed while refusing sign-in", {
        userId: user.id,
        error: e instanceof Error ? e.message : String(e)
      });
    }

    if (decision.deleteUserId) {
      const { error } = await db.auth.admin.deleteUser(decision.deleteUserId);
      if (error) {
        logger.error("auth callback: could not delete the just-minted orphan account", {
          userId: decision.deleteUserId,
          error: error.message
        });
      }
    }

    return `/login?error=${NO_ACCOUNT_ERROR}`;
  } catch (e) {
    logger.error("auth callback: account gate failed, allowing sign-in", {
      error: e instanceof Error ? e.message : String(e)
    });
    return null;
  }
}

export async function GET(request: NextRequest) {
  const url = request.nextUrl;
  const code = url.searchParams.get("code");
  const redirectTo = url.searchParams.get("redirectTo") ?? "/dashboard";

  if (code) {
    const supabase = await createSupabaseServerClient();
    await supabase.auth.exchangeCodeForSession(code);
    const refusal = await rejectAccountlessOAuthSignIn(supabase);
    if (refusal) return NextResponse.redirect(new URL(refusal, url.origin));
    await syncPendingEmailChange(supabase);
  }

  const target = new URL(safeInternalPath(redirectTo, "/dashboard"), url.origin);
  return NextResponse.redirect(target);
}
